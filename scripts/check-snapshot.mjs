#!/usr/bin/env node
/**
 * Guard rail for data/latest.json.
 *
 * The snapshot used to go green while every ticker was still an unresolved
 * "#1005" placeholder, so the failure was only visible by reading the file.
 * This runs AFTER the commit step: fresh data still lands, but the run turns
 * red so the breakage is noticed before the 05:30 post task consumes it.
 *
 * Deliberately generic - no hardcoded holdings, they change whenever Max trades.
 */
import { readFile } from "node:fs/promises";

const snapshot = JSON.parse(await readFile("data/latest.json", "utf8"));
const problems = [];

for (const key of [
  "generatedAt",
  "ytd",
  "ytdFormatted",
  "positionCount",
  "tickers",
  "positions",
  "diagnostics",
]) {
  if (!(key in snapshot)) problems.push(`missing field: ${key}`);
}

if (typeof snapshot.ytd !== "number") problems.push("ytd did not resolve");
if (!snapshot.positionCount) problems.push("no positions");

const unresolved = (snapshot.tickers || []).filter((t) => String(t).startsWith("#"));
if (unresolved.length) {
  problems.push(
    `${unresolved.length} instrument id(s) not resolved to a ticker: ${unresolved.join(", ")}`
  );
}

const missingName = (snapshot.positions || []).filter((p) => !p.name).length;
if (missingName) problems.push(`${missingName} position(s) without a display name`);

if (problems.length) {
  console.error("Snapshot is not usable:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\ndiagnostics: ${JSON.stringify(snapshot.diagnostics)}`);
  process.exit(1);
}

console.log(
  `Snapshot OK: ytd=${snapshot.ytdFormatted}, ${snapshot.positionCount} positions, ` +
    `all tickers resolved (${snapshot.diagnostics?.symbolSerialization}).`
);
