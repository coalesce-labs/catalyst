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

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { getEventLogPath, getExecutionCoreDir } from "./config.mjs";
import { DEFAULT_SETTLE_SEC, compareStreams, resolveWindow } from "./linear-feed-parity.mjs";
import { Database } from "bun:sqlite";

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

// ⛔ THE WINDOW MAY NOT REACH BACK BEFORE THE FEED EXISTED.
// The feed can only know about changes AFTER its baseline was seeded — anything
// earlier is already IN the baseline, so it correctly produces no diff. Comparing a
// window that predates the seed therefore reports smee-only diffs for every change
// in that period, which look exactly like missed dispatches and are not.
//
// Found on live data: CTC-587/594 changed at 05:18 and CTC-256 at 05:11, all before
// the 05:20 seed. They showed as 7 "unexplained" smee-only diffs until the window
// was clamped. A harness that manufactures false misses is worse than no harness —
// people learn to discount it, and then discount the real one.
const LASTSEEN = flag("--lastseen", `${getExecutionCoreDir()}/linear-feed-lastseen-tenant-0.db`);
function feedSeededAt(path) {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const v = db.prepare("SELECT value FROM meta WHERE key = 'seeded_at'").get()?.value;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
const seededAt = feedSeededAt(LASTSEEN);

// ⛔ THE WINDOW MAY NOT REACH FORWARD INTO THE FEED'S OWN LATENCY.
// The exact twin of the seed clamp above, and missing until CTL-1847's wiring.
// The two producers do not observe a change at the same time: smee is an
// instant webhook, while the feed's path is replica-write latency (~11 s
// measured) PLUS up to one producer tick (30 s default). So every event inside
// roughly the last minute is one smee has reported and the feed has not YET
// reported — structurally, on a perfectly healthy feed.
//
// Measured live on 2026-08-16: two comments written at 20:20:03Z and 20:20:08Z
// read as 2 UNEXPLAINED smee-only diffs at 20:22Z (verdict NOT CLEAN); re-running
// the identical window minutes later, with no code change, showed both on the
// feed side and the verdict went CLEAN.
//
// ⚠️ The danger is NOT the false alarm. It is that once an operator learns
// trailing-edge misses are normal, a REAL miss at the trailing edge gets waved
// through by the same reasoning. Clamping makes the two distinguishable again.
//
// The clamp applies to BOTH sides (compareStreams' `inWindow` filters smee and
// feed symmetrically). Clamping only smee would trade this bias for its mirror.
const SETTLE_SEC = Number(flag("--settle-sec", String(DEFAULT_SETTLE_SEC))) || DEFAULT_SETTLE_SEC;
// Both bounds come from the shared pure resolver so the CLI cannot drift from
// what the tests pin.
const { since, until, clampedToFeedStart: clamped, emptyWindow } = resolveWindow({
  nowMs: Date.now(),
  sinceMin: SINCE_MIN,
  seededAt,
  settleSec: SETTLE_SEC,
});

const smeeRaw = parseJsonl(tailLines(EVENTS, TAIL_BYTES));
// The shadow file is append-only and never rotated, so it grows for as long as
// the producer runs — unbounded under enforce. Read it with the SAME bounded
// tail as the event log rather than whole (CTL-1529's rule is about the read,
// not about which file). The reach is reported below so a tail that does not
// cover the window reads as INCONCLUSIVE instead of as feed-side misses.
const feedRaw = parseJsonl(tailLines(SHADOW, TAIL_BYTES));

const result = compareStreams({ smee: smeeRaw.events, feed: feedRaw.events, since, until });
// The verdict is THREE-VALUED. "clean" alone cannot distinguish "the two
// streams agree" from "there was nothing to compare", and the previous exit
// code (`clean ? 0 : 2`) reported the empty-feed case as 0 — so the warning
// below was visible to a human reading stdout and invisible to anything
// automated, which is the half that matters for a cutover gate.
// How far back each bounded tail actually reaches. A tail that stops INSIDE the
// window cannot see the window's early events, and their absence is
// indistinguishable from a real miss — so it is "could not look", not a diff.
const reachOf = (evts) =>
  evts.reduce((min, e) => {
    const t = Date.parse(e?.ts ?? "");
    return Number.isFinite(t) && (min === null || t < min) ? t : min;
  }, null);
const feedReach = reachOf(feedRaw.events);
const feedTailShort = feedReach !== null && feedReach > since;
// ⛔ THE SAME CHECK FOR SMEE (Codex P1 round 4). I added the reach guard for the
// feed tail and not for the webhook tail — even though both are capped at the
// same --tail-bytes and the unified event log is far busier, so IT is the one
// likely to truncate. A smee tail covering only the latter part of the window
// still passes the non-empty guard, and the earlier feed events then have no
// webhook records to match against — exiting CLEAN without having read what it
// claimed to compare.
const smeeReach = reachOf(smeeRaw.events);
const smeeTailShort = smeeReach !== null && smeeReach > since;

const inconclusiveReasons = [];
if (emptyWindow) inconclusiveReasons.push("settle-period-exceeds-window");
if (feedTailShort) inconclusiveReasons.push("feed-tail-does-not-reach-window-start");
if (smeeTailShort) inconclusiveReasons.push("smee-tail-does-not-reach-window-start");
// ⛔ A TORN RECORD MEANS THE STREAM WAS NOT FULLY READ (Codex P1 round 5).
// parseJsonl already counted them and nothing consumed the count — a malformed
// record inside the settled window is dropped before tallying, and the run could
// then report CLEAN about a stream it did not completely read. The counters
// existed; they just were not wired to the verdict, which is the same shape as
// every other defect this review found.
if (smeeRaw.torn > 0) inconclusiveReasons.push(`smee-torn-lines:${smeeRaw.torn}`);
if (feedRaw.torn > 0) inconclusiveReasons.push(`feed-torn-lines:${feedRaw.torn}`);
// A dispatch-class record we could not key was never compared at all.
if (result.unkeyable?.smee > 0) inconclusiveReasons.push(`smee-unkeyable-events:${result.unkeyable.smee}`);
if (result.unkeyable?.feed > 0) inconclusiveReasons.push(`feed-unkeyable-events:${result.unkeyable.feed}`);
if (result.counts.feed === 0) inconclusiveReasons.push("feed-side-empty");
if (result.counts.smee === 0) inconclusiveReasons.push("smee-side-empty");
if (seededAt === null) inconclusiveReasons.push("no-feed-baseline");
const inconclusive = inconclusiveReasons.length > 0;

const report = {
  windowMinutes: SINCE_MIN,
  windowStart: new Date(since).toISOString(),
  windowEnd: new Date(until).toISOString(),
  settleSeconds: SETTLE_SEC,
  feedSeededAt: seededAt ? new Date(seededAt).toISOString() : null,
  clampedToFeedStart: clamped,
  feedTailReachesBackTo: feedReach ? new Date(feedReach).toISOString() : null,
  feedTailShort,
  smeeTailReachesBackTo: smeeReach ? new Date(smeeReach).toISOString() : null,
  smeeTailShort,
  inconclusive,
  inconclusiveReasons,
  shadow: SHADOW,
  tornLines: { smee: smeeRaw.torn, feed: feedRaw.torn },
  // How far back the tail actually reaches. The late-arrival predicate corroborates
  // a feed-only edge against smee events BEFORE the window, so a tail that stops
  // short simply finds nothing — which reads as UNEXPLAINED (the safe direction),
  // but is "could not look", not "no corroboration exists". Report the reach so the
  // two are distinguishable rather than silently conflated.
  smeeTailReachesBackTo: smeeRaw.events.reduce((min, e) => {
    const t = Date.parse(e?.ts ?? "");
    return Number.isFinite(t) && (min === null || t < min) ? t : min;
  }, null),
  ...result,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const T = "[parity]";
  console.log(
    `${T} window: last ${SINCE_MIN}m → ${new Date(since).toISOString()} .. ${new Date(until).toISOString()}` +
      ` (trailing edge held back ${SETTLE_SEC}s for feed latency)`,
  );
  if (clamped) {
    console.log(`${T} ⛔ CLAMPED to the feed's seed time (${new Date(seededAt).toISOString()}) — the feed cannot know about changes before its baseline existed.`);
  } else if (seededAt === null) {
    console.log(`${T} ⚠️ no baseline found at ${LASTSEEN} — window NOT clamped; pre-seed changes will read as false smee-only diffs.`);
  }
  console.log(`${T} events compared — smee: ${result.counts.smee}  feed: ${result.counts.feed}  matched keys: ${result.matchedKeys}`);
  console.log(`${T} torn lines — smee: ${smeeRaw.torn}  feed: ${feedRaw.torn}`);
  console.log(
    `${T} smee tail reaches back to: ${report.smeeTailReachesBackTo ? new Date(report.smeeTailReachesBackTo).toISOString() : "(nothing parsed)"}` +
      ` — corroboration for a late arrival can only be found within this reach`,
  );
  console.log(`${T} classes (smee): ${JSON.stringify(result.classes.smee)}`);
  console.log(`${T} classes (feed): ${JSON.stringify(result.classes.feed)}`);
  console.log(`${T} explained asymmetries: ${result.explained.length}`);
  for (const e of result.explained.slice(0, 10)) console.log(`${T}   ${e.side} ${e.key} ×${e.count} — ${e.why}`);
  console.log(`${T} UNEXPLAINED diffs: ${result.unexplained.length}`);
  for (const u of result.unexplained.slice(0, 20)) console.log(`${T}   ${u.side} ${u.key} ×${u.count}`);
  if (inconclusive) {
    // Guard the exact false-clean this repo keeps finding: zero-vs-zero is not parity.
    console.log(
      `${T} ⚠️ INCONCLUSIVE (${inconclusiveReasons.join(", ")}) — "clean" here would mean nothing was compared.`,
    );
  }
  console.log(
    `${T} verdict: ${inconclusive ? "INCONCLUSIVE" : result.clean ? "CLEAN (no unexplained diffs)" : "NOT CLEAN"}`,
  );
}
// 0 = clean · 2 = unexplained diffs · 3 = inconclusive. An inconclusive run is
// reported as its own code rather than folded into either verdict: a caller
// that cannot tell "agreed" from "could not look" is the thing this exit code
// exists to prevent.
process.exit(inconclusive ? 3 : result.clean ? 0 : 2);
