// reconcile-health-event.mjs — canonical monitor.reconcile.{failing,recovered}
// events (CTL-867).
//
// When a team's eligibleQuery errors every reconcile poll (e.g. its status
// references a removed Linear state → `linearis issues list --team X --status
// Ready` exits 1), reconcileProject's catch preserves the prior eligible set
// and logs — correct, but a *persistent* failure freezes that team's eligible
// projection stale for hours while the daemon looks healthy. No new Todo tickets
// become eligible; the whole team starves invisibly.
//
// These events ESCALATE that buried log.error onto the unified event log so the
// orch-monitor dashboard surfaces the failing team:
//   monitor.reconcile.failing.<TEAM>    — WARN, after N consecutive failures
//   monitor.reconcile.recovered.<TEAM>  — INFO, when a poll succeeds after an alert
//
// Shape mirrors triage-transition-event.mjs / memory-event.mjs (OTel envelope,
// appendFileSync, never throws) so the dashboard/HUD parsers treat these events
// identically to every other canonical execution-core emission.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const RECONCILE_FAILING_ACTION = "failing";
export const RECONCILE_RECOVERED_ACTION = "recovered";

// defaultAppend — writes a JSONL line to the canonical event log.
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildReconcileHealthEvent — returns a canonical JSONL line (string + "\n") for
// the monitor.reconcile.<action>.<TEAM> event. `action` is "failing" (WARN) or
// "recovered" (INFO). The team is the event's entity label — there is no Linear
// issue identifier for a team-wide reconcile failure, so the attributes carry
// `team` rather than `linear.issue.identifier`.
export function buildReconcileHealthEvent({
  team,
  action,
  consecutiveFailures = null,
  lastSuccessTs = null,
  staleMs = null,
  reason = null,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const failing = action === RECONCILE_FAILING_ACTION;
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: failing ? "WARN" : "INFO",
      severityNumber: failing ? 13 : 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": `monitor.reconcile.${action}.${team}`,
        "event.entity": "monitor",
        "event.action": `reconcile.${action}`,
        "event.label": team,
        "catalyst.team": team,
      },
      body: {
        payload: {
          team,
          action,
          consecutiveFailures,
          lastSuccessTs,
          staleMs,
          reason,
        },
      },
    }) + "\n"
  );
}

// appendReconcileHealthEvent — append the event to the canonical event log. The
// `append` seam defaults to the real file write; inject a recording function in
// tests. Returns true on success, false on any error (log.error + swallow) so a
// failed append never crashes the reconcile timer.
export function appendReconcileHealthEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildReconcileHealthEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error(
      { err: err.message, team: fields.team, action: fields.action },
      "reconcile-health-event: append failed",
    );
    return false;
  }
}
