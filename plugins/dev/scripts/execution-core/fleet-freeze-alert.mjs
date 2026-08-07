// fleet-freeze-alert.mjs — CTL-1420. A fleet-frozen-for-admission alert.
//
// When EVERY registered team's reconcile is in a persistent-failure (alerting)
// state at once, the eligible projection cannot be refreshed from either source:
// the local Linear replica is unavailable (stale/absent → the reader returns
// undefined) AND the live Linear API is unreachable (the CTL-679 breaker is
// pinned open). New work then cannot be admitted fleet-wide until one source
// recovers. The CTL-1420 surface-(a) fix keeps a FRESH replica serving during a
// quota storm, so this alert fires only for the residual DOUBLE outage (no fresh
// replica AND no quota) — which used to fail silently (reconcileProject just
// preserves the empty prior set). This makes it LOUD.
//
// Emits, mirroring reconcile-health-event.mjs (OTel envelope, appendFileSync,
// never throws), onto the SAME catalyst.alert.* topic the broker uses for its own
// alerts (broker/alert-emit.mjs), so the existing alert consumer picks it up:
//   catalyst.alert.raised   (event.label=fleet_frozen_admission, WARN)
//   catalyst.alert.cleared  (INFO)
// Attribution is catalyst.execution-core (the monitor observed the freeze),
// consistent with the "alerting decoupled via Loki" design and the established
// execution-core precedent (reconcile-health-event.mjs): emit intent to the
// unified event log; a separate consumer delivers. A distinct service.name (not
// catalyst.broker) also means the broker's own self-filter does not drop it.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEventLogPath, getReconcileHealthDir, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// Same topic + kind taxonomy as broker/alert-emit.mjs (event.name is the fixed
// raised/cleared topic; the kind differentiator lives in event.label).
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";
export const ALERT_KIND_FLEET_FROZEN_ADMISSION = "fleet_frozen_admission";

// CTL-1628 r3: cause classification for a raised freeze. The header comment's
// "residual DOUBLE outage" story (replica AND linearis both down) is true only
// when every frozen team's reconcile-health streak originated at the
// eligibleQuery POLL. Since CTL-1628 taught reconcile-health to also latch
// `alerting` for a persistent eligible-set DISK PERSIST fault (EACCES/ENOSPC on
// the local eligible dir — a single-host filesystem problem, not a
// replica/linearis outage), an all-teams freeze can now ALSO happen with every
// poll succeeding and every persist failing. Without distinguishing the two, an
// operator paged for "fleet frozen" would chase a replica/linearis outage that
// doesn't exist. MIXED covers a freeze where different teams hit different
// origins (e.g. one team's Linear state config broke while another's disk
// filled) — still worth a human look, but neither documented story alone.
export const FLEET_FREEZE_CAUSE_ALL_POLL = "all-poll-failing";
export const FLEET_FREEZE_CAUSE_ALL_PERSIST = "all-persist-failing";
export const FLEET_FREEZE_CAUSE_MIXED = "mixed";

const FREEZE_REASON_BY_CAUSE = {
  [FLEET_FREEZE_CAUSE_ALL_POLL]:
    "every registered team's reconcile POLL is failing — the eligible projection cannot refresh from the replica or linearis (fleet admission is frozen)",
  [FLEET_FREEZE_CAUSE_ALL_PERSIST]:
    "every registered team's eligible-set disk PERSIST is failing (poll succeeds) — likely a local filesystem fault (disk full/permissions), NOT a replica/linearis outage (fleet admission is frozen)",
  [FLEET_FREEZE_CAUSE_MIXED]:
    "every registered team's reconcile is failing, but from a MIX of poll and persist origins across teams — check each team's reconcile-health marker (fleet admission is frozen)",
};

// classifyFreezeCause — origins is a non-empty array of "poll" | "persist"
// (one per frozen team). Exported for tests; callers normally go through
// checkFleetFreeze.
export function classifyFreezeCause(origins) {
  const allPoll = origins.every((o) => o === "poll");
  if (allPoll) return FLEET_FREEZE_CAUSE_ALL_POLL;
  const allPersist = origins.every((o) => o === "persist");
  if (allPersist) return FLEET_FREEZE_CAUSE_ALL_PERSIST;
  return FLEET_FREEZE_CAUSE_MIXED;
}

// Module-scoped latch so the alert fires exactly once per raised→cleared
// transition (mirrors reconcile-health's per-team `alerting` latch, fleet-wide).
// PERSISTED to disk + hydrated on first use so a daemon RESTART mid-freeze does
// NOT re-emit `raised` with no intervening `cleared` — a fleet freeze is the
// residual double-outage state (breaker pinned open + no fresh replica), exactly
// when restarts (deploy/crash/recovery loop) are most likely. This matches
// reconcile-health, which was made restart-durable for the same reason.
let _fleetFrozenRaised = false;
// _lastEmittedCause — CTL-1628 r4: the cause classification of the most recent
// raised/cause_changed emission. Compared against a fresh classification on
// every check while still frozen so an origin DRIFT mid-freeze (e.g. the
// replica recovers but a team's local disk then fills — all-poll →
// all-persist, or either → mixed) gets its own emission instead of the one
// standing alert silently going stale with the ORIGINAL, now-wrong cause.
// PERSISTED alongside the raised latch for the same restart-durability reason.
let _lastEmittedCause = null;
let _hydrated = false;
// _persistDirty — CTL-1628 r4 post-merge: true when the most recent persist()
// attempt failed, so the on-disk marker is now STALE relative to the
// in-memory `_fleetFrozenRaised`/`_lastEmittedCause` that already advanced
// (the event for that transition already fired — advancing in-memory state
// eagerly is what makes drift detection correct on the very next tick).
// Retried at the top of every checkFleetFreeze() call until it succeeds, so a
// transient write fault (disk full) doesn't strand the marker forever — and,
// crucially, the RETRY only re-attempts the disk write, never re-emits the
// alert event, so a slow-to-recover disk can't spam duplicate cause_changed/
// raised events for a transition that already happened.
let _persistDirty = false;

// markerPath — the persisted latch marker, alongside the per-team reconcile-health
// markers (same CATALYST_DIR-scoped dir, so tests isolate via CATALYST_DIR).
function markerPath() {
  return join(getReconcileHealthDir(), "fleet-freeze.json");
}

// hydrate — lazily load the persisted latch on the first check of this process so
// a restart resumes the prior raised/cleared state. Best-effort: a missing or
// unreadable marker leaves the latch closed (never throws).
function hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = readFileSync(markerPath(), "utf8");
    const parsed = JSON.parse(raw);
    _fleetFrozenRaised = parsed?.raised === true;
    // CTL-1628 r4: additive field — absent on markers written before this fix.
    // CTL-1628 r4 post-merge: a legacy marker ({raised:true}, no `cause`) can
    // only have come from BEFORE persist-origin freezes existed (r3 added the
    // classification), so a still-raised legacy freeze was necessarily
    // all-poll — default to that (not null) so the first post-upgrade tick
    // only emits cause_changed on a REAL drift, not merely "the field is new."
    _lastEmittedCause =
      typeof parsed?.cause === "string"
        ? parsed.cause
        : _fleetFrozenRaised
          ? FLEET_FREEZE_CAUSE_ALL_POLL
          : null;
  } catch {
    _fleetFrozenRaised = false; // absent/malformed → closed
    _lastEmittedCause = null;
  }
}

// persist — atomically write the latch so a restart resumes it. Best-effort:
// never throws. CTL-1628 r4 post-merge: self-manages `_persistDirty` on both
// paths (cleared on success, set on failure) and returns true/false so a
// caller that cares can observe the outcome — callers here don't need to,
// since checkFleetFreeze retries automatically via `_persistDirty` above.
function persist() {
  try {
    const dir = getReconcileHealthDir();
    mkdirSync(dir, { recursive: true });
    // CTL-1628 post-merge: a DETERMINISTIC tmp name (not a randomBytes-suffixed
    // one) — matches the idiom every other atomic-write helper in this
    // directory uses (reconcile-health.mjs's writeHealthMarker, eligible-
    // set.mjs, registry.mjs: `${file}.tmp`). With the r4-post-merge retry
    // loop calling persist() again on every subsequent tick while dirty, a
    // randomized name would leave a NEW orphaned .tmp file behind on every
    // failed attempt (writeFileSync succeeds; only the rename fails) — an
    // unbounded accumulation for as long as the underlying fault persists.
    // A deterministic name means each retry's writeFileSync overwrites the
    // SAME file in place, bounding the leftover to at most one.
    const tmp = `${markerPath()}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ raised: _fleetFrozenRaised, cause: _lastEmittedCause, ts: Date.now() }),
    );
    renameSync(tmp, markerPath());
    _persistDirty = false;
    return true;
  } catch (err) {
    _persistDirty = true;
    log.error?.({ err: err.message }, "CTL-1420: fleet-freeze latch persist failed (continuing)");
    return false;
  }
}

// __resetFleetFreezeLatch — test seam so latch state never leaks across tests.
// Clears the in-memory latch, last-emitted cause, the persist-dirty flag, and
// the hydration flag so the next check re-reads the (CATALYST_DIR-scoped)
// marker.
export function __resetFleetFreezeLatch() {
  _fleetFrozenRaised = false;
  _lastEmittedCause = null;
  _persistDirty = false;
  _hydrated = false;
}

// isFleetFrozenRaised — introspection (test/telemetry only).
export function isFleetFrozenRaised() {
  return _fleetFrozenRaised;
}

// defaultAppend — writes a JSONL line to the canonical event log (same path the
// broker + every other execution-core emitter appends to).
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildFleetFreezeAlertEvent — canonical JSONL line (string + "\n") for the
// fleet-frozen-admission alert. `action` is "raised" (WARN) or "cleared" (INFO).
// `cause` (CTL-1628 r3: FLEET_FREEZE_CAUSE_*, "raised" only) is mirrored into
// BOTH attributes and body.payload — attributes because otel-forward's OTLP
// conversion never reads body.payload (confirmed in the CTL-1628 r1 fix to
// reconcile-health-event.mjs), so a cause confined to the body would be
// silently dropped for every Loki/Grafana consumer, defeating the entire
// point of distinguishing the two outage stories where operators actually look.
//
// `causeChanged`/`previousCause` (CTL-1628 r4, "raised" only): set when this
// emission is a mid-freeze cause RECLASSIFICATION (origins drifted, e.g.
// all-poll → all-persist) rather than the initial raise — same event name/
// topic as a fresh raise (the fleet IS still frozen), distinguished by the
// `alert.cause_changed` attribute so a consumer can special-case "the cause
// changed under an already-open alert" without misreading it as a second,
// unrelated freeze. `previousCause` is ALSO mirrored into
// `attributes["alert.previous_cause"]` (CTL-1628 r4 post-merge fix, same
// pattern as `alert.cause`/`reconcile.reason`) — otel-forward's OTLP
// conversion only ever reads `attributes` + `body.message`, never
// `body.payload`, so a previousCause confined to the body would be silently
// dropped for every Loki/Grafana consumer and a cause-drift alert would show
// the new cause with no record of what it changed FROM.
export function buildFleetFreezeAlertEvent({
  action,
  teams = [],
  reason = null,
  cause = null,
  causeChanged = false,
  previousCause = null,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const raised = action === "raised";
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: raised ? "WARN" : "INFO",
      severityNumber: raised ? 13 : 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": raised ? ALERT_RAISED : ALERT_CLEARED,
        "event.entity": "alert",
        "event.action": action,
        "event.label": ALERT_KIND_FLEET_FROZEN_ADMISSION,
        ...(cause ? { "alert.cause": cause } : {}),
        ...(causeChanged ? { "alert.cause_changed": true } : {}),
        ...(previousCause ? { "alert.previous_cause": previousCause } : {}),
      },
      body: {
        payload: {
          kind: ALERT_KIND_FLEET_FROZEN_ADMISSION,
          reason,
          cause,
          causeChanged,
          previousCause,
          source: "catalyst.execution-core",
          count: teams.length,
          teams,
        },
      },
    }) + "\n"
  );
}

// checkFleetFreeze — evaluate the fleet-frozen-for-admission condition and emit
// an alert ON A STATE TRANSITION (latched; idempotent within a steady state) —
// PLUS, CTL-1628 r4, on a mid-freeze CAUSE reclassification (see below).
// Best-effort: any emit error is swallowed so a failed alert never crashes the
// reconcile timer.
//
//   teams        — every registered team (e.g. listProjects().map(p => p.team))
//   isTeamFrozen  — (team) => boolean; true when that team can't refresh eligible
//   getTeamOrigin — CTL-1628 r3: (team) => "poll" | "persist"; which stage was
//                   failing for that team (see reconcile-health.mjs's
//                   lastFailureOrigin). Defaults to always "poll" — the pre-r3
//                   behavior — so a caller that hasn't wired origin tracking
//                   still gets the original all-poll double-outage message.
//                   Only consulted for teams isTeamFrozen already said are
//                   frozen; a non-"poll"/"persist" return is treated as "poll".
//   append        — injectable JSONL sink (defaults to the canonical event log)
//
// CTL-1628 r4: while the fleet stays frozen across ticks, origins can DRIFT —
// e.g. the replica/linearis outage that raised an all-poll freeze recovers,
// but a team's local disk fills in the meantime, so the SAME standing freeze
// is now all-persist (or mixed). Before this fix, cause classification only
// ran on the initial raise — the one emitted alert would keep reporting the
// ORIGINAL, now-wrong cause for the freeze's entire duration. The cause is now
// re-classified on every check while frozen (not only the initial raise); when
// it differs from the last-emitted cause, a `cause_changed` update is emitted
// (same event name/topic as `raised` — the fleet IS still frozen — with an
// updated reason and the `alert.cause_changed` marker) — never on unchanged
// classifications, so a steady-state freeze stays exactly as silent as before.
//
// Returns { frozen, emitted, cause } where emitted ∈
// {"raised","cause_changed","cleared",null} and cause (non-null only on
// "raised"/"cause_changed") ∈ FLEET_FREEZE_CAUSE_*.
export function checkFleetFreeze({
  teams = [],
  isTeamFrozen = () => false,
  getTeamOrigin = () => "poll",
  append = defaultAppend,
} = {}) {
  hydrate();
  // CTL-1628 r4 post-merge: retry a previously-failed marker persist BEFORE
  // evaluating this tick. This only re-attempts the disk write for a
  // transition that already happened (and already emitted its event) — it
  // never re-emits raised/cause_changed/cleared itself, so a slow-to-recover
  // disk catches the marker up without spamming duplicate alerts.
  if (_persistDirty) persist();
  // An EMPTY team list is NOT evidence of recovery — it means "no teams to
  // evaluate", which also happens on a transient unreadable/malformed registry
  // (listProjects() returns [] instead of throwing). Concluding "not frozen" here
  // would flap a genuinely-raised latch to `cleared` and re-raise next tick. So an
  // empty team set is a NO-TRANSITION: preserve the current latch, emit nothing.
  if (teams.length === 0) {
    return { frozen: _fleetFrozenRaised, emitted: null, cause: null };
  }
  const frozen = teams.every((t) => isTeamFrozen(t));
  let emitted = null;
  let returnedCause = null;
  try {
    if (frozen) {
      // Every team in `teams` is frozen (that's what `frozen` means here), so
      // every team's origin is meaningful — classify the whole freeze by them.
      // Computed on EVERY frozen tick (not gated on the raise transition) so a
      // mid-freeze drift is caught, not just the moment of the initial raise.
      const origins = teams.map((t) => (getTeamOrigin(t) === "persist" ? "persist" : "poll"));
      const currentCause = classifyFreezeCause(origins);

      if (!_fleetFrozenRaised) {
        // Append FIRST; flip + persist the latch only on a successful write, so
        // a transient append failure (disk full) retries next tick instead of
        // silently latching "raised" with no event ever emitted.
        append(
          buildFleetFreezeAlertEvent({
            action: "raised",
            teams,
            cause: currentCause,
            reason: FREEZE_REASON_BY_CAUSE[currentCause],
          })
        );
        _fleetFrozenRaised = true;
        _lastEmittedCause = currentCause;
        persist();
        emitted = "raised";
        returnedCause = currentCause;
        log.error(
          { teams, cause: currentCause },
          "CTL-1420: fleet FROZEN for admission — all teams' reconcile failing",
        );
      } else if (currentCause !== _lastEmittedCause) {
        // Already latched, but the classification drifted since the raise (or
        // the last cause-update) — avoid spamming: only this actual transition
        // emits, an unchanged classification on every other tick stays silent.
        const previousCause = _lastEmittedCause;
        append(
          buildFleetFreezeAlertEvent({
            action: "raised",
            teams,
            cause: currentCause,
            reason: FREEZE_REASON_BY_CAUSE[currentCause],
            causeChanged: true,
            previousCause,
          })
        );
        _lastEmittedCause = currentCause;
        persist();
        emitted = "cause_changed";
        returnedCause = currentCause;
        log.error(
          { teams, cause: currentCause, previousCause },
          "CTL-1420: fleet-frozen cause reclassified — origins drifted while still frozen",
        );
      }
    } else if (_fleetFrozenRaised) {
      append(buildFleetFreezeAlertEvent({ action: "cleared", teams }));
      _fleetFrozenRaised = false;
      _lastEmittedCause = null;
      persist();
      emitted = "cleared";
      log.info({ teams }, "CTL-1420: fleet admission UNFROZEN — a team's reconcile recovered");
    }
  } catch (err) {
    // Never throw out of the reconcile timer.
    log.error?.({ err: err.message }, "CTL-1420: fleet-freeze alert emit failed (continuing)");
  }
  return { frozen, emitted, cause: returnedCause };
}
