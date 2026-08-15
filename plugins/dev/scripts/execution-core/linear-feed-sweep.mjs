// linear-feed-sweep.mjs — CTL-1847, the loop that turns replicated edges into
// dispatch events.
//
// ── THE SWEEP IS ALSO THE COLD-START PATH ───────────────────────────────────
// Gap recovery and first-boot are the SAME code here, deliberately. A recovery
// path that only executes during an incident is a recovery path that does not
// work — it is unexercised precisely when it matters. Running the sweep on every
// boot means the gap path is proven continuously, not hypothetically.
//
// ── CURSOR ADVANCEMENT: LAST CONTIGUOUS SUCCESS ─────────────────────────────
// The subtle decision. Rows are processed oldest-first, and the cursor advances to
// the last row that was successfully HANDLED — where "handled" means emitted OR
// deliberately declined. It stops at the first EMIT FAILURE and does not advance
// past it.
//
// The two tempting alternatives are both wrong:
//   • advance to the end of the batch regardless → the failed edges are gone. For a
//     dispatch trigger that is a ticket that never gets worked, which is the exact
//     failure this whole ticket exists to remove.
//   • do not advance at all on any failure → the successfully-emitted rows before
//     the failure are re-emitted next sweep. The event log has NO dedup, so that is
//     duplicate events, not idempotence.
// Last-contiguous-success loses nothing and bounds re-emission to the failed row
// onward.
//
// ⚠️ A DECLINE IS NOT A FAILURE. A foreign-team or bot-authored row was examined and
// deliberately not emitted; the cursor must move past it or the sweep re-examines
// it forever. Conflating the two is how a producer wedges on the first row it was
// never going to emit — and on a multi-tenant replica (CTL 4,993 · ADV 3,859 ·
// CTC 851 · EVR 158 · OTL 114 state edges) most rows are declines.

import { buildCommentEvent, buildIssueEvent, classifyEdge } from "./linear-feed-event.mjs";
import {
  readCursor,
  resolveStartPosition,
  writeCursor,
  DEFAULT_RESET_LOOKBACK_MS,
} from "./linear-feed-cursor.mjs";

/** Bound the work one sweep may do, so a large backlog cannot monopolise a tick. */
export const DEFAULT_MAX_BATCHES = 20;

const emptyCounts = () => ({ emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {} });

const note = (counts, reason) => {
  counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
};

/**
 * Process one page, in order, stopping at the first EMIT FAILURE.
 *
 * Returns `{ handled, stopped }` — `handled` is the prefix of items whose outcome
 * is settled (emitted or declined) and which the cursor may therefore move past.
 */
export function processPage(items, { build, classify, emit, counts }) {
  const handled = [];
  for (const item of items) {
    counts.examined += 1;
    const verdict = classify(item);
    if (!verdict?.emit) {
      counts.declined += 1;
      note(counts, verdict?.reason ?? "unclassified");
      handled.push(item); // examined and settled — the cursor MUST move past it
      continue;
    }
    let event;
    try {
      event = build(item);
    } catch (err) {
      counts.failed += 1;
      note(counts, `build-failed:${err?.message ?? "unknown"}`);
      return { handled, stopped: true };
    }
    try {
      emit(event, item);
    } catch (err) {
      counts.failed += 1;
      note(counts, `emit-failed:${err?.message ?? "unknown"}`);
      return { handled, stopped: true }; // do NOT include this item
    }
    counts.emitted += 1;
    handled.push(item);
  }
  return { handled, stopped: false };
}

/**
 * Run one sweep: resume (or cold-start / reset), page through new edges and
 * comments, emit what qualifies, and persist the position.
 *
 * Every dependency is injected so this is testable without a daemon, a database, or
 * a clock. Returns a summary rather than logging — the caller owns observability.
 */
export function runSweep({
  source,
  cursorPath,
  teams,
  botUserIds,
  emit,
  maxBatches = DEFAULT_MAX_BATCHES,
  resetLookbackMs = DEFAULT_RESET_LOOKBACK_MS,
  now = () => Date.now(),
  readCursorFn = readCursor,
  writeCursorFn = writeCursor,
} = {}) {
  const read = readCursorFn(cursorPath);
  const start = resolveStartPosition(read, { now, resetLookbackMs });
  const counts = emptyCounts();
  // `since` from a cold-start/reset is a timestamp with no row identity; "" sorts
  // before every id, so the first page is inclusive of that instant.
  let position = { lastCreatedAt: start.since, lastId: read?.position?.lastId ?? "" };

  let batches = 0;
  let stopped = false;
  const advance = (handled) => {
    const next = source.positionAfter(handled);
    if (!next) return false;
    position = next;
    try {
      writeCursorFn(cursorPath, position);
    } catch (err) {
      // A cursor we cannot persist means the next boot re-reads this window. That
      // is survivable (re-emission, bounded) and must not stop the sweep — but it
      // is NOT silent.
      note(counts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
    }
    return true;
  };

  while (batches < maxBatches && !stopped) {
    batches += 1;
    const page = source.edgesSince(position);
    if (page.length === 0) break;
    const res = processPage(page, {
      classify: (item) => classifyEdge(item, { teams, botUserIds }),
      build: (item) => buildIssueEvent(item),
      emit,
      counts,
    });
    stopped = res.stopped;
    if (!advance(res.handled) && res.handled.length === 0) break;
  }

  // Comments share the cursor's shape but not its position; they are a separate
  // stream and are swept only after edges, so a comment storm cannot starve the
  // dispatch trigger.
  const commentCounts = emptyCounts();
  let commentPosition = { lastCreatedAt: position.lastCreatedAt, lastId: "" };
  if (!stopped) {
    const page = source.commentsSince(commentPosition);
    if (page.length > 0) {
      processPage(page, {
        classify: (item) =>
          item?.issue?.team_key && teams?.has?.(item.issue.team_key)
            ? { emit: true, reason: "ok" }
            : { emit: false, reason: item?.issue?.team_key ? "foreign-team" : "unjoinable-issue" },
        build: (item) => buildCommentEvent(item),
        emit,
        counts: commentCounts,
      });
    }
  }

  return {
    mode: start.mode,
    alarm: start.alarm,
    batches,
    stoppedEarly: stopped,
    position,
    edges: counts,
    comments: commentCounts,
  };
}
