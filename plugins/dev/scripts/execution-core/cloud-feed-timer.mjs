// cloud-feed-timer.mjs — CTL-1847. Runs the cloud-feed producer INSIDE the
// execution-core daemon, on a timer, and routes what it produces by mode.
//
// Until this landed the producer was a hand-started `bun linear-feed-shadow-run.mjs`
// on one host, with its 11 modules sitting UNTRACKED in that host's plugin-source.
// It survived `plugin-refresh`'s `reset --hard` only because that leaves untracked
// files alone; a `git clean -fd` would have deleted the producer and every shadow
// number we had. Moving the loop into the daemon is what makes the thing
// reproducible on a host that was merely updated, rather than hand-fed.
//
// ── THE THREE MODES ──
//   off      the producer does not run. No timer, no replica reads, no writes.
//            The default, so merging this into a live dispatch path is a no-op
//            on every host until an operator says otherwise.
//   shadow   the producer runs and writes its events to the shadow sink, and
//            for each dispatch-class event emits `cloud-feed.would-dispatch`
//            naming what the daemon WOULD have dispatched. smee still drives
//            every real dispatch, unchanged.
//   enforce  the producer's events are appended to the unified event log, where
//            monitor.mjs's existing tail picks them up and dispatches them
//            through the SAME three handlers as before. smee's copies are
//            suppressed by cloud-feed-gate and written to the capture sink.
//
// ⚠️ In enforce the producer writes to BOTH the event log and the shadow sink.
// That is not a redundant write: the shadow file is the parity harness's
// feed-side input, so writing it in both modes is what lets the harness read
// identically before and after the flip. An instrument that changes shape at
// the moment of cutover cannot be used to judge the cutover.

import { appendFileSync } from "node:fs";
import { getEventLogPath, log } from "./config.mjs";
import { buildCanonicalEvent } from "./lib/canonical-event.mjs";
import { planTenants, runOnce } from "./linear-feed-run.mjs";
import { createShadowSink } from "./linear-feed-shadow.mjs";
import { isDispatchClass, ticketOf } from "./cloud-feed-gate.mjs";
import { getEventName } from "../lib/event-name.mjs";

export const EVENT_WOULD_DISPATCH = "cloud-feed.would-dispatch";

/**
 * appendEventLine — one line to the unified event log.
 * Fail-open and COUNTED by the caller; a failed append must never wedge the tick.
 */
function appendEventLine(event, { eventLogPath = null, appendFn = appendFileSync } = {}) {
  const path = eventLogPath ?? getEventLogPath();
  appendFn(path, `${JSON.stringify(event)}\n`);
}

/**
 * buildWouldDispatchEvent — the shadow-mode observation.
 *
 * Deliberately a DIFFERENT name from the event it describes. Re-emitting
 * `linear.issue.state_changed` with a "shadow: true" flag would fire every
 * `wait-for` subscriber and the monitor's own handlers on an event we are
 * explicitly declining to act on — the same reasoning that gives the CTL-1809
 * oversized-line tombstone its own name instead of the dropped event's.
 */
export function buildWouldDispatchEvent(produced, { account } = {}) {
  const name = getEventName(produced);
  const ticket = ticketOf(produced);
  return buildCanonicalEvent({
    name: EVENT_WOULD_DISPATCH,
    attributes: {
      "cloud_feed.would_dispatch.name": name,
      ...(ticket ? { "linear.issue.identifier": ticket } : {}),
      ...(account ? { "cloud_feed.account": account } : {}),
    },
    payload: {
      wouldDispatch: name,
      ticket,
      account: account ?? null,
      teamKey: produced?.attributes?.["linear.team.key"] ?? null,
      producedTs: produced?.ts ?? null,
    },
  });
}

/**
 * createModeSink — the per-tenant sink `runOnce` will emit through.
 *
 * shadow  → shadow file, plus a would-dispatch observation per dispatch-class event
 * enforce → shadow file (harness input) AND the unified event log (dispatch)
 */
export function createModeSink(
  plan,
  { mode, eventLogPath = null, appendFn = appendFileSync, makeShadow = createShadowSink } = {}
) {
  const shadow = makeShadow({ path: plan.shadowPath });
  let logged = 0;
  let observed = 0;
  let failed = 0;

  return {
    path: shadow.path,
    emit(event) {
      // The shadow write happens FIRST and is allowed to throw: the sweep's
      // last-contiguous-success cursor rule depends on that throw to avoid
      // advancing past an event it never durably recorded.
      shadow.emit(event);

      if (!isDispatchClass(event)) return;

      if (mode === "enforce") {
        // ⛔ DELIBERATELY NOT CAUGHT (Codex P1, #3439).
        //
        // In enforce this append IS the dispatch. Swallowing a failure here
        // would let `processPage` treat the emission as settled, advance the
        // issue baseline / comment cursor past this edge, and never retry it —
        // while the gate simultaneously suppresses smee's copy. The edge would
        // reach nothing, permanently, with a counter and a warning as the only
        // trace. Counting a loss is not preserving it.
        //
        // Letting it throw is what engages the sweep's last-contiguous-success
        // rule: the cursor stays put and the next tick re-emits. Same reasoning
        // as the shadow sink's throw immediately above — and the opposite of
        // cloud-feed-capture.mjs, which is fail-open precisely because it is
        // evidence and must never be load-bearing for the thing it observes.
        appendEventLine(event, { eventLogPath, appendFn });
        logged += 1;
        return;
      }

      try {
        appendEventLine(buildWouldDispatchEvent(event, { account: plan.account }), {
          eventLogPath,
          appendFn,
        });
        observed += 1;
      } catch (err) {
        // Shadow only. The would-dispatch line is pure telemetry — nothing
        // dispatches from it and smee is still authoritative — so losing one
        // must not stall the producer's cursor. Counted, and warned, because a
        // silent observation gap would make the window look quieter than it was.
        failed += 1;
        log.warn?.(
          { mode, err: err?.message ?? String(err) },
          "cloud-feed: would-dispatch append failed (observation lost, dispatch unaffected)"
        );
      }
    },
    stats() {
      return { ...shadow.stats(), logged, observed, appendFailed: failed };
    },
  };
}

/**
 * startCloudFeedTimer — start the producer tick. Returns a { stop } handle,
 * or null when the mode is off (no timer, nothing scheduled).
 *
 * Every dependency is injectable so the tick is testable without a replica,
 * a clock, or a daemon.
 */
export function startCloudFeedTimer({
  mode = "off",
  intervalSec = 30,
  orchDir,
  botUserIds,
  eventLogPath = null,
  appendFn = appendFileSync,
  plans = null,
  runOnceFn = runOnce,
  planTenantsFn = planTenants,
  makeSink = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onReport = null,
} = {}) {
  if (mode !== "shadow" && mode !== "enforce") return null;

  const sinkFactory =
    makeSink ?? ((plan) => createModeSink(plan, { mode, eventLogPath, appendFn }));

  let resolvedPlans = plans;
  // ⛔ READINESS (Codex P1, #3439). `enforce` must not suppress smee until this
  // producer can actually produce. runDiffSweep's FIRST tick on an unseeded host
  // only seeds the baseline (mode "seeded") and emits nothing — and its comment
  // cursor is not cold-started until the tick after that. A gate armed before
  // then absorbs issue changes into the baseline silently and loses comments in
  // the gap permanently. So: ready only once a tenant has completed a real,
  // non-seeding sweep. Starts false, and never goes back to false — a later
  // failing tick is a transient the sweep's own cursor rules already handle,
  // whereas un-arming would flap dispatch between two sources.
  let ready = false;
  const tick = () => {
    try {
      if (!resolvedPlans) resolvedPlans = planTenantsFn({ orchDir, mode: "diff" });
      const reports = runOnceFn({
        orchDir,
        plans: resolvedPlans,
        // ⛔ botUserIds is passed HERE and was never passed by the standalone
        // shadow runner, so classifyEdge's self-echo decline has not once
        // fired in any shadow window to date. Comments stay deliberately
        // unfiltered — Ryan's CTL-1891 call is that agent-authored comments
        // are the payload, not noise.
        botUserIds,
        makeSink: sinkFactory,
      });
      // ⛔ A RE-SEED UN-ARMS. Found by answering my own round-5 question rather
      // than by review: `seeded` means "baseline built", not "has emitted".
      // If the last-seen store is lost AFTER enforce armed, the next tick
      // re-seeds — emitting nothing, absorbing every intervening change into
      // the new baseline — while a latched readiness keeps the gate suppressing
      // smee's copies. Those events reach nobody, exactly like the vanished
      // cursor case.
      //
      // This is the one thing that legitimately reverts readiness. The earlier
      // "never un-arm" rule was about TRANSIENT failures, where flapping between
      // sources buys nothing; a re-seed is not transient, it is a genuine loss
      // of the producer's state. Un-arming is safe by construction: the gate
      // makes smee authoritative again AND keeps suppressing feed events, so no
      // double-dispatch is possible in either posture.
      if (ready && Array.isArray(reports) && reports.some((r) => r?.sweep?.mode === "seeded")) {
        ready = false;
        log.warn?.(
          { mode },
          "cloud-feed: producer RE-SEEDED after arming — un-arming, smee is authoritative again",
        );
      }
      if (!ready && Array.isArray(reports)) {
        // A tenant that is skipped, errored, or still seeding does NOT arm it.
        // ⛔ A ZERO-FAILURE sweep, not merely a non-seeding one (Codex P1 round 2).
        // runDiffSweep CATCHES an emit failure and returns `stoppedEarly: true`
        // with non-zero `failed` counts — it does NOT set `r.error`. So a sweep
        // that emitted nothing at all (a persistent shadow-path EACCES, say)
        // still reports mode "resume", and the previous predicate armed enforce
        // on it: every dispatch-class event captured, nothing delivered in its
        // place, total dispatch outage with the gate reporting itself healthy.
        // ⛔ READINESS IS DERIVED POSITIVELY, NOT BY ENUMERATING FAILURES.
        //
        // Three review rounds each found a new way for a sweep to emit nothing
        // while every failure counter I was checking read zero: stoppedEarly
        // without r.error, `cursor-write-failed:*` never touching `failed`, and
        // then a SECOND cursor reason `cursor-init-failed:*` my prefix match
        // missed. Each fix was locally correct and the class kept producing new
        // instances — the signature of safety enforced by a list that is only as
        // good as what its author thought of.
        //
        // So the predicate no longer asks "was any known failure reported?" It
        // asks "did this sweep demonstrably do its job?":
        //   1. it got past seeding,
        //   2. it ran to completion (not stoppedEarly),
        //   3. NOTHING was reported in byReason — any reason at all, known or
        //      not, disqualifies. A future reason string needs no code change
        //      here to be respected, which is the whole point,
        //   4. and no failure counter is set.
        //
        // The cost is that a benign future reason could delay arming. That is
        // the correct direction: a late arm keeps smee authoritative, an early
        // arm suppresses smee with nothing behind it.
        const clean = (counts) =>
          counts != null &&
          (counts.failed ?? 0) === 0 &&
          Object.keys(counts.byReason ?? {}).length === 0;
        const swept = (r) =>
          r &&
          !r.skipped &&
          !r.error &&
          r.sweep &&
          r.sweep.mode !== "seeded" &&
          r.sweep.stoppedEarly !== true &&
          clean(r.sweep.edges) &&
          clean(r.sweep.comments);
        ready = reports.some(swept);
        if (ready) log.info?.({ mode }, "cloud-feed: producer armed (baseline seeded, emitting)");
      }
      if (onReport) onReport(reports);
      return reports;
    } catch (err) {
      // A throwing tick must never take the daemon down with it.
      log.warn?.({ err: err?.message ?? String(err) }, "cloud-feed: tick failed");
      return null;
    }
  };

  const handle = setIntervalFn(tick, Math.max(5, intervalSec) * 1000);
  if (typeof handle?.unref === "function") handle.unref();

  return {
    tick, // exposed so a caller (and the tests) can drive one sweep synchronously
    // The gate's arming probe. Passed to decideDispatch as `isReady`; absent or
    // false keeps enforce on shadow routing (smee authoritative).
    isReady: () => ready,
    stop() {
      clearIntervalFn(handle);
    },
  };
}
