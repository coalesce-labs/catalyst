#!/usr/bin/env bun
// github-feed-parity-run.mjs — CTL-1929. The ledger's CLI: window the two streams and
// hand them to `compareGithubStreams`.
//
// ⛔ IT STREAMS BOTH FILES, AND THAT IS NOT A STYLE CHOICE. The ad-hoc runner this
// replaces read the month's event log with `readFileSync`. That worked until
// 2026-08-18, when `~/catalyst/events/2026-08.jsonl` passed **1.59 GB** and Node's
// 512 MB string cap turned every run into `ERR_STRING_TOO_LONG`. The instrument the
// cutover is judged by stopped working, mid-cutover, for a reason unrelated to the
// thing it measures — so the fix is committed rather than left in /tmp.
//
// ⚠️ THE WINDOW IS THE CALLER'S, deliberately. `compareGithubStreams` is pure and
// takes two already-windowed arrays; keeping the windowing out here is what lets the
// comparator be unit-tested without a filesystem.
//
// Usage: bun github-feed-parity-run.mjs <ISO-lo> <ISO-hi> [--json]
// Exit:  0 clean · 2 diverged · 3 inconclusive (the Linear leg's contract).

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareGithubStreams, parityExitCode } from "./github-feed-parity.mjs";

const [lo, hi, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");
if (!lo || !hi) {
  console.error("usage: github-feed-parity-run.mjs <ISO-lo> <ISO-hi> [--json]");
  process.exit(3);
}

const CATALYST = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const account = process.env.CATALYST_GITHUB_FEED_ACCOUNT ?? "tenant-0";
const shadowPath = process.env.CATALYST_GITHUB_FEED_SHADOW
  ?? join(CATALYST, "execution-core", "shadow", `github-feed-${account}.jsonl`);
const eventsPath = process.env.CATALYST_EVENT_LOG
  ?? join(CATALYST, "events", `${new Date(lo).toISOString().slice(0, 7)}.jsonl`);

const inWindow = (e) => {
  const t = e?.ts;
  return typeof t === "string" && t >= lo && t < hi;
};

let torn = 0;

async function* jsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    // ⚠️ A torn line is SKIPPED, never fatal — the same posture every other reader of
    // this log takes (see docs/architecture.md). It is also counted, so a window full
    // of damage cannot read as a window full of agreement.
    try { yield JSON.parse(line); } catch { torn++; }
  }
}

const feed = [];
let feedLines = 0;
let feedLast = null;
for await (const e of jsonl(shadowPath)) {
  feedLines++;
  if (typeof e?.ts === "string") feedLast = e.ts;
  if (inWindow(e)) feed.push(e);
}

const smee = [];
const seenDelivery = new Set();
let smeeSeen = 0;
let smeeLast = null;
let smeeDuplicates = 0;
for await (const e of jsonl(eventsPath)) {
  const n = e?.attributes?.["event.name"];
  if (typeof n !== "string" || !n.startsWith("github.")) continue;
  // Our own copy is excluded by its positive provenance stamp, never by elimination.
  if (e?.body?.payload?.source === "cloud-feed") continue;
  smeeSeen++;
  if (typeof e?.ts === "string") smeeLast = e.ts;
  if (!inWindow(e)) continue;
  // ⛔ ONE ROW PER GITHUB DELIVERY. On a worker node this changes nothing — the host's
  // own log holds one copy. On an OBSERVATION node it is the difference between a
  // clean verdict and a fabricated gap: event-mirror fans in every worker's log, and
  // each mini runs its OWN smee tunnel, so every delivery appears once per host.
  // Measured on the laptop over one 70-minute window: 166 events, 83 distinct delivery
  // ids, 83 per host — which reported `smee-unjoined 77` against a feed that had
  // reproduced every single one of them.
  //
  // ⚠️ Collapsed on GitHub's OWN delivery id, never on content: two genuinely distinct
  // deliveries are two events, and a redelivery of one is one. An event with no
  // delivery id is kept rather than dropped — absence of the key is not evidence of a
  // duplicate, and dropping it would be the silent direction.
  const delivery = e?.attributes?.["webhook.delivery.id"];
  if (typeof delivery === "string" && delivery !== "") {
    if (seenDelivery.has(delivery)) { smeeDuplicates++; continue; }
    seenDelivery.add(delivery);
  }
  smee.push(e);
}

const report = compareGithubStreams(feed, smee);

// ⛔ A WINDOW THAT OUTRUNS THE PRODUCER MANUFACTURES ITS OWN SMEE-UNJOINED COUNT, and
// it does so at exactly the moment someone is deciding whether a tunnel can be
// retired. The producer ticks every ~30 s; smee is a webhook and arrives immediately.
// So every edge between the producer's last tick and `hi` is on the smee side ALONE,
// with a twin that simply has not been written yet.
//
// Measured this morning: 09:00→12:00 reported `github.push` feed 10 / smee 11 and one
// unjoined event. Re-run with the window closed at 11:45 — before the producer's last
// tick at 11:51:40 — it was 9/9 and zero. The "gap" was the clock.
//
// It is reported rather than auto-corrected: silently clamping `hi` would hide a
// producer that had genuinely stopped, which looks identical from here. The operator
// is told which one they are looking at, and the verdict stays INCONCLUSIVE either way.
const trailingSkew = typeof feedLast === "string" && feedLast < hi;
if (trailingSkew) {
  report.inconclusive.push(`window-outruns-producer:feed-last=${feedLast}`);
  report.clean = false;
}

const code = parityExitCode(report);

// ⛔ THE INSTRUMENT REPORTS ON ITSELF FIRST. An empty window is the ledger's most
// dangerous output — `[].every()` is true — and "no events happened" is not
// distinguishable from "I read the wrong file" without these lines. `*Last` is the
// positive control: it should track real GitHub activity.
const instrument = {
  shadowPath, eventsPath,
  feedLinesTotal: feedLines, feedLastTs: feedLast,
  smeeGithubTotal: smeeSeen, smeeLastTs: smeeLast,
  tornLines: torn,
  smeeDuplicateDeliveries: smeeDuplicates,
};

if (asJson) {
  console.log(JSON.stringify({ window: { lo, hi }, instrument, report, exit: code }, null, 2));
} else {
  console.log(`instrument: shadow lines=${feedLines} last=${feedLast} · smee github=${smeeSeen} last=${smeeLast} · torn=${torn}`);
  if (smeeDuplicates > 0) {
    console.log(`            ${smeeDuplicates} duplicate webhook deliveries collapsed (an observation node mirrors every worker's copy — see the source)`);
  }
  console.log(`WINDOW ${lo} -> ${hi}`);
  console.log(`feed ${feed.length} · smee ${smee.length}`);
  console.log(`joined ${report.totals.joined} / agree ${report.totals.agree} · feed-unjoined ${report.totals.unjoined} · smee-unjoined ${report.smeeUnjoined} · unkeyable ${report.unkeyable}`);
  for (const [n, v] of Object.entries(report.byName)) {
    console.log(`   ${n.padEnd(38)} joined=${v.joined} agree=${v.agree} unjoined=${v.unjoined}`);
  }
  console.log("comparableRepos  :", JSON.stringify(report.comparableRepos));
  console.log("feedOnlyRepos    :", JSON.stringify(report.feedOnlyRepos), "(superset — never blocks CLEAN)");
  console.log("mirrorUnstorable :", JSON.stringify(report.mirrorUnstorable), "(CTC-719 — conclusions the mirror drops; self-retires when it stops)");
  console.log("expectedAbsent   :", JSON.stringify(report.expectedAbsent));
  console.log("unexplainedAbsent:", JSON.stringify(report.unexplainedAbsent));
  console.log("inconclusive     :", JSON.stringify(report.inconclusive));
  if (trailingSkew) {
    console.log(
      `⚠️  WINDOW OUTRUNS THE PRODUCER — its last emission is ${feedLast}, the window ends ${hi}.\n` +
      "    Every smee edge in that tail has no twin YET. Re-run with --hi at or before the\n" +
      "    producer's last emission before reading any smee-unjoined count as a gap.",
    );
  }
  console.log(`clean = ${report.clean} · exit ${code}`);
}
process.exit(code);
