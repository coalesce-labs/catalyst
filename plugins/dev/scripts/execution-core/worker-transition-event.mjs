// worker-transition-event.mjs — CTL-764 Phase 3: worker.transition canonical event.
//
// Generalised from linear-state-write-event.mjs (CTL-757). Emits one
// worker.transition.<TICKET> INFO event per genuine two-axis transition (stage
// change OR disposition change). Dims go in BOTH attributes (for OTLP / otel-forward
// which drops body.payload off-machine per otlp.ts:51-52) AND body.payload (for the
// broker reducer which reads raw JSONL lines). Phase 6 adds the Attributes type
// declaration; this module targets the same key names by convention.
//
// channel="execution-core" (NOT "webhook"): distinguishes daemon-initiated transitions
// from inbound state_changed webhook echoes.
// actor="catalyst.execution-core": human-vs-daemon discriminator.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

/**
 * buildWorkerTransitionEvent — returns a canonical JSONL line (string + "\n")
 * for the worker.transition.<TICKET> INFO event.
 *
 * Both pipeline-stage (fromStage/toStage) and disposition (fromDisposition/toDisposition)
 * are optional — pass only the axes that changed. Dims land in attributes for OTLP
 * and in body.payload for the broker reducer.
 */
export function buildWorkerTransitionEvent({
  ticket,
  orchId = null,
  fromStage = null,
  toStage = null,
  fromDisposition = null,
  toDisposition = null,
  reason = null,
  attempt = null,
  reviveCount = null,
  source = null,
  project = null,
  linearKey = null,
  branch = null,
  taskType = null,
  actor = "catalyst.execution-core",
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const orchVal = orchId ?? ticket;

  const attributes = {
    "event.name": `worker.transition.${ticket}`,
    "event.entity": "worker",
    "event.action": "transition",
    "event.label": ticket,
    "event.channel": "execution-core",
    "catalyst.orchestration": orchVal,
    "linear.issue.identifier": ticket,
    // Two-axis worker state dims — scalar strings (not arrays, not JSON-encoded).
    // OTLP forwarder reads ev.attributes; body.payload is dropped off-machine.
    "catalyst.worker.from_state": fromStage,
    "catalyst.worker.to_state": toStage,
    "catalyst.worker.from_disposition": fromDisposition,
    "catalyst.worker.to_disposition": toDisposition,
    "catalyst.worker.reason": reason,
  };
  // intValue dims — phase.attempt / phase.revive_count as numbers (CTL-636 pattern).
  if (attempt !== null && attempt !== undefined) {
    attributes["phase.attempt"] = Number(attempt);
  }
  if (reviveCount !== null && reviveCount !== undefined) {
    attributes["phase.revive_count"] = Number(reviveCount);
  }

  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "INFO",
      severityNumber: 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      channel: "execution-core",
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes,
      body: {
        payload: {
          ticket,
          actor,
          source,
          from_stage: fromStage,
          to_stage: toStage,
          from_disposition: fromDisposition,
          to_disposition: toDisposition,
          reason,
          attempt,
          revive_count: reviveCount,
          project,
          linearKey,
          branch,
          taskType,
        },
      },
    }) + "\n"
  );
}

/**
 * appendWorkerTransitionEvent — appends the event to the canonical event log.
 * Inject `append` in tests. Returns true on success, false on any error (swallow).
 */
export function appendWorkerTransitionEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildWorkerTransitionEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message }, "worker-transition-event: append failed");
    return false;
  }
}
