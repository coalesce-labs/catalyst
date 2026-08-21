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
import { classifyFeedHealth, readFeedProgress } from "./feed-progress.mjs"; // CTL-1902
import { getEventName } from "../lib/event-name.mjs";

export const EVENT_WOULD_DISPATCH = "cloud-feed.would-dispatch";

/** How stale the replica writer's heartbeat may be before the feed is untrustworthy. */
export const DEFAULT_REPLICA_STALE_MS = 5 * 60 * 1000;

/**
 * defaultFeedHealthy — is the FEED still being fed? (CTL-1902)
 *
 * ⛔ THIS REPLACED A WRITER-LIVENESS CHECK, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 * Round 6 required `<replica>.writer.lock`'s heartbeat to be fresh. That file is
 * written by the SDK's `CatalystReplica` and records that the writer PROCESS is
 * alive. cloud-sync.mjs calls that heartbeat **feed-independent in its own
 * comment** (~line 492) and documents the 18.5 h silent freeze where it kept
 * beating against a frozen cursor. So a half-open feed kept enforce armed while
 * live webhook copies were suppressed and no replacements were produced — the
 * exact failure round 6 was trying to close, one level in.
 *
 * The replacement asks about the feed instead: cloud-sync now publishes
 * `<db>.feed-progress.json` every telemetry tick, and `classifyFeedHealth` reads
 * inbound-frame recency off it. See feed-progress.mjs for why frame recency —
 * and NOT cursor movement — is the right signal: a healthy QUIET feed freezes the
 * cursor identically to a dead socket (reproduced live on mini-2, cursor frozen
 * at 1146621 across successive ticks with frame staleness of 5–11 s), so gating
 * on cursor movement would un-arm the producer through every quiet window.
 *
 * Fail-CLOSED, with the reason preserved: absent, unreadable, malformed, stale,
 * frame-silent, and frame-unknown all read as NOT healthy. A host whose writer
 * predates the publish therefore never arms enforce — correct, and loudly
 * diagnosable via `lastFeedHealth()` rather than an unexplained un-armed gate.
 */
export function defaultFeedHealthy(dbPath, { now = Date.now, readFileFn = readFileSync, ...opts } = {}) {
  return classifyFeedHealth(readFeedProgress(dbPath, { readFile: readFileFn }), { now: now(), ...opts }).healthy === true;
}

/**
 * defaultReplicaFresh — RETAINED as the writer-liveness probe it always was, and
 * deliberately NOT deleted: `catalyst doctor` and the replica readers still have
 * legitimate reasons to ask "is the writer process alive?". What changed is that
 * cloud-feed readiness no longer mistakes that question for "is the feed
 * arriving?". Do not re-point readiness at this.
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
 * countsClean — a sweep counts block is clean only by DEMONSTRATING it worked:
 * no failure counter and NOTHING in `byFailure`. Any FAILURE reason, known or
 * unknown, disqualifies — so a future failure reason needs no change here.
 *
 * ⛔ CTL-1909 — this read `byReason`, which is the DECLINE census, not the
 * failure one. A decline is the sweep's most common HEALTHY outcome; its own
 * module header says so ("on a multi-tenant replica ... most rows are
 * declines"). So the gate un-armed on the producer working exactly correctly —
 * measured live on both minis 2026-08-17 as
 * `{"unready":[{"account":"tenant-0","reason":"edges:foreign-team"}]}`,
 * triggered by ordinary CTC activity within two minutes of boot. The feed could
 * only arm on a tick that examined ZERO foreign-team rows, so on a busy
 * multi-team workspace `enforce` degraded to "smee, most of the time" and
 * retiring the smee tunnel was structurally unreachable.
 *
 * The two maps are now split at the emitting site by MEANING, not by matching
 * reason strings here (`linear-feed-sweep.mjs`: `decline()` → `byReason`,
 * `fail()` → `byFailure`). Both of the old design's properties are kept: a new
 * decline reason needs no change here, and a new failure reason needs none
 * either.
 *
 * ⛔ `byFailure` MUST BE PRESENT. Defaulting it (`?? {}`) would score any counts
 * block that predates the split — or any shape this gate does not recognise —
 * as perfectly clean: a check whose "nothing wrong" and "could not look" are
 * byte-identical, which is the exact defect class one level up. Absent ⇒ not
 * clean ⇒ smee stays authoritative, which is the safe direction.
 */
export function countsClean(counts) {
  if (counts == null) return false;
  if ((counts.failed ?? 0) !== 0) return false;
  if (!isFailureCensus(counts.byFailure)) return false;
  return Object.keys(counts.byFailure).length === 0;
}

/**
 * A failure census is a plain reason→count map. ⚠️ The array check is not
 * pedantry: `typeof [] === "object"` and `Object.keys([]).length === 0`, so an
 * array would sail through the obvious predicate and read as a perfect sweep.
 */
function isFailureCensus(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * countsDirtyWhy — why a counts block was NOT clean, as a short log string.
 * Reports the byFailure KEYS rather than a count of them: the reason string is
 * the actionable part. Declines are deliberately NOT reported here — they never
 * make a block dirty, so naming them would be naming an innocent bystander.
 */
export function countsDirtyWhy(counts) {
  if (counts == null) return "absent";
  const failed = counts.failed ?? 0;
  // Distinguished from "no failure reasons": an absent map means this block came
  // from a producer that does not report failures separately, so cleanliness was
  // never demonstrated. Naming it keeps the un-arm actionable.
  if (!isFailureCensus(counts.byFailure)) {
    return failed > 0 ? `failed=${failed},no-failure-census` : "no-failure-census";
  }
  const keys = Object.keys(counts.byFailure);
  if (failed > 0 && keys.length > 0) return `failed=${failed},${keys.join("|")}`;
  if (failed > 0) return `failed=${failed}`;
  return keys.join("|") || "unknown";
}

/**
 * sweepUnreadyReason — WHY this tenant's report does not arm the producer, or
 * null when it does. (CTL-1902)
 *
 * ⛔ Extracted because the un-arm alarm could not be acted on. The old predicate
 * was a bare `&&` chain and its WARN line carried `{ mode }` and nothing else;
 * the daemon also never passes `onReport`, so the reports reached no sink at
 * all. Measured on mini-2 2026-08-17: 21 un-arm episodes in 3.1 h with ZERO
 * recoverable evidence of which conjunct failed on any of them. An alarm that
 * says "unhealthy" without saying why is the same family as a check whose pass
 * and fail look identical to its caller.
 *
 * Pure: the feed-health verdict is passed IN (already computed against the
 * injectable seam) rather than resolved here. Evaluation order is identical to
 * the chain it replaces, so the verdict is unchanged — only the explanation is
 * new.
 *
 * @param {object} report            one tenant's runOnce report
 * @param {object} feedHealth        { healthy: boolean, reason?: string }
 * @returns {string|null}            null ⇒ this tenant is ready
 */
export function sweepUnreadyReason(report, feedHealth = { healthy: false, reason: "unknown" }) {
  const r = report;
  if (!r) return "no-report";
  if (r.skipped) return `skipped:${r.skipped}`;
  if (r.error) return `error:${r.error}`;
  if (feedHealth?.healthy !== true) return `feed-unhealthy:${feedHealth?.reason ?? "unknown"}`;
  if (!r.sweep) return "no-sweep";
  if (r.sweep.mode === "seeded") return "seeding";
  if (r.sweep.stoppedEarly === true) return "stopped-early";
  if (!countsClean(r.sweep.edges)) return `edges:${countsDirtyWhy(r.sweep.edges)}`;
  if (!countsClean(r.sweep.comments)) return `comments:${countsDirtyWhy(r.sweep.comments)}`;
  // CTL-1904: the label sweep counts too. `labels` is absent on a seeding tick
  // and from runSweep (the superseded history path), and absent is treated as
  // clean — a sweep that never ran a label pass is not a label pass that failed.
  // A PRESENT-and-dirty one disqualifies.
  if (r.sweep.labels !== undefined && !countsClean(r.sweep.labels)) return `labels:${countsDirtyWhy(r.sweep.labels)}`;
  return null;
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
  // ⛔ CTL-1902: this is FEED health, not writer liveness. The parameter was
  // renamed with the semantics it now carries — a caller still passing
  // `replicaFreshFn` would otherwise silently re-install the very check this
  // ticket removed, with no error and no test failure.
  feedHealthyFn = defaultFeedHealthy,
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
      // counter and NOTHING in `byFailure` — any FAILURE reason, known or
      // unknown, disqualifies, so a future one needs no change here. A DECLINE
      // does not disqualify (CTL-1909); see `countsClean` for why that is not a
      // loosening.
      // `countsClean` / `countsDirtyWhy` / `sweepUnreadyReason` are module-level
      // pure functions (above) so the readiness rule is unit-testable without a
      // replica, a clock, or a daemon.
      // A skipped tenant is NOT clean: the feed produces nothing for it, so its
      // events would be suppressed with no replacement. `mode === "seeded"` is
      // not clean either — a (re)seed emits nothing.
      // A sweep over a FROZEN replica reports zero of everything and looks
      // perfect. Readiness therefore also requires positive evidence about the
      // FEED — that this node is still being spoken to (inbound frames, incl.
      // watchdog pongs), published by cloud-sync into `<db>.feed-progress.json`.
      // ⛔ CTL-1902: this used to be `replicaFreshFn`, the writer's own heartbeat,
      // which cloud-sync.mjs documents as feed-INDEPENDENT — it kept beating
      // through an 18.5 h frozen-cursor incident. "The writer is alive" and "the
      // feed is arriving" are different questions and only the second one licenses
      // suppressing smee.
      const planFor = (acct) => resolvedPlans.find((pl) => pl.account === acct);
      // ⛔ THE PREDICATE NAMES ITS OWN FAILING CONJUNCT (CTL-1902).
      //
      // This was a bare `&&` chain feeding `reports.every(swept)`, and the
      // un-arm line it produced carried `{ mode }` and nothing else. The daemon
      // also never passes `onReport`, so the reports themselves reached no sink
      // either — measured tonight: 21 un-arm episodes on mini-2 in 3.1 h with
      // ZERO recoverable evidence of which conjunct failed on any of them. An
      // alarm that says "unhealthy" without saying why cannot be acted on, and
      // it is the same family as a check whose pass and fail look identical to
      // its caller.
      //
      // `unreadyReason` returns null when the tenant swept cleanly, else the
      // FIRST failing conjunct by name. Evaluation order is unchanged, so the
      // verdict is bit-identical to the old chain — only the explanation is new.
      const unreadyReason = (r) => {
        // The VERDICT stays on the injectable seam (so a caller's override is
        // still authoritative); the classifier is consulted only to LABEL a
        // failure the seam already returned, and a throwing explanation must
        // never change the verdict.
        const dbPath = planFor(r?.account)?.dbPath;
        const healthy = feedHealthyFn(dbPath) === true;
        let reason = "unknown";
        if (!healthy) {
          try {
            reason = classifyFeedHealth(readFeedProgress(dbPath), { now: Date.now() }).reason;
          } catch {
            /* keep "unknown" */
          }
        }
        return sweepUnreadyReason(r, { healthy, reason });
      };

      const wasReady = ready;
      const reasons =
        Array.isArray(reports) && reports.length > 0
          ? reports.map((r) => ({ account: r?.account ?? null, reason: unreadyReason(r) })).filter((x) => x.reason)
          : [{ account: null, reason: "no-tenants" }];
      ready = reasons.length === 0;
      if (wasReady && !ready) {
        log.warn?.(
          { mode, unready: reasons },
          "cloud-feed: producer NO LONGER healthy — un-arming, smee is authoritative again",
        );
      } else if (!wasReady && ready) {
        log.info?.({ mode }, "cloud-feed: producer armed (clean sweep)");
      } else if (!ready) {
        // Steady-state unready. Logged at DEBUG so a host that never arms is
        // diagnosable without a 30 s WARN drumbeat for the whole outage — the
        // count-every / warn-sparsely discipline used by otel-forward's
        // sparse-warn gate.
        log.debug?.({ mode, unready: reasons }, "cloud-feed: producer still not armed");
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
