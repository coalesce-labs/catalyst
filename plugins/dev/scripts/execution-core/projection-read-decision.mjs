// projection-read-decision.mjs — CTL-1489: the shared off/shadow/enforce
// decision seam for the durable-projection read cutover. Encodes the whole
// contract in one pure, testable place so every consumer (scheduler reclaim,
// respond-ticket findHeldRun, board-data readTicketArtifacts, daemon
// handleCommentWake) routes its local-vs-projection choice identically.
//
// Contract (mode from readProjectionReadConfig()):
//   off      → return the LOCAL value (byte-identical to pre-projection behavior).
//   shadow   → return the LOCAL value, but diff local vs projection and emit one
//              projection.read.drift.<ticket> on mismatch (no decision change).
//   enforce  → return the PROJECTION value, falling back to LOCAL only when the
//              projection has NO row for that ticket (projectionPresent === false).
//              Never the reverse — a present projection governs.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// Default structural equality good enough for the WorkerSignal/held-run shapes.
// Consumers pass a custom `isEqual` when volatile fields (signalPath, updatedAt,
// host) must be normalized out of the comparison to avoid manufacturing drift.
function defaultIsEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// pickReader — the decision. See the contract above.
export function pickReader(
  mode,
  { local, projection, projectionPresent = projection != null, ticket = null, emit = null, isEqual = defaultIsEqual } = {}
) {
  if (mode === "enforce") {
    return projectionPresent ? projection : local;
  }
  if (mode === "shadow") {
    if (!isEqual(local, projection) && typeof emit === "function") {
      try {
        emit(ticket);
      } catch {
        /* drift emit is best-effort — never affects the decision */
      }
    }
    return local;
  }
  // off (and any unrecognized mode) → local, no diff.
  return local;
}

function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildProjectionDriftEvent — a filter.*/broker.*-clean INFO event the broker
// won't self-ingest. `source` names the consumer that observed the drift.
export function buildProjectionDriftEvent({ ticket, source = null } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "INFO",
      severityNumber: 9,
      channel: "execution-core",
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": `projection.read.drift.${ticket}`,
        "event.entity": "projection",
        "event.action": "drift",
        "event.label": ticket,
        "event.channel": "execution-core",
        "catalyst.worker.ticket": ticket,
        ...(source ? { "projection.drift.source": source } : {}),
      },
      body: { payload: { ticket, source } },
    }) + "\n"
  );
}

// emitProjectionDrift — append the drift event. Inject `append` in tests.
// Returns true on success, false on any error (swallowed).
export function emitProjectionDrift({ ticket, source = null, append = defaultAppend } = {}) {
  try {
    append(buildProjectionDriftEvent({ ticket, source }));
    return true;
  } catch (err) {
    log.warn?.({ err: err?.message }, "emitProjectionDrift: append failed");
    return false;
  }
}
