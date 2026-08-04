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
let _hydrated = false;

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
    _fleetFrozenRaised = JSON.parse(raw)?.raised === true;
  } catch {
    _fleetFrozenRaised = false; // absent/malformed → closed
  }
}

// persist — atomically write the latch so a restart resumes it. Best-effort.
function persist() {
  try {
    const dir = getReconcileHealthDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.fleet-freeze.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ raised: _fleetFrozenRaised, ts: Date.now() }));
    renameSync(tmp, markerPath());
  } catch (err) {
    log.error?.({ err: err.message }, "CTL-1420: fleet-freeze latch persist failed (continuing)");
  }
}

// __resetFleetFreezeLatch — test seam so latch state never leaks across tests.
// Clears both the in-memory latch and the hydration flag so the next check
// re-reads the (CATALYST_DIR-scoped) marker.
export function __resetFleetFreezeLatch() {
  _fleetFrozenRaised = false;
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
export function buildFleetFreezeAlertEvent({ action, teams = [], reason = null, cause = null } = {}) {
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
      },
      body: {
        payload: {
          kind: ALERT_KIND_FLEET_FROZEN_ADMISSION,
          reason,
          cause,
          source: "catalyst.execution-core",
          count: teams.length,
          teams,
        },
      },
    }) + "\n"
  );
}

// checkFleetFreeze — evaluate the fleet-frozen-for-admission condition and emit a
// raised/cleared alert ON A STATE TRANSITION only (latched; idempotent within a
// state). The fleet is frozen when there is ≥1 registered team AND EVERY team's
// reconcile is in a persistent-failure state (isTeamFrozen). Best-effort: any
// emit error is swallowed so a failed alert never crashes the reconcile timer.
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
// Returns { frozen, emitted, cause } where emitted ∈ {"raised","cleared",null}
// and cause (raised transitions only) ∈ FLEET_FREEZE_CAUSE_*.
export function checkFleetFreeze({
  teams = [],
  isTeamFrozen = () => false,
  getTeamOrigin = () => "poll",
  append = defaultAppend,
} = {}) {
  hydrate();
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
  let cause = null;
  try {
    if (frozen && !_fleetFrozenRaised) {
      // Every team in `teams` is frozen (that's what `frozen` means here), so
      // every team's origin is meaningful — classify the whole freeze by them.
      const origins = teams.map((t) => {
        const o = getTeamOrigin(t);
        return o === "persist" ? "persist" : "poll";
      });
      cause = classifyFreezeCause(origins);
      // Append FIRST; flip + persist the latch only on a successful write, so a
      // transient append failure (disk full) retries next tick instead of silently
      // latching "raised" with no event ever emitted.
      append(
        buildFleetFreezeAlertEvent({
          action: "raised",
          teams,
          cause,
          reason: FREEZE_REASON_BY_CAUSE[cause],
        })
      );
      _fleetFrozenRaised = true;
      persist();
      emitted = "raised";
      log.error(
        { teams, cause },
        "CTL-1420: fleet FROZEN for admission — all teams' reconcile failing",
      );
    } else if (!frozen && _fleetFrozenRaised) {
      append(buildFleetFreezeAlertEvent({ action: "cleared", teams }));
      _fleetFrozenRaised = false;
      persist();
      emitted = "cleared";
      log.info({ teams }, "CTL-1420: fleet admission UNFROZEN — a team's reconcile recovered");
    }
  } catch (err) {
    // Never throw out of the reconcile timer.
    log.error?.({ err: err.message }, "CTL-1420: fleet-freeze alert emit failed (continuing)");
  }
  return { frozen, emitted, cause };
}
