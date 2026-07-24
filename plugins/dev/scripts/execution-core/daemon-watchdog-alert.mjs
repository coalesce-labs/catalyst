// daemon-watchdog-alert.mjs — CTL-1502. Raise/clear/escalate the stuck-but-alive
// daemon alert on an OUT-OF-BAND path and file the sensing-substrate recovery
// finding. Three sinks, ordered by load-bearing-ness:
//
//   1. the exec-core daemon pino `log` line (Alloy ships the `.log` → Loki,
//      independent of the otel-forward egress that may itself be the wedged path)
//   2. a local marker file ~/catalyst/watchdog/<daemon>.alert.json the HUD reads
//   3. best-effort catalyst.alert.raised|cleared to the event log for dashboards
//      — explicitly NOT load-bearing (it rides the very egress that may be broken)
//
// Every fn is best-effort and NEVER throws — a telemetry/alert append must never
// wedge the daemon tick (the CTL-988 "a tap must never be load-bearing" learning).
//
// We COPY the alert envelope shape from broker/alert-emit.mjs rather than import
// broker code into exec-core (same rationale alert-emit gives for not importing
// board-data) — and emit under service.name=catalyst.execution-core, the
// surviving daemon here. A parity test pins event.name/entity/label to
// alert-emit.mjs's ALERT_RAISED/ALERT_CLEARED so a rename there can't drift us.

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  generateEventId,
  severityNumber,
  buildCatalystResource,
} from "../orch-monitor/lib/canonical-event-shared.ts";
import { getEventLogPath, log as defaultLog } from "./config.mjs";

// The alert KIND (event.label) for a stuck-but-alive daemon. Extends the
// alert-emit taxonomy (system_down / needs_human_pileup) without importing it.
export const DAEMON_STUCK_KIND = "daemon_stuck";

// Local copies of the alert event names. Deliberately NOT imported from
// broker/alert-emit.mjs at runtime (keeps exec-core independent of broker code);
// the parity test imports alert-emit's constants and asserts these match.
const ALERT_RAISED = "catalyst.alert.raised";
const ALERT_CLEARED = "catalyst.alert.cleared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADD_FINDING = join(__dirname, "..", "add-finding.sh");

function catalystDir() {
  return process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
}

// The HUD-readable marker dir — ~/catalyst/watchdog/. Re-resolved per call so
// tests redirect via CATALYST_DIR (matches the predicates module).
export function getWatchdogDir() {
  return join(catalystDir(), "watchdog");
}

/**
 * buildDaemonAlertEnvelope — assemble the canonical OTel envelope for a
 * catalyst.alert.{raised,cleared} event under service.name=catalyst.execution-core.
 * Pure (modulo the random id + injectable timestamp); no I/O. Mirrors
 * broker/alert-emit.mjs's buildAlertEnvelope.
 */
export function buildDaemonAlertEnvelope(
  { action, daemon = null, tripped = null, sinceMs = null, escalated = false } = {},
  { now } = {},
) {
  const ts = now ? now() : new Date().toISOString();
  const raised = action === "raised";
  const eventName = raised ? ALERT_RAISED : ALERT_CLEARED;
  const severity = raised ? "ERROR" : "INFO";
  return {
    ts,
    id: generateEventId(),
    observedTs: ts,
    severityText: severity,
    severityNumber: severityNumber(severity),
    traceId: null,
    spanId: null,
    caused_by: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": eventName,
      "event.entity": "alert",
      "event.action": action,
      "event.label": DAEMON_STUCK_KIND,
    },
    body: {
      payload: { kind: DAEMON_STUCK_KIND, daemon, tripped, sinceMs, escalated },
    },
  };
}

// --- sink helpers (each best-effort, never throws) ---

function writeMarker(io, target, fields) {
  try {
    const markerDir = io.markerDir ?? getWatchdogDir();
    mkdirSync(markerDir, { recursive: true });
    const path = join(markerDir, `${target.name}.alert.json`);
    const tmp = `${path}.tmp`;
    const now = io.now ? io.now() : new Date().toISOString();
    writeFileSync(
      tmp,
      JSON.stringify({ daemon: target.name, kind: DAEMON_STUCK_KIND, ts: now, ...fields }),
    );
    renameSync(tmp, path); // atomic
  } catch {
    /* best-effort — marker is sink (2), never load-bearing */
  }
}

function appendEnvelope(io, action, { tripped, sinceMs, escalated, target }) {
  try {
    const logPath = io.logPath ?? getEventLogPath();
    const line = `${JSON.stringify(
      buildDaemonAlertEnvelope(
        { action, daemon: target.name, tripped, sinceMs, escalated },
        { now: io.now },
      ),
    )}\n`;
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
  } catch {
    /* best-effort — event log is sink (3), rides the maybe-broken egress */
  }
}

function fileFinding(io, target, { tripped, sinceMs }) {
  const args = [
    "--title",
    `daemon-watchdog: ${target.name} stuck after restart`,
    "--body",
    `The stuck-but-alive watchdog restarted ${target.name} but the stuck predicate did not clear ` +
      `within the verify window (tripped: ${(tripped ?? []).join(", ")}; stuck for ~${sinceMs}ms). ` +
      `Manual investigation required — the daemon is holding its pid but not making progress.`,
    "--severity",
    "high",
    "--skill",
    "daemon-watchdog",
    "--tags",
    "daemon-watchdog,stuck-daemon,otel-forward",
  ];
  try {
    const run = io.runFinding ?? defaultRunFinding;
    run(args);
  } catch {
    /* best-effort — a finding failure must not wedge the daemon */
  }
}

function defaultRunFinding(args) {
  // Detached, output ignored — the finding queue drain is someone else's job.
  execFile(ADD_FINDING, args, () => {});
}

function safeLog(io, level, obj, msg) {
  try {
    const l = io.log ?? defaultLog;
    (l[level] ?? l.info ?? (() => {}))(obj, msg);
  } catch {
    /* best-effort */
  }
}

// --- public API ---

/**
 * raiseAlert — sink (1) log.error, sink (2) marker raised:true, sink (3) a
 * best-effort raised envelope. `escalated` latches the marker for escalate().
 */
export function raiseAlert(target, { tripped, sinceMs, escalated = false } = {}, io = {}) {
  safeLog(io, "error", { daemon: target.name, tripped, sinceMs, escalated }, "daemon-watchdog: stuck");
  writeMarker(io, target, { raised: true, tripped, sinceMs, escalated });
  appendEnvelope(io, "raised", { tripped, sinceMs, escalated, target });
}

/**
 * clearAlert — the predicate cleared after a restart: marker raised:false + a
 * cleared envelope + an info log. Re-arms the episode.
 */
export function clearAlert(target, { sinceMs } = {}, io = {}) {
  safeLog(io, "info", { daemon: target.name, sinceMs }, "daemon-watchdog: cleared");
  writeMarker(io, target, { raised: false, sinceMs, escalated: false });
  appendEnvelope(io, "cleared", { tripped: null, sinceMs, escalated: false, target });
}

/**
 * escalate — a restart did NOT clear the predicate within the verify window.
 * Latch a NON-clearing raised alert (escalated:true) + file a severity:high
 * recovery finding. There is no second restart until the cooldown re-arms.
 */
export function escalate(target, { tripped, sinceMs } = {}, io = {}) {
  raiseAlert(target, { tripped, sinceMs, escalated: true }, io); // latched, not cleared
  fileFinding(io, target, { tripped, sinceMs });
}
