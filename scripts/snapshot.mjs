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
 *   GET /market-data/instruments?instrumentIds=... -> instrumentId -> symbolFull
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

async function get(path) {
  const url = BASE + path;
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
    diagnostics[path.split("?")[0]] = res.status;
    console.log(`${res.status}  ${path.slice(0, 90)}`);
    return { status: res.status, json };
  } catch (err) {
    diagnostics[path.split("?")[0]] = `ERR ${err.message}`;
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
  const id = p.instrumentId ?? p.instrumentID;
  if (id == null) continue;
  const pct = Number(p.investmentPct ?? p.investedPct ?? 0);
  const prev = byInstrument.get(id) || { instrumentId: id, investedPct: 0, positions: 0 };
  prev.investedPct += Number.isFinite(pct) ? pct : 0;
  prev.positions += 1;
  byInstrument.set(id, prev);
}

// ---------------------------------------------------------------- symbols
const ids = [...byInstrument.keys()];
const symbols = new Map();

if (ids.length) {
  const qs = ids.map((i) => `instrumentIds=${i}`).join("&");
  let meta = await get(`/market-data/instruments?${qs}`);
  if (meta.status !== 200) meta = await get(`/market/instruments?${qs}`);

  const rows =
    meta.json?.instrumentDisplayDatas ||
    meta.json?.data?.instrumentDisplayDatas ||
    (Array.isArray(meta.json) ? meta.json : []);

  for (const r of rows) {
    const id = r.instrumentID ?? r.instrumentId;
    if (id == null) continue;
    symbols.set(id, {
      ticker: String(r.symbolFull || r.symbol || "").toUpperCase(),
      name: r.instrumentDisplayName || r.displayName || "",
    });
  }

  // Per-id fallback for anything the batch call did not return.
  for (const id of ids) {
    if (symbols.has(id)) continue;
    const one = await get(`/market/instruments/${id}`);
    const r = one.json?.instrumentDisplayDatas?.[0] || one.json || {};
    if (r.symbolFull || r.symbol) {
      symbols.set(id, {
        ticker: String(r.symbolFull || r.symbol).toUpperCase(),
        name: r.instrumentDisplayName || r.displayName || "",
      });
    }
  }
}

const positions = [...byInstrument.values()]
  .map((p) => ({
    ticker: symbols.get(p.instrumentId)?.ticker || `#${p.instrumentId}`,
    name: symbols.get(p.instrumentId)?.name || "",
    investedPct: Math.round(p.investedPct * 100) / 100,
  }))
  .sort((a, b) => b.investedPct - a.investedPct);

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
