// install-telemetry.mjs — CTL-1369: the `catalyst.install.*` observability contract.
//
// The `catalyst install | uninstall | reinstall` lifecycle (PR 2) is modeled as BOTH:
//   * a TRACE — root `catalyst.install` span + one child per phase that ran
//     (acquire → backup → write-config → install-agents → start-daemons → healthcheck),
//     plus an `install.rollback` child on a rolled-back run. This is the OTEL agent's
//     locked turn-01 lifecycle-trace model (catalyst-updater-otel md-channel, turn 04).
//   * canonical EVENTS — `catalyst.install.{started,phase,completed,failed,rolled_back}`
//     appended to the unified event log, with LOW-CARD label dims ONLY (operation,
//     node_class, phase, outcome) per the OTEL cardinality rule; paths / shas / error
//     strings stay in the body payload, never on a label.
//
// This module owns the catalyst.install.* EVENTS + the InstallRun recorder; the per-run
// SPAN tree lives in tracing.mjs:emitInstallTrace (the same events-near-caller / spans-in-
// tracing split as updater.mjs:makeEmitFn + tracing.mjs:emitUpdaterRefreshSpan). It is the
// CONTRACT, INERT until the install command drives an InstallRun. service.name =
// "catalyst.install", service.namespace = "catalyst", short host.name/id, and
// catalyst.node.class on the resource. Best-effort throughout — telemetry must never break
// an install.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getNodeClass, getHostName } from "../config.mjs";
import { hostName, hostId } from "./host-identity.mjs";
import { emitInstallTrace } from "../tracing.mjs";

export const INSTALL_SERVICE_NAME = "catalyst.install";
// The install lifecycle phases, in order. Source of truth for both the span tree and the
// `phase` label enum; the install command (PR 2) wraps each real step in run.phase(<name>).
export const INSTALL_PHASES = Object.freeze([
  "acquire",
  "backup",
  "write-config",
  "install-agents",
  "start-daemons",
  "healthcheck",
]);
export const INSTALL_OPERATIONS = Object.freeze(["install", "uninstall", "reinstall"]);
export const INSTALL_OUTCOMES = Object.freeze(["completed", "failed", "rolled_back"]);

// The catalyst.install.* event family. Dot-form so the OTEL OTL-20 connectors auto-decompose
// `catalyst.install.<action>` into event_entity=install + event_action=<action>.
export const INSTALL_EVENT = Object.freeze({
  started: "catalyst.install.started",
  phase: "catalyst.install.phase",
  completed: "catalyst.install.completed",
  failed: "catalyst.install.failed",
  rolledBack: "catalyst.install.rolled_back",
});

const SEVERITY_NUMBER = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 };

function isoNow(nowFn = Date.now) {
  return new Date(nowFn()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * buildInstallEnvelope — the v2 OTel canonical envelope for one catalyst.install.* event,
 * stamped service.name=catalyst.install. Pure (modulo a random id + ts). The low-card
 * label dims (operation / phase / outcome) ride attributes; everything high-card (paths,
 * shas, error strings, durations) stays in body.payload.
 */
export function buildInstallEnvelope({
  event,
  operation = null,
  nodeClass,
  hostNameVal,
  phase = null,
  outcome = null,
  detail = null,
  severity = "INFO",
  traceId = null,
  spanId = null,
  nowFn = Date.now,
} = {}) {
  const ts = isoNow(nowFn);
  const host = hostNameVal ?? getHostName();
  const cls = nodeClass ?? getNodeClass();
  const sev = severity || "INFO";
  const action = typeof event === "string" ? event.split(".").pop() : null;
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: sev,
    severityNumber: SEVERITY_NUMBER[sev] ?? 9,
    // Carry the run's trace context so the catalyst.install.* log lines join to the root
    // `catalyst.install` span in Loki/Tempo (these EVENTS are the install's only log, unlike
    // the updater which also writes a pino refresh line). Null when tracing is off.
    traceId: traceId ?? null,
    spanId: spanId ?? null,
    resource: {
      "service.name": INSTALL_SERVICE_NAME,
      "service.namespace": "catalyst",
      "host.name": hostName({ override: host }),
      "host.id": hostId({ override: host }),
      "catalyst.node.class": cls,
    },
    attributes: {
      "event.name": event,
      "event.entity": "install",
      "event.action": action,
      // LOW-CARD label dims only (OTEL cardinality rule) — bounded enums.
      "catalyst.install.operation": operation,
      "catalyst.install.phase": phase,
      "catalyst.install.outcome": outcome,
      "event.label": operation,
    },
    body: { payload: detail ?? {} },
    caused_by: null,
  };
}

/**
 * makeInstallEmitFn — the canonical-envelope appender the install command drives. Resolves
 * the event-log path PER CALL (UTC month rollover, same Codex P2 the updater hit). Synchronous
 * appendFileSync; a log-append failure must never break an install.
 */
export function makeInstallEmitFn({ getLogPathFn = getEventLogPath, nowFn = Date.now, nodeClass, hostNameVal } = {}) {
  const host = hostNameVal ?? getHostName();
  const cls = nodeClass ?? getNodeClass();
  // Per-call `nodeClass`/`traceId`/`spanId` override the baked defaults so the InstallRun
  // (which owns the run's class + trace context) stamps every event authoritatively — e.g.
  // `reinstall --class developer` on a worker node must stamp the REQUESTED class, not the
  // current config's. Falls back to the baked class when the caller omits it.
  return ({ event, operation = null, phase = null, outcome = null, detail = null, severity = "INFO", nodeClass: ncOverride, traceId = null, spanId = null } = {}) => {
    try {
      const logPath = getLogPathFn();
      const envelope = buildInstallEnvelope({ event, operation, nodeClass: ncOverride ?? cls, hostNameVal: host, phase, outcome, detail, severity, traceId, spanId, nowFn });
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(envelope)}\n`);
    } catch {
      /* best-effort — observability append must never break an install */
    }
  };
}

/**
 * InstallRun — the lifecycle recorder the `catalyst install|uninstall|reinstall` command
 * (PR 2) drives. It wraps each real step in `.phase(name, fn)`: times it, emits
 * catalyst.install.phase, and re-throws on failure so the command owns rollback.
 * `.complete()` / `.fail()` emit the terminal event AND the per-run trace. Pure modulo the
 * injected `emit` + clock — the command injects the real makeInstallEmitFn; tests inject a
 * capturing stub. Telemetry is best-effort and never breaks the install.
 */
export class InstallRun {
  constructor({ operation, nodeClass, emit, traceId, spanId, nowFn = Date.now } = {}) {
    this.operation = operation;
    this.nodeClass = nodeClass ?? getNodeClass();
    this.emit = typeof emit === "function" ? emit : () => {};
    this.nowFn = nowFn;
    this.traceId = traceId;
    this.spanId = spanId;
    this.phases = [];
    this.startEpochMs = nowFn();
  }

  // _emit — every install event carries the run's operation + node class + trace context, so
  // the log lines join to the root span (traceId) and are stamped with the REQUESTED class
  // even when it differs from the node's current config (e.g. `reinstall --class developer`).
  _emit(fields) {
    this.emit({ operation: this.operation, nodeClass: this.nodeClass, traceId: this.traceId, spanId: this.spanId, ...fields });
  }

  start(detail = null) {
    this.startEpochMs = this.nowFn();
    this._emit({ event: INSTALL_EVENT.started, detail });
    return this;
  }

  // phase(name, fn) — run fn (sync or async), record timing, emit catalyst.install.phase.
  // On throw, record the failed phase and re-raise (the command decides whether to roll back).
  async phase(name, fn) {
    const startEpochMs = this.nowFn();
    try {
      const result = typeof fn === "function" ? await fn() : undefined;
      const endEpochMs = this.nowFn();
      this.phases.push({ name, startEpochMs, endEpochMs, ok: true });
      this._emit({ event: INSTALL_EVENT.phase, phase: name, detail: { duration_ms: endEpochMs - startEpochMs } });
      return result;
    } catch (err) {
      const endEpochMs = this.nowFn();
      const errMsg = err?.message ?? String(err);
      this.phases.push({ name, startEpochMs, endEpochMs, ok: false, error: errMsg });
      this._emit({ event: INSTALL_EVENT.phase, phase: name, outcome: "failed", severity: "ERROR", detail: { error: errMsg } });
      throw err;
    }
  }

  complete(detail = null) {
    const endEpochMs = this.nowFn();
    this._emit({ event: INSTALL_EVENT.completed, outcome: "completed", detail });
    emitInstallTrace({
      operation: this.operation,
      nodeClass: this.nodeClass,
      phases: this.phases,
      outcome: "completed",
      startEpochMs: this.startEpochMs,
      endEpochMs,
      traceId: this.traceId,
      spanId: this.spanId,
    });
    return this;
  }

  // fail(err, {rolledBack}) — terminal event + trace for a failed run. rolledBack:true emits
  // catalyst.install.rolled_back (+ an install.rollback span); else catalyst.install.failed.
  fail(err, { rolledBack = false } = {}) {
    const endEpochMs = this.nowFn();
    const outcome = rolledBack ? "rolled_back" : "failed";
    const errMsg = err?.message ?? (err != null ? String(err) : null);
    this._emit({
      event: rolledBack ? INSTALL_EVENT.rolledBack : INSTALL_EVENT.failed,
      outcome,
      severity: "ERROR",
      detail: { error: errMsg },
    });
    emitInstallTrace({
      operation: this.operation,
      nodeClass: this.nodeClass,
      phases: this.phases,
      outcome,
      startEpochMs: this.startEpochMs,
      endEpochMs,
      traceId: this.traceId,
      spanId: this.spanId,
      rollback: rolledBack ? { startEpochMs: endEpochMs, endEpochMs, error: errMsg } : null,
    });
    return this;
  }
}
