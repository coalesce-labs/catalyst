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

      try {
        if (mode === "enforce") {
          appendEventLine(event, { eventLogPath, appendFn });
          logged += 1;
        } else {
          appendEventLine(buildWouldDispatchEvent(event, { account: plan.account }), {
            eventLogPath,
            appendFn,
          });
          observed += 1;
        }
      } catch (err) {
        // Fail-open but COUNTED. In enforce a failed append means a real edge
        // did not reach dispatch, which is exactly the thing the operator must
        // be able to see — so it is a warn, not a debug.
        failed += 1;
        log.warn?.(
          { mode, err: err?.message ?? String(err) },
          "cloud-feed: event-log append failed"
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
    stop() {
      clearIntervalFn(handle);
    },
  };
}
