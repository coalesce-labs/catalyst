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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// Same topic + kind taxonomy as broker/alert-emit.mjs (event.name is the fixed
// raised/cleared topic; the kind differentiator lives in event.label).
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";
export const ALERT_KIND_FLEET_FROZEN_ADMISSION = "fleet_frozen_admission";

// Module-scoped latch so the alert fires exactly once per raised→cleared
// transition (mirrors reconcile-health's per-team `alerting` latch, fleet-wide).
let _fleetFrozenRaised = false;

// __resetFleetFreezeLatch — test seam so latch state never leaks across tests.
export function __resetFleetFreezeLatch() {
  _fleetFrozenRaised = false;
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
export function buildFleetFreezeAlertEvent({ action, teams = [], reason = null } = {}) {
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
      },
      body: {
        payload: {
          kind: ALERT_KIND_FLEET_FROZEN_ADMISSION,
          reason,
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
//   append        — injectable JSONL sink (defaults to the canonical event log)
//
// Returns { frozen, emitted } where emitted ∈ {"raised","cleared",null}.
export function checkFleetFreeze({ teams = [], isTeamFrozen = () => false, append = defaultAppend } = {}) {
  const frozen = teams.length > 0 && teams.every((t) => isTeamFrozen(t));
  let emitted = null;
  try {
    if (frozen && !_fleetFrozenRaised) {
      // Append FIRST; flip the latch only on a successful write, so a transient
      // append failure (disk full) retries next tick instead of silently latching
      // "raised" with no event ever emitted.
      append(
        buildFleetFreezeAlertEvent({
          action: "raised",
          teams,
          reason:
            "every registered team's reconcile is failing — the eligible projection cannot refresh from the replica or linearis (fleet admission is frozen)",
        })
      );
      _fleetFrozenRaised = true;
      emitted = "raised";
      log.error({ teams }, "CTL-1420: fleet FROZEN for admission — all teams' reconcile failing");
    } else if (!frozen && _fleetFrozenRaised) {
      append(buildFleetFreezeAlertEvent({ action: "cleared", teams }));
      _fleetFrozenRaised = false;
      emitted = "cleared";
      log.info({ teams }, "CTL-1420: fleet admission UNFROZEN — a team's reconcile recovered");
    }
  } catch (err) {
    // Never throw out of the reconcile timer.
    log.error?.({ err: err.message }, "CTL-1420: fleet-freeze alert emit failed (continuing)");
  }
  return { frozen, emitted };
}
