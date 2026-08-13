#!/usr/bin/env node
/**
 * eToro snapshot for "Market Moves".
 *
 * Runs in GitHub Actions (always on, independent of any laptop), calls the
 * eToro public API, and writes data/latest.json which the daily Cowork task
 * reads via raw.githubusercontent.com.
 *
 * Verified working endpoints (2026-08-13):
 *   GET /user-info/people/{username}/gain          -> yearly gains, YTD
 *   GET /user-info/people/{username}/portfolio/live -> positions (instrumentId + investmentPct)
 *   GET /market-data/instruments?instrumentIds=1,2,3 -> instrumentId -> symbolFull
 *
 * Required env (GitHub Actions secrets):
 *   ETORO_API_KEY   -> x-api-key
 *   ETORO_USER_KEY  -> x-user-key
 * Optional env:
 *   ETORO_USERNAME  (default "MrMagoon")
 *   INCLUDE_RAW=1   (also write data/raw.json - keep off on a public repo)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const BASE = "https://public-api.etoro.com/api/v1";
const USERNAME = process.env.ETORO_USERNAME || "MrMagoon";
const API_KEY = process.env.ETORO_API_KEY;
const USER_KEY = process.env.ETORO_USER_KEY;

if (!API_KEY || !USER_KEY) {
  console.error("Missing ETORO_API_KEY or ETORO_USER_KEY");
  process.exit(1);
}

const diagnostics = {};

async function get(path, { diag = true } = {}) {
  const url = BASE + path;
  const key = path.split("?")[0];
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": API_KEY,
        "x-user-key": USER_KEY,
        "x-request-id": randomUUID(),
        Accept: "application/json",
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (diag) diagnostics[key] = res.status;
    console.log(`${res.status}  ${path.slice(0, 110)}`);
    return { status: res.status, json };
  } catch (err) {
    if (diag) diagnostics[key] = `ERR ${err.message}`;
    console.log(`ERR   ${path}  ${err.message}`);
    return { status: 0, json: null };
  }
}

const U = encodeURIComponent(USERNAME);

// ---------------------------------------------------------------- YTD
const gain = await get(`/user-info/people/${U}/gain`);

function ytdFrom(json) {
  const year = String(new Date().getUTCFullYear());
  const yearly = json?.yearly || json?.data?.yearly;
  if (!Array.isArray(yearly)) return null;
  const row = yearly.find((v) => String(v.timestamp || "").slice(0, 4) === year);
  return row?.gain ?? null;
}
const ytd = ytdFrom(gain.json);

// ---------------------------------------------------------------- positions
const live = await get(`/user-info/people/${U}/portfolio/live`);
const rawPositions =
  live.json?.positions || live.json?.data?.positions || [];

// One instrument can hold several open positions. Aggregate the invested share.
const byInstrument = new Map();
for (const p of rawPositions) {
  const raw = p.instrumentId ?? p.instrumentID;
  const id = Number(raw);
  if (raw == null || !Number.isFinite(id)) continue;
  const pct = Number(p.investmentPct ?? p.investedPct ?? 0);
  const prev = byInstrument.get(id) || { instrumentId: id, investedPct: 0, positions: 0 };
  prev.investedPct += Number.isFinite(pct) ? pct : 0;
  prev.positions += 1;
  byInstrument.set(id, prev);
}

// ---------------------------------------------------------------- symbols
//
// GET /market-data/instruments declares instrumentIds as `style: form,
// explode: false` (openapi.json), i.e. ONE parameter holding a comma separated
// list. Repeating the parameter (?instrumentIds=1&instrumentIds=2) makes the
// server keep only the last value - that is why exactly one instrument used to
// resolve. The variants below are tried in order and the first one that returns
// every requested id wins; the winner is recorded in diagnostics so a silent
// change on eToro's side is visible in the next snapshot.
const ids = [...byInstrument.keys()];
const symbols = new Map();

const SERIALIZATIONS = [
  ["comma", (list) => `instrumentIds=${list.join(",")}`],
  ["comma-encoded", (list) => `instrumentIds=${list.join("%2C")}`],
  ["brackets", (list) => list.map((i) => `instrumentIds%5B%5D=${i}`).join("&")],
  ["repeated", (list) => list.map((i) => `instrumentIds=${i}`).join("&")],
];

function harvest(json) {
  const rows =
    json?.instrumentDisplayDatas ||
    json?.data?.instrumentDisplayDatas ||
    (Array.isArray(json) ? json : []);
  const found = new Map();
  for (const r of rows) {
    const id = r.instrumentID ?? r.instrumentId;
    if (id == null) continue;
    const ticker = String(r.symbolFull || r.symbol || "").toUpperCase();
    if (!ticker) continue;
    found.set(Number(id), {
      ticker,
      name: r.instrumentDisplayName || r.displayName || "",
    });
  }
  return found;
}

let variantUsed = null;

if (ids.length) {
  for (const [name, build] of SERIALIZATIONS) {
    const meta = await get(`/market-data/instruments?${build(ids)}`);
    if (meta.status !== 200) continue;
    const found = harvest(meta.json);
    const hits = ids.filter((id) => found.has(id)).length;
    console.log(`      serialization "${name}" resolved ${hits}/${ids.length}`);
    for (const [id, v] of found) if (byInstrument.has(id)) symbols.set(id, v);
    if (hits === ids.length) {
      variantUsed = name;
      break;
    }
  }

  // Per-id fallback. A single id is unambiguous under every serialization, so
  // this works whatever the server does with lists - it just costs one request
  // per instrument (22 today, inside the 120 req / 60 s market-data budget).
  const missing = ids.filter((id) => !symbols.has(id));
  if (missing.length) {
    console.log(`      single lookups for ${missing.length} unresolved ids`);
    for (const id of missing) {
      const one = await get(`/market-data/instruments?instrumentIds=${id}`, {
        diag: false,
      });
      const hit = harvest(one.json).get(id);
      if (hit) symbols.set(id, hit);
      await new Promise((r) => setTimeout(r, 120));
    }
    variantUsed = variantUsed ? `${variantUsed}+single` : "single";
  }
}

const positions = [...byInstrument.values()]
  .map((p) => ({
    ticker: symbols.get(p.instrumentId)?.ticker || `#${p.instrumentId}`,
    name: symbols.get(p.instrumentId)?.name || "",
    investedPct: Math.round(p.investedPct * 100) / 100,
  }))
  .sort((a, b) => b.investedPct - a.investedPct);

// Symbol resolution is the part that broke before, so it reports on itself.
diagnostics.symbolSerialization = variantUsed ?? "none";
diagnostics.symbolsResolved = `${symbols.size}/${ids.length}`;
const unresolved = ids.filter((id) => !symbols.has(id));
if (unresolved.length) diagnostics.unresolvedInstrumentIds = unresolved;

// ---------------------------------------------------------------- output
const out = {
  generatedAt: new Date().toISOString(),
  username: USERNAME,
  ytd,
  ytdFormatted: typeof ytd === "number" ? `${ytd.toFixed(2)}%` : null,
  positionCount: positions.length,
  tickers: positions.map((p) => p.ticker),
  positions,
  diagnostics,
};

await mkdir("data", { recursive: true });
await writeFile("data/latest.json", JSON.stringify(out, null, 2) + "\n");

const md = [
  `# eToro snapshot`,
  ``,
  `Generated: ${out.generatedAt}`,
  `YTD: ${out.ytdFormatted ?? "unresolved"}`,
  `Positions: ${out.positionCount}`,
  ``,
  `| Ticker | Name | Invested % |`,
  `|---|---|---|`,
  ...positions.map((p) => `| ${p.ticker} | ${p.name} | ${p.investedPct} |`),
  ``,
  `## Endpoint status`,
  ``,
  ...Object.entries(diagnostics).map(([k, v]) => `- \`${k}\` -> ${v}`),
  ``,
].join("\n");
await writeFile("data/latest.md", md);

if (process.env.INCLUDE_RAW === "1") {
  await writeFile(
    "data/raw.json",
    JSON.stringify({ gain: gain.json, live: live.json }, null, 2) + "\n"
  );
}

if (ytd === null && positions.length === 0) {
  console.error("Nothing resolved. See data/latest.md for endpoint status.");
  process.exit(1);
}
console.log(`OK  ytd=${out.ytdFormatted}  positions=${positions.length}`);
