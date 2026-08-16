#!/usr/bin/env bun
// linear-feed-parity-run.mjs — CTL-1847, run the parity harness over real streams.
//
// Reads the SMEE side from the unified event log (already durable — the webhook
// receiver writes it, so no separate capture was ever needed) and the FEED side from
// the diff producer's shadow file, then reports per-class counts on both sides, the
// explained asymmetries, and the unexplained diffs that gate the shadow window.
//
// Usage:
//   bun linear-feed-parity-run.mjs [--since-min N] [--shadow PATH] [--events PATH] [--json]
//
// ⚠️ The event log is multi-GB. It is read with a bounded tail rather than whole —
// `readFileSync` on it is the exact whole-file-read defect this repo has fixed twice
// (CTL-1529 / the DLQ). Only the tail can contain a recent window anyway.

import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { getEventLogPath, getExecutionCoreDir } from "./config.mjs";
import { compareStreams } from "./linear-feed-parity.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SINCE_MIN = Number(flag("--since-min", "60")) || 60;
const AS_JSON = argv.includes("--json");
const SHADOW = flag("--shadow", `${getExecutionCoreDir()}/shadow/linear-feed-tenant-0.diff.jsonl`);
const EVENTS = flag("--events", getEventLogPath());
const TAIL_BYTES = Number(flag("--tail-bytes", String(80 * 1024 * 1024)));

/** Read the last N bytes of a file, dropping a leading partial line. */
function tailLines(path, maxBytes) {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // A non-zero start means the first line is a fragment of an earlier record.
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

function parseJsonl(lines) {
  const out = [];
  let torn = 0;
  for (const l of lines) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // Counted, never silent — a torn line is real on a log with concurrent
      // appenders, and an uncounted skip is how a comparison quietly loses data.
      torn += 1;
    }
  }
  return { events: out, torn };
}

const since = Date.now() - SINCE_MIN * 60_000;
const smeeRaw = parseJsonl(tailLines(EVENTS, TAIL_BYTES));
const feedRaw = parseJsonl(existsSync(SHADOW) ? readFileSync(SHADOW, "utf8").split("\n") : []);

const result = compareStreams({ smee: smeeRaw.events, feed: feedRaw.events, since });
const report = {
  windowMinutes: SINCE_MIN,
  shadow: SHADOW,
  tornLines: { smee: smeeRaw.torn, feed: feedRaw.torn },
  ...result,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const T = "[parity]";
  console.log(`${T} window: last ${SINCE_MIN}m`);
  console.log(`${T} events compared — smee: ${result.counts.smee}  feed: ${result.counts.feed}  matched keys: ${result.matchedKeys}`);
  console.log(`${T} torn lines — smee: ${smeeRaw.torn}  feed: ${feedRaw.torn}`);
  console.log(`${T} classes (smee): ${JSON.stringify(result.classes.smee)}`);
  console.log(`${T} classes (feed): ${JSON.stringify(result.classes.feed)}`);
  console.log(`${T} explained asymmetries: ${result.explained.length}`);
  for (const e of result.explained.slice(0, 10)) console.log(`${T}   ${e.side} ${e.key} ×${e.count} — ${e.why}`);
  console.log(`${T} UNEXPLAINED diffs: ${result.unexplained.length}`);
  for (const u of result.unexplained.slice(0, 20)) console.log(`${T}   ${u.side} ${u.key} ×${u.count}`);
  console.log(`${T} verdict: ${result.clean ? "CLEAN (no unexplained diffs)" : "NOT CLEAN"}`);
  if (result.counts.feed === 0) {
    // Guard the exact false-clean this repo keeps finding: zero-vs-zero is not parity.
    console.log(`${T} ⚠️ INCONCLUSIVE: the feed side is empty — "clean" here means nothing was compared.`);
  }
}
process.exit(result.clean ? 0 : 2);
