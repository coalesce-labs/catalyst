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

import { appendFileSync, readFileSync } from "node:fs";
import { getEventLogPath, log } from "./config.mjs";
import { buildCanonicalEvent } from "./lib/canonical-event.mjs";
import { planTenants, runOnce } from "./linear-feed-run.mjs";
import { createShadowSink } from "./linear-feed-shadow.mjs";
import { isDispatchClass, ticketOf } from "./cloud-feed-gate.mjs";
import { getEventName } from "../lib/event-name.mjs";

export const EVENT_WOULD_DISPATCH = "cloud-feed.would-dispatch";

/** How stale the replica writer's heartbeat may be before the feed is untrustworthy. */
export const DEFAULT_REPLICA_STALE_MS = 5 * 60 * 1000;

/**
 * defaultReplicaFresh — is the replica still being written?
 *
 * ⛔ Round-6 finding: when cloud-sync stalls while its SQLite file stays
 * readable, every source query returns an EMPTY page — zero rows, zero failures,
 * zero `byReason` entries. A sweep over a frozen replica is indistinguishable
 * from a sweep over a quiet fleet, so readiness stayed armed and enforce went on
 * suppressing webhook copies against a producer that could not produce.
 *
 * "No errors" is not "working". The writer heartbeats into
 * `<replica>.writer.lock`, so that file is the positive evidence.
 *
 * Fail-CLOSED: absent, unreadable, malformed, or stale all read as NOT fresh.
 * A host with no writer at all therefore never arms enforce, which is correct —
 * there is nothing there to be authoritative.
 */
export function defaultReplicaFresh(dbPath, { now = Date.now, staleMs = DEFAULT_REPLICA_STALE_MS, readFileFn = readFileSync } = {}) {
  if (typeof dbPath !== "string" || dbPath === "") return false;
  try {
    const hb = JSON.parse(readFileFn(`${dbPath}.writer.lock`, "utf8"))?.heartbeat;
    if (!Number.isFinite(hb)) return false;
    return now() - hb <= staleMs;
  } catch {
    return false;
  }
}

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
  {
    mode,
    eventLogPath = null,
    appendFn = appendFileSync,
    makeShadow = createShadowSink,
    // The readiness in effect FOR THIS SWEEP. Read once per emit and STAMPED on
    // the event, never consulted again downstream.
    authorityNow = () => false,
  } = {}
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
        // ⛔ AUTHORITY IS BOUND TO THE SWEEP THAT EMITTED THIS EVENT
        // (Codex P1 round 6). The gate used to read a MUTABLE `ready` flag at
        // consumption time, which loses a race I had asserted was impossible:
        // a webhook copy dispatches while ready is false, this sweep
        // synchronously appends the feed twin, `ready` flips true before the
        // event loop runs the log watcher, and the queued twin is then consumed
        // under ready=true and dispatches AGAIN. It fires on initial arming and
        // on every recovery re-arm.
        //
        // Stamping at emission makes the decision immutable and local to the
        // sweep that produced the event: whatever happens to `ready` afterwards
        // cannot retroactively grant authority to a line already on disk.
        const stamped = {
          ...event,
          body: {
            ...event.body,
            payload: { ...(event.body?.payload ?? {}), feedAuthority: authorityNow() === true },
          },
        };
        appendEventLine(stamped, { eventLogPath, appendFn });
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
  replicaFreshFn = defaultReplicaFresh,
} = {}) {
  if (mode !== "shadow" && mode !== "enforce") return null;

  // `ready` is only ever read HERE, to stamp what this sweep emits. It is never
  // consulted at consumption time.
  const sinkFactory =
    makeSink ??
    ((plan) => createModeSink(plan, { mode, eventLogPath, appendFn, authorityNow: () => ready }));

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
      // ⛔ RE-PLAN EVERY TICK (Codex P1 round 6). The plan was resolved once at
      // startup and cached forever, so a team added to registry.json afterwards
      // was suppressed by the gate (monitor.mjs reads the LIVE registry) while
      // the feed never produced anything for it — a whole team silently
      // undispatched until the daemon restarted. planTenants is a registry read
      // and an existsSync; paying it per tick is cheaper than the failure.
      const resolvedPlans = plans ?? planTenantsFn({ orchDir, mode: "diff" });
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
      // ⛔ READINESS IS NOT LATCHED. It reflects the LAST sweep, every tick.
      //
      // I defended a latch twice and it was wrong twice. First a re-seed had to
      // break it; then (round 5) so did a plain failure — if the replica goes
      // away or the last-seen store stops opening, `runOnce` reports an error,
      // emits nothing, and a latched readiness kept enforce suppressing every
      // webhook copy INDEFINITELY. "Assume transient" is not a property you can
      // assume; it is one you would have to prove each tick, which is the same
      // thing as not latching.
      //
      // ⛔ "Flapping is harmless" — I wrote that here, and it was FALSE IN BOTH
      // DIRECTIONS (CTL-1901). With ready false the gate also suppressed feed
      // events that had ALREADY been stamped authoritative by an armed sweep,
      // while their webhook twins had already been captured under the older
      // ready=true — so the posture lost the edge outright rather than merely
      // alternating sources. Measured on mini-2 2026-08-17: 21 flaps in 3.1 h,
      // every un-arm exactly ONE tick long (29.8–30.5 s), 5.4% of wall clock
      // unarmed — routinely hit, not a rare race.
      //
      // What makes flapping safe NOW is not this flag being steady; it is that
      // cloud-feed-gate no longer consults it for feed events at all. The stamp
      // written below is the feed's whole authority, and it is read from the
      // value carried INTO this tick — the same value the webhook twin's own
      // decision was made under — so the two agree and each edge is delivered
      // exactly once. See the derivation in cloud-feed-gate.mjs's enforce block.
      //
      // ⚠️ THAT ORDERING IS LOAD-BEARING: `runOnceFn` (which emits, and whose
      // sink reads `ready` to stamp) must run BEFORE `ready` is recomputed
      // below. Sealed by cloud-feed-timer.test.mjs's "authority is sampled
      // BEFORE readiness is recomputed" block, not by this comment.
      //
      // EVERY tenant must have swept cleanly — not `some`. A healthy tenant must
      // not mask a skipped or failing one, whose events would otherwise be
      // suppressed with nothing to replace them.
      // A sweep counts as clean only by DEMONSTRATING it worked: no failure
      // counters and NOTHING in byReason — any reason, known or unknown,
      // disqualifies, so a future reason string needs no change here.
      const clean = (counts) =>
        counts != null &&
        (counts.failed ?? 0) === 0 &&
        Object.keys(counts.byReason ?? {}).length === 0;
      // A skipped tenant is NOT clean: the feed produces nothing for it, so its
      // events would be suppressed with no replacement. `mode === "seeded"` is
      // not clean either — a (re)seed emits nothing.
      // A sweep over a FROZEN replica reports zero of everything and looks
      // perfect. Readiness therefore also requires positive evidence that the
      // replica is still being written.
      const planFor = (acct) => resolvedPlans.find((pl) => pl.account === acct);
      const swept = (r) =>
        r &&
        !r.skipped &&
        !r.error &&
        replicaFreshFn(planFor(r.account)?.dbPath) === true &&
        r.sweep &&
        r.sweep.mode !== "seeded" &&
        r.sweep.stoppedEarly !== true &&
        clean(r.sweep.edges) &&
        clean(r.sweep.comments) &&
        // CTL-1904: the label sweep counts too. `labels` is absent on a seeding
        // tick and from runSweep (the superseded history path), and absent is
        // treated as clean — a sweep that never ran a label pass is not a label
        // pass that failed. A PRESENT-and-dirty one disqualifies.
        (r.sweep.labels === undefined || clean(r.sweep.labels));

      const wasReady = ready;
      ready = Array.isArray(reports) && reports.length > 0 && reports.every(swept);
      if (wasReady && !ready) {
        log.warn?.(
          { mode },
          "cloud-feed: producer NO LONGER healthy — un-arming, smee is authoritative again",
        );
      } else if (!wasReady && ready) {
        log.info?.({ mode }, "cloud-feed: producer armed (clean sweep)");
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
