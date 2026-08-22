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
// ⛔ CTL-2022: WHICH FILE IS "THE FEED SIDE" DEPENDS ON THE MODE, and reading the wrong
// one is how this instrument certified the 2026-08-18 outage as clean.
//
// The producer's sink has two branches. In `shadow` it writes raw output to the shadow
// file and a `would-dispatch` MARKER to the event log. In `enforce` it writes the REAL
// event to the event log — a different branch, a different file. This runner read the
// SHADOW FILE unconditionally, so at enforce it was measuring a stream that enforce
// does not dispatch from.
//
// Measured on mini-2 across the enforce window 18:58:16Z-19:44:15Z: the shadow file
// carried 125 `check_suite.completed` + 28 `push`; the event log's `cloud-feed` channel
// carried ZERO of each, because the producer had downgraded both to markers. The ledger
// reported `clean = true · exit 0` throughout — and had reported the same for the 65
// minutes before the flip, which is what the flip was authorised on.
//
// So the feed side is now SELECTED FROM THE RESOLVED MODE: `event-log` at enforce,
// `shadow` otherwise, overridable with `--feed-source` for forensics on a past window.
// The selection is PRINTED, because an instrument that silently picks a side is the
// defect one level up.
//
// ⚠️ THE WINDOW IS THE CALLER'S, deliberately. `compareGithubStreams` is pure and
// takes two already-windowed arrays; keeping the windowing out here is what lets the
// comparator be unit-tested without a filesystem.
//
// Usage: bun github-feed-parity-run.mjs <ISO-lo> <ISO-hi> [--json]
// Exit:  0 clean · 2 diverged · 3 inconclusive (the Linear leg's contract).

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareGithubStreams, parityExitCode } from "./github-feed-parity.mjs";
import { GITHUB_CONSUMED_NAMES } from "./github-feed-gate.mjs";
import { resolveGithubFeedMode } from "../lib/github-feed-mode.mjs";
// CTL-1216: THE event-log window resolver — every file overlapping [lo, hi),
// so a window straddling a rotation boundary is not silently truncated.
import { resolveEventLogPathsForWindow } from "../lib/event-log-paths.mjs";
// ⛔ IMPORTED, never re-typed. A hand-written copy of the marker name that drifts would
// make every dropped dispatch class invisible again — silently, and in the instrument.
import { EVENT_WOULD_DISPATCH as MARKER_NAME } from "./github-feed-timer.mjs";
import { selectFeedSource, isCloudFeedEvent, markerEventName } from "./github-feed-parity-source.mjs";

const [lo, hi, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");
if (!lo || !hi) {
  console.error(
    "usage: github-feed-parity-run.mjs <ISO-lo> <ISO-hi> [--json] [--feed-source=shadow|event-log]",
  );
  process.exit(3);
}

const sourceFlag = rest.find((a) => a.startsWith("--feed-source="));
const requestedSource = sourceFlag ? sourceFlag.slice("--feed-source=".length) : null;

let modeInfo = null;
try {
  modeInfo = resolveGithubFeedMode();
} catch {
  /* selectFeedSource turns an unresolved mode into a NAMED refusal — see its header */
}
const selected = selectFeedSource({ requestedSource, mode: modeInfo?.mode ?? null });
if (!selected.ok) {
  console.error(
    `cannot choose the feed side (${selected.reason}) — refusing to guess. ` +
    "Re-run with --feed-source=shadow|event-log.",
  );
  process.exit(3);
}
const feedSource = selected.source;

const CATALYST = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const account = process.env.CATALYST_GITHUB_FEED_ACCOUNT ?? "tenant-0";
const shadowPath = process.env.CATALYST_GITHUB_FEED_SHADOW
  ?? join(CATALYST, "execution-core", "shadow", `github-feed-${account}.jsonl`);
// CTL-1216: this used to be ONE file, named from the window's START
// (`new Date(lo).toISOString().slice(0, 7)`). A parity window that straddles a
// rotation boundary therefore read only the file the window opened in and
// silently compared a partial event-log side against a complete feed side —
// which reads as a parity GAP, i.e. as the defect this tool exists to detect.
// It now resolves EVERY file overlapping [lo, hi), oldest-first, mixing schemes.
// The explicit CATALYST_EVENT_LOG override still pins exactly one file.
const eventsPaths = process.env.CATALYST_EVENT_LOG
  ? [process.env.CATALYST_EVENT_LOG]
  : resolveEventLogPathsForWindow({
      eventsDir: join(CATALYST, "events"),
      sinceMs: Date.parse(lo),
      nowMs: Date.parse(hi),
      env: process.env,
    });

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

// jsonlAll — the same stream over EVERY file covering the window, oldest-first
// (CTL-1216). A missing file is skipped rather than fatal: the window resolver
// only ever lists files it saw in the directory, but one can be rotated away
// between the readdir and the open, and a parity run must not die on that.
async function* jsonlAll(paths) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    yield* jsonl(path);
  }
}

const feed = [];
let feedLines = 0;
let feedLast = null;
// ⛔ MARKERS ARE EVIDENCE OF A GAP, NOT SILENCE. At enforce, a covered name the producer
// downgraded to `github-feed.would-dispatch` leaves NOTHING under its real name on the
// event log — so without counting the markers a dropped name is indistinguishable from
// a quiet one, which is exactly how 153 dropped edges read as agreement.
const markersByName = {};
let markerTotal = 0;

if (feedSource === "shadow") {
  for await (const e of jsonl(shadowPath)) {
    feedLines++;
    if (typeof e?.ts === "string") feedLast = e.ts;
    if (inWindow(e)) feed.push(e);
  }
} else {
  // The feed's own copies on the unified log, identified by their POSITIVE provenance
  // stamp — never by elimination, the same rule the smee reader below follows.
  for await (const e of jsonlAll(eventsPaths)) {
    const marker = markerEventName(e, MARKER_NAME);
    if (marker !== null) {
      if (!inWindow(e)) continue;
      markerTotal++;
      markersByName[marker] = (markersByName[marker] ?? 0) + 1;
      continue;
    }
    if (!isCloudFeedEvent(e)) continue;
    feedLines++;
    if (typeof e?.ts === "string") feedLast = e.ts;
    if (inWindow(e)) feed.push(e);
  }
}

const smee = [];
const seenDelivery = new Set();
let smeeSeen = 0;
let smeeLast = null;
let smeeDuplicates = 0;
for await (const e of jsonlAll(eventsPaths)) {
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
// ⛔ CTL-2022: A MARKER UNDER A CONSUMED NAME MOVES THE VERDICT, it is not just printed.
// Reporting a gap while returning `clean = true` is the same defect one level up — the
// operator reads the exit code, and the whole reason this window was authorised was an
// `exit 0`. At `enforce` a `would-dispatch` marker for a name the router CONSUMES means
// that dispatch class produced nothing under its real name while the tunnel was closed,
// which is precisely the 2026-08-18 failure. Only consumed names count: a marker for
// some other name is the producer correctly declining something nobody routes.
//
// It is INCONCLUSIVE rather than a hard divergence for the same reason `smee-unjoined`
// is: the ledger cannot prove from here whether smee also carried the edge. What it can
// prove is that the feed did not, and that is enough to withhold a clean bill.
const droppedClasses = Object.entries(markersByName)
  .filter(([n]) => GITHUB_CONSUMED_NAMES.includes(n))
  .sort((a, b) => b[1] - a[1]);
if (feedSource === "event-log" && droppedClasses.length > 0) {
  const total = droppedClasses.reduce((a, [, c]) => a + c, 0);
  report.inconclusive.push(
    `dispatch-classes-downgraded-to-markers:${total}:${droppedClasses.map(([n, c]) => `${n}=${c}`).join(",")}`,
  );
  report.clean = false;
}

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
  feedSource,
  feedSourcePath: feedSource === "shadow" ? shadowPath : eventsPath,
  modeResolved: modeInfo ? { mode: modeInfo.mode, source: modeInfo.source } : null,
  markersByName, markerTotal,
  shadowPath, eventsPath,
  feedLinesTotal: feedLines, feedLastTs: feedLast,
  smeeGithubTotal: smeeSeen, smeeLastTs: smeeLast,
  tornLines: torn,
  smeeDuplicateDeliveries: smeeDuplicates,
};

if (asJson) {
  console.log(JSON.stringify({ window: { lo, hi }, instrument, report, exit: code }, null, 2));
} else {
  console.log(
    `instrument: feed-source=${feedSource}` +
    `${modeInfo ? ` (mode=${modeInfo.mode} via ${modeInfo.source})` : " (mode unresolved — --feed-source override)"}` +
    ` · feed lines=${feedLines} last=${feedLast} · smee github=${smeeSeen} last=${smeeLast} · torn=${torn}`,
  );
  if (markerTotal > 0) {
    console.log(
      `⛔ ${markerTotal} would-dispatch MARKER(s) on the event log in this window — the producer ` +
      "declined to emit these under their real names:",
    );
    for (const [n, c] of Object.entries(markersByName).sort((a, b) => b[1] - a[1])) {
      const consumed = GITHUB_CONSUMED_NAMES.includes(n);
      console.log(`     ${String(n).padEnd(38)} ${String(c).padStart(5)}${consumed ? "   ⛔ CONSUMED — this is a DROPPED dispatch class" : "   (not routed — declining is correct)"}`);
    }
  }
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
