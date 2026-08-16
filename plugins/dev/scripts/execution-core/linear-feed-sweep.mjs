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
import { diffSnapshots, diffToHistoryRow, snapshotOf } from "./linear-feed-diff.mjs";
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

  // ⛔ ESTABLISH THE POSITION IMMEDIATELY on a cold start or reset, before sweeping.
  // Found by running the producer, not by a test: `positionAfter` returns null for an
  // empty page, so a sweep that finds nothing writes NO cursor — and the next sweep
  // cold-starts again from a FRESH `now`. Every sweep reported `mode: cold-start`
  // forever, and worse, the interval between one sweep's `now` and the next one's is
  // never queried by anything: with a 60s tick that is a permanent 60s blind spot,
  // repeated. A producer whose whole job is not to lose edges was dropping every edge
  // that arrived between ticks until its first non-empty page.
  //
  // Persisting `since` up front is safe precisely BECAUSE of what these modes mean:
  // cold-start deliberately declines to replay history, and reset's bound is already
  // stated — so there is nothing before `since` that we intended to sweep.
  if (start.mode !== "resume") {
    try {
      writeCursorFn(cursorPath, position);
    } catch (err) {
      note(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
    }
  }

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
  //
  // ⛔ DELIBERATE: comments are scoped by TEAM ONLY — the `botUserIds` self-echo
  // guard is NOT applied here, unlike the edge path above. Do not "fix" the
  // asymmetry for consistency; it is the point. Ryan's decision on CTL-1891:
  // "we want fleet agents communicating with each other over the activity feed so
  // cant ignore all non human coments" — Linear activities/comments become the
  // fleet's comms channel, replacing the comms md files. Bot-authored comments are
  // therefore the PAYLOAD, not noise, and filtering them here would delete the
  // messages the channel exists to carry.
  //
  // Echo suppression for that channel is expected to key on write receipts /
  // session identity rather than "is a bot" (CTL-1892 covers why an identity-set
  // must survive rotation). Until that lands, the edge path's filter stays
  // provisional and this path stays unfiltered.
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

// ── THE ISSUES-DIFF SWEEP (CTL-1847) ────────────────────────────────────────
// Replaces the history sweep above as the DISPATCH source; the history sweep stays
// for the parity harness's explanatory side. See linear-feed-diff.mjs for why
// (issue_history is reconcile-only: 201s vs 11s measured, and empty for 140 issues).


/** Bound one seeding pass so a cold start cannot monopolise a tick indefinitely. */
export const SEED_MAX_BATCHES = 200;

/**
 * Establish the baseline WITHOUT emitting anything.
 *
 * ⛔ This is the cold-start safety. With no baseline every issue diffs against null
 * and looks like a brand-new edge — a first tick would invent one for every issue in
 * the replica (~4,000 here). Seeding is not "missing the first edge"; it is
 * declining to fabricate thousands of them.
 *
 * `markSeeded` runs only AFTER the last page is written, so an interrupted seed
 * leaves the store un-seeded and the next tick starts over — a partial baseline is
 * not a baseline, and `count > 0` cannot tell the two apart.
 */
export function seedBaseline({ source, store, batchLimit, maxBatches = SEED_MAX_BATCHES } = {}) {
  let position = { lastCreatedAt: 0, lastId: "" };
  let seeded = 0;
  let batches = 0;
  while (batches < maxBatches) {
    batches += 1;
    const page = source.issuesSince(position, batchLimit);
    if (page.length === 0) break;
    store.putMany(
      page.map((r) => ({
        issueId: r.issue.id,
        snapshot: snapshotOf(r.issue, r.labels),
        updatedAt: r.issue.updated_at,
      })),
    );
    seeded += page.length;
    const next = source.positionAfter(page);
    if (!next) break;
    position = next;
  }
  const complete = batches < maxBatches;
  if (complete) store.markSeeded();
  return { seeded, batches, complete, position };
}

/**
 * One diff sweep: page issues changed since the watermark, derive each edge against
 * the stored baseline, emit what qualifies, and update the baseline.
 *
 * ⚠️ The baseline is updated ONLY for issues whose edge was successfully handled.
 * Updating it for an issue whose emit failed would destroy the very `before` needed
 * to re-derive that edge next tick — the change would be lost permanently, which is
 * a strictly worse failure than the duplicate a retry risks.
 */
export function runDiffSweep({
  source,
  store,
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
  const counts = emptyCounts();

  if (!store.isSeeded()) {
    const seed = seedBaseline({ source, store });
    // The watermark starts at the seed's own high-water mark: everything at or
    // before it is already IN the baseline, so re-reading it would diff each issue
    // against itself and emit nothing — wasted work, not incorrect.
    if (seed.position && Number.isInteger(seed.position.lastCreatedAt)) {
      try {
        writeCursorFn(cursorPath, seed.position);
      } catch (err) {
        note(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
      }
    }
    return { mode: "seeded", alarm: null, seeded: seed.seeded, complete: seed.complete, batches: seed.batches, edges: counts };
  }

  const read = readCursorFn(cursorPath);
  const start = resolveStartPosition(read, { now, resetLookbackMs });
  let position = { lastCreatedAt: start.since, lastId: read?.position?.lastId ?? "" };
  if (start.mode !== "resume") {
    try {
      writeCursorFn(cursorPath, position);
    } catch (err) {
      note(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
    }
  }

  let batches = 0;
  let stopped = false;
  while (batches < maxBatches && !stopped) {
    batches += 1;
    const page = source.issuesSince(position);
    if (page.length === 0) break;

    const handled = [];
    for (const row of page) {
      counts.examined += 1;
      const before = store.get(row.issue.id);
      const after = snapshotOf(row.issue, row.labels);
      const diff = diffSnapshots(before, after);
      if (!diff) {
        // The mirror rewrote the row without changing anything we track. Not an
        // event, and the baseline still advances so we don't re-examine it.
        counts.declined += 1;
        note(counts, "no-tracked-change");
        store.put(row.issue.id, after, row.issue.updated_at);
        handled.push(row);
        continue;
      }
      const history = diffToHistoryRow(row.issue, diff, { now });
      const item = { history, issue: row.issue, actor: null, assignee: null, project: row.project, labels: row.labels };
      const verdict = classifyEdge(item, { teams, botUserIds });
      if (!verdict?.emit) {
        counts.declined += 1;
        note(counts, verdict?.reason ?? "unclassified");
        store.put(row.issue.id, after, row.issue.updated_at);
        handled.push(row);
        continue;
      }
      try {
        emit(buildIssueEvent(item), item);
      } catch (err) {
        counts.failed += 1;
        note(counts, `emit-failed:${err?.message ?? "unknown"}`);
        stopped = true;
        break; // baseline NOT updated — the `before` must survive for the retry
      }
      counts.emitted += 1;
      store.put(row.issue.id, after, row.issue.updated_at);
      handled.push(row);
    }

    const next = source.positionAfter(handled);
    if (next) {
      position = next;
      try {
        writeCursorFn(cursorPath, position);
      } catch (err) {
        note(counts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
      }
    } else if (handled.length === 0) {
      break;
    }
  }

  // ⚠️ COMMENTS ARE NOT DIFFED — they are appended, so a new row IS the event.
  // The first cut of this sweep omitted them entirely, and the harness caught it
  // immediately: smee reported 14 comment.created in the window and the feed could
  // never match one. Comments swept AFTER edges so a comment storm cannot starve the
  // dispatch trigger, and on their own cursor since they are a separate stream.
  const commentCounts = emptyCounts();
  // A source without a comment reader is a valid source (some callers only care
  // about edges). Named skip rather than a throw — a missing capability must not
  // take down the edge sweep that already succeeded.
  if (!stopped && typeof source.commentsSince === "function") {
    const commentCursorPath = `${cursorPath}.comments`;
    const cRead = readCursorFn(commentCursorPath);
    const cStart = resolveStartPosition(cRead, { now, resetLookbackMs });
    let cPos = { lastCreatedAt: cStart.since, lastId: cRead?.position?.lastId ?? "" };
    if (cStart.mode !== "resume") {
      try {
        writeCursorFn(commentCursorPath, cPos);
      } catch (err) {
        // ⛔ WAS SWALLOWED ENTIRELY (Codex P1 round 3). "Noted below if it
        // recurs" is not true of the failure that matters: if this cold-start
        // write cannot land, every subsequent tick cold-starts at ITS current
        // time and permanently skips the comments created in between — and the
        // readiness gate, which reads these counts, saw nothing wrong.
        note(commentCounts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
      }
    }
    const page = source.commentsSince(cPos);
    if (page.length > 0) {
      const res = processPage(page, {
        classify: (item) =>
          item?.issue?.team_key && teams?.has?.(item.issue.team_key)
            ? { emit: true, reason: "ok" }
            : { emit: false, reason: item?.issue?.team_key ? "foreign-team" : "unjoinable-issue" },
        build: (item) => buildCommentEvent(item),
        emit,
        counts: commentCounts,
      });
      const next = source.positionAfter(res.handled);
      if (next) {
        try {
          writeCursorFn(commentCursorPath, next);
        } catch (err) {
          note(commentCounts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
        }
      }
    }
  }

  return { mode: start.mode, alarm: start.alarm, batches, stoppedEarly: stopped, position, edges: counts, comments: commentCounts };
}
