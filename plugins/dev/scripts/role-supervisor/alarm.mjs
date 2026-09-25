// alarm.mjs — CTC-2981. Where the three out-of-fleet instruments (dead-man,
// quiet-fleet, holding-sentinel) raise their alarm.
//
// They used to post to a `catalyst-comms` channel that nothing polled, and the
// dead-man also appended to a markdown channel directory nobody watched. Both are
// gone. The alarm now rides the repo's existing operator-facing topic, the one the
// broker (broker/alert-emit.mjs) and execution-core (daemon-watchdog-alert.mjs,
// fleet-freeze-alert.mjs) already use:
//
//   catalyst.alert.raised  / catalyst.alert.cleared   (event.label = the KIND)
//
// appended to the shared event log. From there the board's fleet-alert strip
// renders it (orch-monitor/lib/fleet-alerts.mjs), otel-forward ships it to Loki,
// and the cloud classifies it as a "human/operator must act" event. Every alarm
// also writes one stderr line, which launchd captures in the unit's
// StandardErrorPath log, so an alarm is still visible if the log append fails.
//
// Kinds are FLEET-scoped (one row per condition, not per role): the board folds
// alerts per kind, so the role names travel in `reason` / `source`.
//
// node:*-only plus leaf imports, like the rest of role-supervisor: launchd runs
// these instruments under plain node, so nothing here may reach pino, bun:sqlite
// or a .ts module.
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { catalystDir } from "./paths.mjs";
import { buildCatalystResource } from "../execution-core/lib/catalyst-resource.mjs";

// Local copies of the alert event names, pinned to broker/alert-emit.mjs by
// alarm.test.mjs (same rationale as daemon-watchdog-alert.mjs: no broker import).
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";

export const ROLE_ALARM_SERVICE = "catalyst.role-supervisor";

export const ROLE_ALARM_KIND = Object.freeze({
  /** dead-man: the concierge has no heartbeat and no turn for 30 minutes. */
  CONCIERGE_DEAD: "concierge_dead",
  /** quiet-fleet: a role is SILENT / DEAD / MISSING while its scope is active. */
  ROLE_SILENT: "role_silent",
  /** holding-sentinel: a silent role's supervisor was asked to restart it. */
  ROLE_RESTARTING: "role_restarting",
  /**
   * execution-core's stale-PR rescue could not rescue a PR and, in steward-
   * escalation `enforce` mode, pages the steward or concierge (stale-pr-rescue-timer.mjs).
   */
  STALE_PR_UNRESCUED: "stale_pr_unrescued",
});

/** The UTC month ("YYYY-MM") that names the event log a write at `now` lands in. */
export function alarmLogMonth(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The monthly event log (UTC month), matching broker/config.mjs getEventLogPath. */
export function eventLogPath({ env = process.env, now = Date.now() } = {}) {
  return join(catalystDir(env), "events", `${alarmLogMonth(now)}.jsonl`);
}

/**
 * How often a standing alarm is appended again while its condition holds. The
 * board reads only a bounded tail of the current month's log (TAIL_BYTES in
 * orch-monitor/lib/fleet-alerts.mjs, sized for about a day of fleet traffic), so
 * a raise older than that tail drops off the board even though nothing cleared
 * it. Six hours keeps a fresh raise inside the tail with room to spare.
 */
export const ALARM_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Should a latched alarm be raised again now? The latch records where its last
 * raise landed: `log_month` (which month's log) and `logged_at` (when). It is
 * due again when
 *   - neither is recorded: a latch written before these fields existed was
 *     delivered only to the removed channel sinks, and a failed append records
 *     neither, so nothing proves a catalyst.alert.raised is on the log;
 *   - the raise is in an earlier month's log, which the board no longer reads; or
 *   - the raise is ALARM_REFRESH_MS old or older and may have left the tail.
 *
 * @param {object|null} latch
 * @param {number} now
 * @returns {boolean}
 */
export function alarmRaiseDue(latch, now) {
  if (typeof latch?.log_month !== "string" || typeof latch?.logged_at !== "number") return true;
  return latch.log_month !== alarmLogMonth(now) || now - latch.logged_at >= ALARM_REFRESH_MS;
}

/** The latch fields that record a raise landing on the log at `now`, or that none did. */
export function raiseLogged(delivered, now) {
  return delivered ? { log_month: alarmLogMonth(now), logged_at: now } : { log_month: null, logged_at: null };
}

/**
 * Build one catalyst.alert.{raised,cleared} envelope. Pure apart from the random
 * id. Mirrors broker/alert-emit.mjs buildAlertEnvelope, under this package's own
 * service.name so the broker's self-filter never drops it.
 *
 * @param {{action: "raised"|"cleared", kind: string, instrument: string, reason?: string|null, source?: string|null, target?: string|null, count?: number|null}} input
 * @param {{now?: number, serviceName?: string}} [opts]
 */
export function buildRoleAlarmEnvelope(
  { action, kind, instrument, reason = null, source = null, target = null, count = null },
  { now = Date.now(), serviceName = ROLE_ALARM_SERVICE } = {},
) {
  const ts = new Date(now).toISOString();
  const raised = action === "raised";
  const severity = raised ? "ERROR" : "INFO";
  return {
    ts,
    id: randomUUID(),
    observedTs: ts,
    severityText: severity,
    severityNumber: raised ? 17 : 9,
    traceId: null,
    spanId: null,
    caused_by: null,
    resource: buildCatalystResource({ serviceName }),
    attributes: {
      "event.name": raised ? ALERT_RAISED : ALERT_CLEARED,
      "event.entity": "alert",
      "event.action": action,
      "event.label": kind,
    },
    body: {
      payload: { kind, instrument, reason, source, target, count },
    },
  };
}

/**
 * Raise or clear one alarm: a stderr line, then an append to the event log.
 * Returns true only when the event-log append succeeded — that append is the
 * delivery the callers latch on. Never throws.
 *
 * @param {Parameters<typeof buildRoleAlarmEnvelope>[0]} input
 * @param {{env?: object, now?: number, stderr?: {write: Function}, serviceName?: string}} [opts]
 * @returns {boolean}
 */
export function emitRoleAlarm(input, { env = process.env, now = Date.now(), stderr = process.stderr, serviceName = ROLE_ALARM_SERVICE } = {}) {
  try {
    const who = input.source ? ` (${input.source})` : "";
    stderr.write(`role-supervisor: ${input.instrument} alert ${input.action} ${input.kind}${who}${input.reason ? ` — ${input.reason}` : ""}\n`);
  } catch {
    /* a closed stderr must not stop the event-log append */
  }
  try {
    const path = eventLogPath({ env, now });
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(buildRoleAlarmEnvelope(input, { now, serviceName }))}\n`);
    return true;
  } catch {
    return false;
  }
}
