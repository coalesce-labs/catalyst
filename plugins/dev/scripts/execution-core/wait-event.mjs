// wait-event.mjs — CTL-650 Phase 3. The agent.* canonical-event builder + a
// best-effort appender. Modeled on recovery.mjs's buildEventEnvelope
// (recovery.mjs:189-215) but emits `event.entity:"agent"` with
// `event.name:"agent.waiting_on_user"|"agent.resumed"` and INFO severity. These
// names match no broker self-emit pattern (shouldSkipEvent), so the daemon
// tailing its own log cannot feed a wait event back to itself.
//
// buildWaitEnvelope returns the envelope OBJECT (FS-free, unit-testable shape);
// emitWaitEvent serializes it and appends one line, never throwing — a missing
// event log is best-effort like every other daemon emitter.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";
import { shortIdFromSessionId } from "./claude-ids.mjs";
import { hostName, hostId } from "./lib/host-identity.mjs";

/**
 * buildWaitEnvelope — assemble the canonical OTel envelope for a wait/resume
 * transition. Pure (modulo random ids + timestamp); no I/O.
 *
 * @param {string} name  "agent.waiting_on_user" | "agent.resumed"
 * @param {object} args
 * @param {object} args.a            the live `claude agents` entry ({sessionId,status,cwd})
 * @param {string} args.state        the classified wait state
 * @param {?string} [args.waitingText]
 * @param {?string} [args.detail]
 * @param {object} [args.meta]       the joined signal ({ticket,phase,orchestratorId,worktreePath})
 * @returns {object} the envelope object
 */
export function buildWaitEnvelope(name, { a = {}, state, waitingText, detail, meta = {} } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const sessionId = a.sessionId ?? null;
  let shortId = null;
  if (sessionId) {
    try {
      shortId = shortIdFromSessionId(sessionId);
    } catch {
      shortId = null;
    }
  }
  const ticket = meta.ticket ?? null;
  const phase = meta.phase ?? null;
  const orchId = meta.orchestratorId ?? ticket ?? null;
  const cwd = a.cwd ?? meta.worktreePath ?? null;
  const action = name.startsWith("agent.") ? name.slice("agent.".length) : name;

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: {
      "service.name": "catalyst.execution-core",
      "service.namespace": "catalyst",
      "host.name": hostName(),
      "host.id": hostId(),
    },
    attributes: {
      "event.name": name,
      "event.entity": "agent",
      "event.action": action,
      "event.label": ticket ?? shortId ?? sessionId ?? "unknown",
      "catalyst.orchestration": orchId ?? "",
      // Only stamp the Linear identifier when we actually joined a ticket — an
      // unjoined session must not invent a `linear.issue.identifier`.
      ...(ticket ? { "linear.issue.identifier": ticket } : {}),
    },
    body: {
      payload: {
        sessionId,
        shortId,
        ticket,
        phase,
        waitState: state ?? null,
        waitingText: waitingText ?? null,
        cwd,
        detail: detail ?? null,
      },
    },
  };
}

/**
 * emitWaitEvent — build + append one envelope line to the event log. Returns
 * true on success, false on any failure (best-effort; never throws). `logPath`
 * is injectable for tests.
 */
export function emitWaitEvent(name, args, { logPath = getEventLogPath() } = {}) {
  const line = `${JSON.stringify(buildWaitEnvelope(name, args))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message, name }, "wait-event: event append failed");
    return false;
  }
}
