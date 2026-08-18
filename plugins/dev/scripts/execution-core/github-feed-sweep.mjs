// github-feed-sweep.mjs — CTL-1929. One tick of the GitHub feed producer:
// resume → page → classify → suppress → emit → advance → prune, per stream.
//
// ── ⛔ THE GITHUB LEG HAS ITS OWN MODE FLAG. THIS IS A SAFETY PROPERTY. ─────
// Both minis run `CATALYST_CLOUD_FEED=enforce` today. If this producer were gated
// on that same value, then merely MERGING its wiring would put the GitHub leg into
// enforce on every host at once — and enforce means the gate SUPPRESSES smee's copy.
// The GitHub tunnel is still the only real source for `pr.merged` and
// `check_suite.completed` (CTC-691 / CTC-667 item 4), so that merge would blind the
// CI wait and the deploy chain fleet-wide, with no operator action and no rollout.
//
// `CATALYST_GITHUB_FEED` is therefore a SEPARATE knob defaulting to `off`, and the
// two legs are never read from one value. Ship-inert is the requirement, not a
// preference: a cutover an operator did not choose is not a cutover.
//
// ── COUNTS: THE DECLINE / FAILURE SPLIT, AND WHY IT DECIDES READINESS ──────
// Inherited verbatim from `linear-feed-sweep.mjs`, because readiness is computed
// from these counts and `cloud-feed-timer.countsClean` reads `failed` + `byFailure`
// (NOT `byReason`). The rule for choosing between them is one question:
//
//     WOULD UN-ARMING THE PRODUCER REPAIR THIS?
//
// A malformed row, or an edge we have declared we cannot build (`pr.merged` until
// CTC-691), is a DECLINE — un-arming repairs nothing and would hand dispatch back to
// a tunnel we are trying to retire. A condition that makes EVERY row unemittable —
// an unreadable replica, an unknown stream — is a FAILURE, and readiness un-arms.
//
// ⛔ That distinction is exactly what CTL-1909 was filed for: readiness once read
// `byReason`, so ordinary healthy declines un-armed enforce within two minutes of
// boot. Declines must not reach `byFailure`.
//
// ── ORDERING WITHIN A STREAM ───────────────────────────────────────────────
// emit → mark seen → write cursor → prune. Each step is safe to repeat and none may
// be reordered:
//   * marking seen BEFORE emitting would suppress an edge that never reached the log;
//   * pruning BEFORE the cursor is durable would leave a window both re-readable and
//     unsuppressed, which is the duplicate storm the seen-set exists to prevent.
// A throw anywhere leaves the cursor where it was, so the next tick re-reads and the
// seen-set makes that re-read a no-op. Losing forward progress is recoverable;
// advancing past an unemitted row is not.

import {
  CURSOR_ABSENT,
  readCursor,
  resolveStartPosition,
  writeCursor,
} from "./linear-feed-cursor.mjs";
import {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_SETTLE_MS,
  STREAMS,
  settleCursor,
} from "./github-feed-source.mjs";
import { buildGithubEvent, classifyGithubRow, githubEdgeId } from "./github-feed-event.mjs";
import { countsClean, countsDirtyWhy } from "./cloud-feed-timer.mjs";

/** Pages per stream per tick. Bounds one tick's work; the remainder rides the next. */
export const DEFAULT_MAX_BATCHES = 20;

/** A zeroed counts record. `byFailure` is PRESENT and empty — see the note below. */
export function emptyCounts() {
  return {
    emitted: 0,
    suppressed: 0,
    declined: 0,
    failed: 0,
    byReason: {},
    // ⛔ Must exist even when empty. `cloud-feed-timer.countsClean` treats an ABSENT
    // `byFailure` as not-clean on purpose: "nothing went wrong" and "I could not
    // look" must not be byte-identical to the reader.
    byFailure: {},
    byStream: {},
  };
}

const bump = (m, k) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** A row was examined and deliberately not emitted. Healthy; readiness unaffected. */
export function decline(counts, reason) {
  counts.declined += 1;
  bump(counts.byReason, reason || "unclassified");
}

/** Something happened that un-arming would repair. Readiness un-arms on this. */
export function fail(counts, reason) {
  counts.failed += 1;
  bump(counts.byFailure, reason || "unclassified");
}

/** Per-stream cursor file. One file per stream, deliberately — see `runGithubSweep`. */
export function streamCursorPath(orchDir, streamKey, account) {
  if (typeof account !== "string" || account === "") {
    throw new Error("streamCursorPath: account is required — an unlabelled cursor files producer state under the wrong tenant");
  }
  return `${orchDir}/github-feed-cursor-${account}-${streamKey}.json`;
}

/**
 * Sweep ONE stream. Extracted so a stream's failure is contained: a throw here is
 * caught by the caller and counted against that stream alone, leaving the other
 * eight to make progress. A single shared try-block would let one malformed table
 * stall every name.
 */
export function sweepStream({
  source,
  seen,
  sink,
  streamKey,
  cursorPath,
  now,
  settleMs = DEFAULT_SETTLE_MS,
  batchLimit = DEFAULT_BATCH_LIMIT,
  maxBatches = DEFAULT_MAX_BATCHES,
  counts,
  seams,
  readCursorFn = readCursor,
  writeCursorFn = writeCursor,
}) {
  const read = readCursorFn(cursorPath);
  const start = resolveStartPosition(read, { now: () => now, everRan: seen.everRan(streamKey) });
  if (start.alarm) {
    // A silently-reset producer is indistinguishable from a working one, so the
    // reset is counted. It is a DECLINE, not a failure: the position is already
    // bounded by a stated lookback and un-arming would not restore it.
    decline(counts, `cursor-reset:${start.alarm.reason}`);
  }

  // ⛔ A COLD START OR RESET BEGINS ONE SETTLE WINDOW BACK, NOT AT `now`.
  // `resolveStartPosition` hands back `now` for a first run, which is right for the
  // Linear leg: its coordinate is an append-only log's `created_at`, and a row is on
  // disk by the time it exists. Ours is EVENT time on a row that arrives later —
  // measured up to 333 s later. Starting at `now` would therefore bake a guaranteed
  // blind spot into every first run and every cursor reset: everything already in
  // flight carries a stamp before `now` and would land permanently behind the cursor.
  // The offset is the same bound the cursor is held back by, for the same reason, and
  // it stays a STATED bound rather than a bare clock read.
  const startSince = start.mode === "resume" ? start.since : start.since - settleMs;
  let position =
    read.state === CURSOR_ABSENT || start.mode !== "resume"
      ? { lastCreatedAt: startSince, lastId: "" }
      : read.position;

  const streamCounts = { emitted: 0, suppressed: 0, declined: 0, batches: 0 };
  let emittedPosition = null;

  for (let b = 0; b < maxBatches; b++) {
    const rows = source.rowsSince(streamKey, position, batchLimit);
    if (rows.length === 0) break;
    streamCounts.batches += 1;

    for (const row of rows) {
      const verdict = classifyGithubRow(streamKey, row);
      if (!verdict.emit) {
        if (verdict.fatal) fail(counts, verdict.reason);
        else decline(counts, verdict.reason);
        streamCounts.declined += 1;
        continue;
      }
      const edgeId = githubEdgeId(streamKey, row);
      // The settle window guarantees we re-read; this is where that becomes free.
      if (seen.has(edgeId)) {
        counts.suppressed += 1;
        streamCounts.suppressed += 1;
        continue;
      }
      const event = buildGithubEvent(streamKey, row, seams);
      if (!event) {
        // Classified emittable but unbuildable — never expected, so it is a FAILURE:
        // it means classification and construction disagree, which un-arming (and a
        // human) really should look at.
        fail(counts, `unbuildable:${streamKey}`);
        streamCounts.declined += 1;
        continue;
      }
      sink(event);
      // Marked only AFTER the sink returns. Marking first would suppress an edge
      // that never reached the log.
      seen.add(edgeId, row.__ts, streamKey);
      counts.emitted += 1;
      streamCounts.emitted += 1;
    }

    emittedPosition = source.positionAfter(rows);
    if (!emittedPosition) break;
    position = emittedPosition;
    if (rows.length < batchLimit) break;
  }

  // The durable position is NOT where we got to — it is held behind by the settle
  // window so late arrivals stay ahead of it. See github-feed-source.mjs.
  const previous = read.state === "ok" ? read.position : null;
  const durable = settleCursor(emittedPosition, { now, settleMs, previous });
  if (durable && (!previous || durable.lastCreatedAt !== previous.lastCreatedAt || durable.lastId !== previous.lastId)) {
    writeCursorFn(cursorPath, durable);
    // Only now, with the cursor durable, can the suppression set forget anything —
    // and only THIS stream's entries. The table is shared; the cursors are not, and
    // an unscoped prune lets a stream with a newer cursor delete a slower stream's
    // still-re-readable entries (`github-feed-seen.mjs`).
    seen.pruneBefore(durable.lastCreatedAt, streamKey);
    // ⛔ MARK ON A DURABLE CURSOR, NOT ON AN EMISSION. A stream whose rows all
    // DECLINE still advances its cursor, and that advance is itself proof the stream
    // has run. Keying `everRan` on `emitted > 0` left such a stream flagged as
    // first-run, so a later cursor loss cold-starts it at `now - settleMs` instead of
    // replaying the stated lookback — permanently skipping anything that happened
    // during the downtime outside the settle window but inside that lookback.
    seen.markRan(streamKey);
  }

  counts.byStream[streamKey] = streamCounts;
  return streamCounts;
}

/**
 * One full tick across every stream.
 *
 * ⭐ Cursors are PER STREAM, in separate files. A single combined file would make one
 * corrupt write cost all nine positions, and the streams have genuinely independent
 * positions (a repo can be quiet on deployments for days while reviews stream). It
 * also means the reusable single-position cursor module is called unchanged rather
 * than forked into a multi-position variant.
 */
export function runGithubSweep({
  source,
  seen,
  sink,
  orchDir,
  // ⛔ No default. The account NAMES every per-tenant artifact (cursor files, the
  // suppression store, the marker attribute); defaulting it means a host configured
  // for another account silently files its state under `tenant-0` and still looks
  // complete. `github-feed-timer.resolveAccount` is the one resolver.
  account,
  now = Date.now(),
  settleMs = DEFAULT_SETTLE_MS,
  batchLimit = DEFAULT_BATCH_LIMIT,
  maxBatches = DEFAULT_MAX_BATCHES,
  streams = STREAMS.map((s) => s.key),
  seams,
  cursorPathFn = streamCursorPath,
  readCursorFn = readCursor,
  writeCursorFn = writeCursor,
}) {
  const counts = emptyCounts();
  for (const streamKey of streams) {
    try {
      sweepStream({
        source,
        seen,
        sink,
        streamKey,
        cursorPath: cursorPathFn(orchDir, streamKey, account),
        now,
        settleMs,
        batchLimit,
        maxBatches,
        counts,
        seams,
        readCursorFn,
        writeCursorFn,
      });
    } catch (err) {
      // Contained per stream: the other eight still make progress. A FAILURE, since
      // an unreadable table is exactly the condition un-arming should respond to.
      fail(counts, `stream-threw:${streamKey}:${err?.code ?? err?.name ?? "unknown"}`);
    }
  }
  return counts;
}

/**
 * Why this tick does not arm the GitHub producer, or `null` when it does.
 *
 * A twin of `cloud-feed-timer.sweepUnreadyReason` rather than a call to it: that
 * one's conjuncts are named for the Linear leg's streams (`edges`, `comments`,
 * `labels`) and a GitHub report has none of them. What IS shared — and is imported
 * rather than restated — is `countsClean` / `countsDirtyWhy`, the part that actually
 * decides. A hand-built copy of that predicate could agree with a fixture while
 * disagreeing with the gate the daemon runs.
 *
 * Fail-closed at every rung: an absent report, an absent counts record, or an absent
 * `byFailure` all read as NOT ready. "Nothing went wrong" and "I could not look" must
 * never be byte-identical to the caller.
 */
export function githubSweepUnreadyReason(report, feedHealth = { healthy: false, reason: "unknown" }) {
  if (!report) return "no-report";
  if (report.skipped) return `skipped:${report.skipped}`;
  if (report.error) return `error:${report.error}`;
  if (feedHealth?.healthy !== true) return `feed-unhealthy:${feedHealth?.reason ?? "unknown"}`;
  if (!report.counts) return "no-sweep";
  if (report.stoppedEarly === true) return "stopped-early";
  if (!countsClean(report.counts)) return `streams:${countsDirtyWhy(report.counts)}`;
  return null;
}
