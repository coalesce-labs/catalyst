// reconcile-health-event.mjs — canonical monitor.reconcile.{failing,recovered,
// eligible_persist_failure} events (CTL-867, CTL-1628).
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
// CTL-1628 adds a third, sibling action for a DIFFERENT failure mode in the
// same reconcileProject flow: the eligibleQuery poll succeeds, but the
// resulting eligible-set disk projection write/rename then fails (disk full,
// permissions). That was previously only a buried log.error — "monitoring
// green, scheduler stale" — with no event-log signal at all. Unlike
// failing/recovered, this action is emitted every time the persist write
// fails (no consecutive-failure threshold or alert latch — see
// monitor.mjs's reconcileProject catch block):
//   monitor.reconcile.eligible_persist_failure.<TEAM> — WARN, every failed persist
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
export const ELIGIBLE_PERSIST_FAILURE_ACTION = "eligible_persist_failure"; // CTL-1628

// defaultAppend — writes a JSONL line to the canonical event log.
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildReconcileHealthEvent — returns a canonical JSONL line (string + "\n") for
// the monitor.reconcile.<action>.<TEAM> event. `action` is "recovered" (INFO);
// every other action — "failing" or "eligible_persist_failure" (CTL-1628) — is
// WARN. The team is the event's entity label — there is no Linear issue
// identifier for a team-wide reconcile failure, so the attributes carry `team`
// rather than `linear.issue.identifier`.
// REASON_ATTR_MAX_LEN — bound on the `reconcile.reason` attribute so a long
// stack-trace-flavored error message (e.g. a wrapped ENOSPC/EACCES fs error)
// can't blow up the OTLP/Loki attribute payload. body.payload.reason (below)
// keeps the untruncated string for local/file consumers.
const REASON_ATTR_MAX_LEN = 200;

export function buildReconcileHealthEvent({
  team,
  action,
  consecutiveFailures = null,
  lastSuccessTs = null,
  staleMs = null,
  reason = null,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const failing = action !== RECONCILE_RECOVERED_ACTION;
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
        // CTL-1628: otel-forward's OTLP conversion (lib/destinations/otlp.ts
        // buildOtlpPayload) only ever forwards `attributes` + `body.message` —
        // `body.payload` (where `reason` lived exclusively before this) is
        // never read, so the failure reason was silently dropped for every
        // Loki/Grafana consumer. Mirrored into attributes here, truncated, so
        // it survives the forward. Omitted (not even empty-string) when there
        // is no reason, matching the conditional-attribute style used
        // elsewhere in this envelope (e.g. linear.issue.identifier).
        ...(reason ? { "reconcile.reason": String(reason).slice(0, REASON_ATTR_MAX_LEN) } : {}),
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
