#!/usr/bin/env node
/**
 * eToro snapshot for "Market Moves".
 *
 * Runs in GitHub Actions (always on, independent of any laptop), calls the
 * eToro public API, and writes data/latest.json which the daily Cowork task
 * reads via raw.githubusercontent.com.
 *
 * Required env (GitHub Actions secrets):
 *   ETORO_API_KEY   -> x-api-key
 *   ETORO_USER_KEY  -> x-user-key
 * Optional env:
 *   ETORO_USERNAME  (default "MrMagoon")
 *   ETORO_USER_ID   (numeric CID; resolved automatically if omitted)
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
  const url = path.startsWith("http") ? path : BASE + path;
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
    diagnostics[path] = res.status;
    console.log(`${res.status}  ${path}`);
    return { status: res.status, json, text };
  } catch (err) {
    diagnostics[path] = `ERR ${err.message}`;
    console.log(`ERR   ${path}  ${err.message}`);
    return { status: 0, json: null, text: "" };
  }
}

/** Walk any JSON shape and collect the first array of objects that look like positions. */
function findPositions(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    const hit = node.filter(
      (x) =>
        x &&
        typeof x === "object" &&
        (x.symbol || x.ticker || x.symbolFull || x.instrumentDisplayName || x.displayName)
    );
    if (hit.length >= 3) return hit;
    for (const child of node) {
      const found = findPositions(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node)) {
      const found = findPositions(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalisePositions(rows) {
  if (!rows) return [];
  return rows
    .map((r) => ({
      ticker: String(
        r.symbol || r.ticker || r.symbolFull || r.instrumentSymbol || ""
      ).toUpperCase(),
      name: r.instrumentDisplayName || r.displayName || r.name || "",
      investedPct:
        r.invested ?? r.investedPct ?? r.investmentPct ?? r.allocation ?? null,
    }))
    .filter((r) => r.ticker)
    .sort((a, b) => (b.investedPct ?? 0) - (a.investedPct ?? 0));
}

/** The legacy /user-info/people/{user}/gain shape used by the old n8n workflow. */
function ytdFromLegacyGain(json) {
  const year = String(new Date().getUTCFullYear());
  const yearly = json?.yearly || json?.data?.yearly;
  if (!Array.isArray(yearly)) return null;
  const row = yearly.find((v) => String(v.timestamp || "").slice(0, 4) === year);
  return row?.gain ?? null;
}

/** Fallback: sum monthly gains compounded, or read an explicit ytd field. */
function ytdFromAnywhere(json) {
  if (!json || typeof json !== "object") return null;
  for (const key of ["ytd", "yearToDate", "gainYTD", "ytdGain"]) {
    if (typeof json[key] === "number") return json[key];
  }
  return null;
}

async function resolveUserId() {
  if (process.env.ETORO_USER_ID) return process.env.ETORO_USER_ID;
  const search = await get(`/users/search?query=${encodeURIComponent(USERNAME)}`);
  const rows = Array.isArray(search.json)
    ? search.json
    : search.json?.items || search.json?.users || search.json?.data || [];
  const match = rows.find(
    (u) =>
      String(u.username || u.userName || u.displayName || "").toLowerCase() ===
      USERNAME.toLowerCase()
  );
  return match?.userId ?? match?.id ?? match?.cid ?? match?.realCID ?? null;
}

const userId = await resolveUserId();
console.log("userId:", userId ?? "(unresolved)");

// Portfolio: current API first, then the aggregated snapshot as a backstop.
const portfolio = userId ? await get(`/users/${userId}/portfolio`) : { json: null };
const portfolioAlt =
  findPositions(portfolio.json) ? { json: null } : await get(`/trading/portfolio`);

// Performance: the legacy endpoint is the one the old n8n workflow proved works.
const legacyGain = await get(
  `/user-info/people/${encodeURIComponent(USERNAME)}/gain`
);
const gainSeries = userId ? await get(`/users/${userId}/gain/timeseries`) : { json: null };

const positions = normalisePositions(
  findPositions(portfolio.json) || findPositions(portfolioAlt.json)
);

const ytd =
  ytdFromLegacyGain(legacyGain.json) ??
  ytdFromAnywhere(gainSeries.json) ??
  ytdFromAnywhere(legacyGain.json);

const out = {
  generatedAt: new Date().toISOString(),
  username: USERNAME,
  userId: userId ?? null,
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
  ...positions.map((p) => `| ${p.ticker} | ${p.name} | ${p.investedPct ?? ""} |`),
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
    JSON.stringify(
      {
        portfolio: portfolio.json,
        portfolioAlt: portfolioAlt.json,
        legacyGain: legacyGain.json,
        gainSeries: gainSeries.json,
      },
      null,
      2
    ) + "\n"
  );
}

if (ytd === null && positions.length === 0) {
  console.error("Nothing resolved. Check data/latest.md for endpoint status.");
  process.exit(1);
}
console.log(`OK  ytd=${out.ytdFormatted}  positions=${positions.length}`);
