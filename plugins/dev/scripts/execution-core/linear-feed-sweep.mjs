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
//
// ── TWO COUNTERS, BECAUSE ONE OF THEM GATES ENFORCE (CTL-1909) ──────────────
// That warning was stated here and then contradicted one module away. Declines and
// failures both landed in a single `byReason` map, and `cloud-feed-timer`'s
// readiness gate disqualified the producer on ANY entry in it — so the sweep's most
// common HEALTHY outcome un-armed enforce. Measured live on both minis 2026-08-17:
// `{"unready":[{"reason":"edges:foreign-team"}]}` within two minutes of boot, from
// ordinary CTC activity. The feed could only be armed on a tick that examined zero
// foreign-team rows, which on a busy multi-team workspace is a minority of ticks —
// making "turn smee off" structurally unreachable.
//
// So the outcome maps are SPLIT, and the split is by MEANING at the call site, not
// by matching reason strings at the reader:
//
//   decline(counts, reason) → counts.declined + counts.byReason
//       The producer examined a row and deliberately produced nothing. Healthy,
//       expected, unbounded in volume. Reported, never disqualifying.
//   fail(counts, reason)    → counts.failed   + counts.byFailure
//       The producer could not do its job. Always disqualifying, and a reason
//       string invented in 2027 still disqualifies because the SITE chose `fail`.
//
// Adding a new decline reason therefore needs no reader change (the old design's
// virtue) and adding a new failure reason needs no reader change either (the old
// design's bug). The one judgement is which helper to call, made where the outcome
// is actually known.
//
// ⛔ The line between them is NOT "is this row unusual". It is: **would un-arming
// repair it?** A malformed row (`unjoinable-issue`, `issue-has-no-team-key`) is a
// decline: the feed produces nothing for that row, but neither would smee's copy
// survive the same downstream team scoping, and un-arming forever over one bad row
// is the very pathology this ticket removes. A producer that cannot emit for ANY
// row (`no-team-scope-configured`) is a failure — un-arming is exactly the right
// response, because the alternative is enforce suppressing every webhook copy while
// the feed emits nothing at all.

import { buildCommentEvent, buildIssueEvent, classifyEdge } from "./linear-feed-event.mjs";
import { diffSnapshots, diffToHistoryRow, snapshotOf } from "./linear-feed-diff.mjs";
import { CURSOR_OK, DEFAULT_RESET_LOOKBACK_MS, readCursor, resolveStartPosition, writeCursor } from "./linear-feed-cursor.mjs";
import { classifyLabelMapTear, createTearTracker } from "./linear-feed-torn-read.mjs";

// CTL-1920: process-wide by default so the consecutive-tear count survives across
// ticks (one `runDiffSweep` call IS one tick). Keyed by cursorPath, so tenants can
// never borrow each other's suspicion. Injectable per call for tests.
const defaultTearTracker = createTearTracker();

/** Bound the work one sweep may do, so a large backlog cannot monopolise a tick. */
export const DEFAULT_MAX_BATCHES = 20;

const emptyCounts = () => ({ emitted: 0, declined: 0, failed: 0, examined: 0, deferred: 0, byReason: {}, byFailure: {} });

const bump = (map, reason) => {
  map[reason] = (map[reason] ?? 0) + 1;
};

/** Examined and deliberately not emitted. Counted, reported, NEVER disqualifying. */
const decline = (counts, reason) => {
  counts.declined += 1;
  bump(counts.byReason, reason);
};

/**
 * The producer could not do its job. ALWAYS disqualifying.
 *
 * ⚠️ This also folds the cursor failures into `counts.failed`, which they were not
 * in before — they were noted in `byReason` alone and relied on the reader treating
 * every entry as fatal. That reliance is what CTL-1909 removes, so a failure that
 * does not increment `failed` would now be a failure the gate cannot see.
 */
const fail = (counts, reason) => {
  counts.failed += 1;
  bump(counts.byFailure, reason);
};

/**
 * failureNameFor — `null` when a non-emitting verdict is a healthy DECLINE,
 * otherwise the name to record it under as a FAILURE.
 *
 * A verdict is a healthy decline only when it NAMED a reason. `classify`
 * returning `undefined`, `null`, or a reasonless object means the producer cannot
 * say why it produced nothing — that is not a demonstrated decline, and the whole
 * point of this gate is positive evidence. `fatal` marks a verdict whose cause is
 * the producer rather than the row.
 *
 * ⛔ Deciding and NAMING are one function on purpose. They were briefly two — a
 * `verdictIsFailure` predicate here plus `verdict?.reason || "unclassified"`
 * repeated at each of the three call sites — and the two promptly disagreed: a
 * non-string reason (`42`) was ruled unusable by the predicate and then used
 * anyway as the census key, because `42 || "unclassified"` is `42`. That is the
 * same shape as the bug this ticket fixes (two places holding one meaning, one of
 * them wrong), one level down, so the naming lives where the decision is made and
 * a caller cannot supply its own.
 */
const failureNameFor = (verdict) => {
  if (verdict?.fatal === true) {
    // A fatal verdict is trusted for its NAME only if it also named itself
    // usably; the flag alone is what makes it a failure.
    return typeof verdict.reason === "string" && verdict.reason.length > 0 ? verdict.reason : "unclassified";
  }
  if (typeof verdict?.reason !== "string" || verdict.reason.length === 0) return "unclassified";
  return null; // named, non-fatal ⇒ a healthy decline
};

/**
 * ⛔ A producer with no team scope declines EVERY row — with `teams` absent as
 * `no-team-scope-configured`, and with `teams` merely EMPTY as `foreign-team`,
 * which since the split above is a healthy decline. So an empty scope would arm
 * enforce while emitting nothing for anybody: smee suppressed, feed silent.
 *
 * Production is already covered one layer up (`linear-feed-run.mjs` `planTenants`
 * returns `skip: "no-registered-teams"`, and a skipped tenant never arms). This
 * closes the same hole at the module boundary, where the split is made — a public
 * export must not depend on a caller it cannot see for the invariant its own
 * counters assert.
 */
function teamScopeFailure(teams) {
  if (!teams || typeof teams.has !== "function") return "no-team-scope-configured";
  if (typeof teams.size === "number" && teams.size === 0) return "empty-team-scope";
  return null;
}

function noTeamScopeResult(reason) {
  const counts = emptyCounts();
  fail(counts, reason);
  return {
    mode: "no-team-scope",
    alarm: {
      severity: "error",
      reason,
      message:
        "the producer has no team scope, so it would decline every row and emit nothing — refusing to sweep rather than advancing the cursor past edges it will never emit",
    },
    batches: 0,
    stoppedEarly: true,
    edges: counts,
    comments: emptyCounts(),
  };
}

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
      const failureName = failureNameFor(verdict);
      if (failureName) {
        // Producer-level, or unexplained. Do NOT settle it: the cursor must not
        // move past a row we never emitted and cannot account for.
        fail(counts, failureName);
        return { handled, stopped: true };
      }
      decline(counts, verdict.reason);
      handled.push(item); // examined and settled — the cursor MUST move past it
      continue;
    }
    let event;
    try {
      event = build(item);
    } catch (err) {
      fail(counts, `build-failed:${err?.message ?? "unknown"}`);
      return { handled, stopped: true };
    }
    try {
      emit(event, item);
    } catch (err) {
      fail(counts, `emit-failed:${err?.message ?? "unknown"}`);
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
  const scopeFailure = teamScopeFailure(teams);
  if (scopeFailure) return noTeamScopeResult(scopeFailure);
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
      fail(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
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
      fail(counts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
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

/** Max issues the label sweep will process in one tick (Codex P2, #3446). */
export const DEFAULT_LABEL_BUDGET = 200;

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
  // Injected so the FATAL-verdict branch below is reachable from a test. It is
  // otherwise unreachable by construction — `teamScopeFailure` pre-empts the only
  // fatal verdict `classifyEdge` can currently return — and an unreachable guard
  // is one nothing can prove still works. The branch is kept because the next
  // fatal verdict added to `classifyEdge` would otherwise be silently demoted to a
  // healthy decline, which is CTL-1909 all over again.
  classifyFn = classifyEdge,
  labelBudget = DEFAULT_LABEL_BUDGET,
  // CTL-1920. Injected so a test can drive the multi-tick overrule deterministically
  // without a module-global leaking between cases.
  tornTracker = defaultTearTracker,
  tornThresholds = null,} = {}) {
  // Checked BEFORE the store or the cursor is touched: a scopeless producer must
  // not seed a baseline it will then decline every row against.
  const scopeFailure = teamScopeFailure(teams);
  if (scopeFailure) return noTeamScopeResult(scopeFailure);
  const counts = emptyCounts();

  // ⛔ A MISSING BASELINE + A LIVE CURSOR IS A LOSS, NOT A FIRST RUN
  // (Codex P1 round 5). If the last-seen DB is deleted after the producer has
  // been emitting while the cursor survives, seeding here would snapshot the
  // CURRENT replica, advance the cursor, and emit nothing — absorbing every
  // change since the former baseline into the new snapshot, permanently. The
  // cursor is the durable evidence that we had a baseline: its presence turns
  // this from "first seed" into a reportable failure.
  if (!store.isSeeded() && readCursorFn(cursorPath)?.state === CURSOR_OK) {
    const counts = emptyCounts();
    fail(counts, "baseline-lost-with-live-cursor");
    return {
      mode: "baseline-lost",
      alarm: {
        severity: "error",
        reason: "baseline-lost-with-live-cursor",
        message:
          "last-seen baseline is missing but the cursor is intact — refusing to reseed, which would absorb every change since the old baseline into a fresh snapshot and emit nothing",
      },
      batches: 0,
      stoppedEarly: true,
      edges: counts,
      comments: emptyCounts(),
    };
  }
  if (!store.isSeeded()) {
    const seed = seedBaseline({ source, store });
    // The watermark starts at the seed's own high-water mark: everything at or
    // before it is already IN the baseline, so re-reading it would diff each issue
    // against itself and emit nothing — wasted work, not incorrect.
    if (seed.position && Number.isInteger(seed.position.lastCreatedAt)) {
      try {
        writeCursorFn(cursorPath, seed.position);
      } catch (err) {
        fail(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
      }
    }
    return { mode: "seeded", alarm: null, seeded: seed.seeded, complete: seed.complete, batches: seed.batches, edges: counts };
  }

  // Durable, cursor-independent knowledge that this producer has emitted before.
  // Losing the cursor file must not also lose the fact that we had one.
  const hasRunBefore = (() => {
    try {
      return store?.isSeeded?.() === true;
    } catch {
      return false; // unreadable store ⇒ treat as first run (the conservative read)
    }
  })();
  const read = readCursorFn(cursorPath);
  const start = resolveStartPosition(read, { now, resetLookbackMs, everRan: hasRunBefore });
  let position = { lastCreatedAt: start.since, lastId: read?.position?.lastId ?? "" };
  if (start.mode !== "resume") {
    try {
      writeCursorFn(cursorPath, position);
    } catch (err) {
      fail(counts, `cursor-init-failed:${err?.code ?? err?.message ?? "unknown"}`);
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
        decline(counts, "no-tracked-change");
        store.put(row.issue.id, after, row.issue.updated_at);
        handled.push(row);
        continue;
      }
      const history = diffToHistoryRow(row.issue, diff, { now });
      const item = { history, issue: row.issue, actor: null, assignee: null, project: row.project, labels: row.labels };
      const verdict = classifyFn(item, { teams, botUserIds });
      if (!verdict?.emit) {
        const failureName = failureNameFor(verdict);
        if (failureName) {
          // Producer-level or unexplained: do NOT snapshot and do NOT settle.
          // Absorbing the row into the baseline would destroy the `before` this
          // edge must be re-derived from once the producer is repaired.
          fail(counts, failureName);
          stopped = true;
          break;
        }
        decline(counts, verdict.reason);
        store.put(row.issue.id, after, row.issue.updated_at);
        handled.push(row);
        continue;
      }
      try {
        emit(buildIssueEvent(item), item);
      } catch (err) {
        fail(counts, `emit-failed:${err?.message ?? "unknown"}`);
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
        fail(counts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
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
    const cStart = resolveStartPosition(cRead, { now, resetLookbackMs, everRan: hasRunBefore });
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
        fail(commentCounts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
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
          fail(commentCounts, `cursor-write-failed:${err?.code ?? err?.message ?? "unknown"}`);
        }
      }
    }
  }

  // ── CTL-1904: the LABEL SWEEP ───────────────────────────────────────────────
  // Runs AFTER the issue sweep, deliberately. Any issue whose labels changed AND
  // whose `updated_at` advanced has already been handled above — its snapshot now
  // holds the new labels, so it produces no difference here and cannot
  // double-emit. What is left is exactly the case the cursor cannot reach: label
  // rows that landed after the cursor passed the issue's timestamp.
  //
  // Compares the WHOLE label map against the baseline rather than keyseting,
  // because `issue_labels` has no timestamp and its rowid would catch inserts
  // while silently missing removals. Cost measured on the live replica: 1.7 ms
  // warm / 11.9 ms cold for 2,843 labelled issues.
  const labelCounts = emptyCounts();
  if (!stopped && typeof source.labelSets === "function" && typeof source.issuesByIds === "function") {
    try {
      const current = source.labelSets();
      const changed = [];

      // (a) issues that HAVE labels now — differing from the baseline?
      for (const [issueId, labels] of current) {
        const before = store.get(issueId);
        if (!before) continue; // not baselined yet; the issue sweep owns first sight
        const prev = Array.isArray(before.labels) ? [...before.labels].sort() : [];
        if (prev.join("\u001f") !== labels.join("\u001f")) changed.push(issueId);
      }
      // (b) issues whose LAST label was removed — absent from the map entirely,
      // which is why absence must mean "empty set" and not "unknown". Without
      // this branch, removing every label from an issue would be undetectable.
      //
      // ⛔ CTL-1920: this branch is also exactly what a TORN REPLICA READ looks
      // like. A writer re-seed truncates `issue_labels` and repopulates it in
      // batches with no reader isolation, so a tick landing mid-re-seed finds every
      // baselined issue "absent" and reads it as "all labels removed". Collected
      // separately from (a) precisely so its magnitude can be judged — (a) cannot
      // produce this shape, because an issue must still be IN the map to appear
      // there at all.
      const vanished = [];
      const baselinedWithLabels = store.idsWithLabels ? [...store.idsWithLabels()] : [];
      for (const issueId of baselinedWithLabels) {
        if (!current.has(issueId)) vanished.push(issueId);
      }

      const tearKey = cursorPath ?? "default";
      const tear = classifyLabelMapTear({
        vanished: vanished.length,
        baselinedWithLabels: baselinedWithLabels.length,
        consecutiveTorn: tornTracker.get(tearKey),
        ...(tornThresholds ?? {}),
      });
      tornTracker.set(tearKey, tear.torn ? tear.nextConsecutive : 0);

      if (tear.torn && !tear.accept) {
        // Skip the ENTIRE pass — no emit, and critically no `store.put`, so the
        // baseline keeps its pre-tear truth. Re-snapshotting here (the first-seed
        // precedent) would bake the torn state IN and guarantee a second wave when
        // the replica is restored — that is the other half of the measured 200+200.
        //
        // Routed through `fail` so readiness un-arms (a replica mid-rebuild is
        // genuinely not dispatchable, and smee stays authoritative meanwhile) and so
        // the reason is NAMED in the census rather than presenting as a
        // suspiciously quiet clean sweep.
        fail(labelCounts, tear.reason);
        labelCounts.tornVanished = vanished.length;
        return {
          mode: start.mode,
          alarm: start.alarm,
          batches,
          stoppedEarly: stopped,
          position,
          edges: counts,
          comments: commentCounts,
          labels: labelCounts,
        };
      }
      // Held for `sustainedTicks` and then overruled as a genuine mass removal, which
      // is emitted in full. Recorded rather than `fail`ed: a real change must not
      // un-arm enforce.
      if (tear.torn && tear.accept) labelCounts.tornOverruled = vanished.length;
      // The fail-open degradation must not be readable as a clean tick.
      if (tear.reason === "torn-check-uncomputable") fail(labelCounts, tear.reason);
      changed.push(...vanished);

      labelCounts.examined = changed.length;

      // ⛔ PER-TICK BUDGET (Codex P2). A label RENAME or a bulk edit changes many
      // issues at once, and this pass sits outside the issue sweep's `maxBatches`
      // bound — so it would drain the whole set synchronously on the daemon event
      // loop. Measured at ~2.4 s for 2,843 changed issues, which is a real stall
      // for unrelated scheduler work (and compounds with CTL-1903's full-scan).
      //
      // The remainder needs no bookkeeping: the sweep recomputes the difference
      // from the baseline every tick, so anything left over is simply picked up
      // next tick. Deferral is bounded work, not lost work.
      const budget = Number.isInteger(labelBudget) && labelBudget > 0 ? labelBudget : DEFAULT_LABEL_BUDGET;
      const slice = changed.slice(0, budget);
      // ⚠️ Reported in its own field, NOT via `fail` — a paced sweep is healthy
      // operation, not a failure. (Pre-CTL-1909 this said "not in byReason",
      // because byReason was then the disqualifying map; the field is kept
      // separate from the decline census too, since nothing was examined.)
      // A sweep that never drains shows up as `deferred` staying
      // above zero every tick, which is observable without un-arming enforce on
      // every bulk edit.
      labelCounts.deferred = Math.max(0, changed.length - slice.length);

      if (slice.length > 0) {
        for (const item of source.issuesByIds(slice)) {
          const issueId = item?.issue?.id;
          if (!issueId) continue;
          const before = store.get(issueId);
          const after = snapshotOf(item.issue, item.labels);
          const diff = diffSnapshots(before, after);
          if (!diff) {
            // The issue sweep already caught it in this same tick.
            store.put(issueId, after, item.issue.updated_at ?? null);
            continue;
          }
          const history = diffToHistoryRow(item.issue, diff, { now });
          const verdict = classifyFn({ history, issue: item.issue }, { teams, botUserIds });
          if (!verdict?.emit) {
            const failureName = failureNameFor(verdict);
            if (failureName) {
              fail(labelCounts, failureName);
              break; // baseline NOT updated — same discipline as a failed emit
            }
            decline(labelCounts, verdict.reason);
            store.put(issueId, after, item.issue.updated_at ?? null);
            continue;
          }
          try {
            emit(buildIssueEvent({ history, issue: item.issue, labels: item.labels, project: item.project }));
            labelCounts.emitted += 1;
            // Snapshot only AFTER a successful emit — same last-contiguous-success
            // discipline as the issue sweep, so a failed emit is retried next tick
            // instead of being absorbed into the baseline.
            store.put(issueId, after, item.issue.updated_at ?? null);
          } catch (err) {
            fail(labelCounts, `emit-failed:${err?.code ?? err?.message ?? "unknown"}`);
            break;
          }
        }
      }
    } catch (err) {
      // Named, never swallowed: a `byFailure` entry disqualifies readiness, so a
      // broken label sweep un-arms enforce rather than quietly reintroducing the
      // blind spot it exists to close.
      fail(labelCounts, `label-sweep-failed:${err?.code ?? err?.message ?? "unknown"}`);
    }
  }

  return { mode: start.mode, alarm: start.alarm, batches, stoppedEarly: stopped, position, edges: counts, comments: commentCounts, labels: labelCounts };
}
