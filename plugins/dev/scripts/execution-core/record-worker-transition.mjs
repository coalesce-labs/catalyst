// record-worker-transition.mjs — CTL-764 Phase 3: single chokepoint for worker transitions.
//
// All seams are injectable so the module stays decoupled from production defaults.
// Phase 5 will wire the production defaults (real applyPhaseStatus, convergeDispositionLabel,
// appendWorkerTransitionEvent) and route all call sites here.
//
// Per-sink fail-open: each sink runs in its own try/catch so one failure never
// blocks the others. Returns { stageResult, labelWrites, eventEmitted }.
import { log } from "./config.mjs";

/**
 * recordWorkerTransition — record a worker state transition across all sinks:
 *   Sink 1: Linear workflow status (via applyPhaseStatus / applyTerminalDone)
 *   Sink 2: Linear disposition label (via convergeLabel)
 *   Sink 3: Unified event log (via appendWorkerTransitionEvent)
 *
 * All seams are injected — production callers supply the real implementations;
 * tests inject fakes. Each sink is fail-open (try/catch) so one failure never
 * prevents the others.
 *
 * @param {object} opts
 * @param {string} opts.ticket
 * @param {string} [opts.orchId]
 * @param {string} [opts.toStage]        Linear phase key (e.g. "plan", "implement").
 *                                       Omit for disposition-only transitions.
 * @param {boolean} [opts.isTerminal]    When true uses applyTerminalDone (done key).
 * @param {string} [opts.fromStage]      Previous stage (for event dims).
 * @param {string} [opts.fromDisposition]
 * @param {string} [opts.toDisposition]
 * @param {string} [opts.reason]
 * @param {number} [opts.attempt]
 * @param {number} [opts.reviveCount]
 * @param {string} [opts.source]
 * @param {string} [opts.project]
 * @param {string} [opts.linearKey]
 * @param {string} [opts.branch]
 * @param {string} [opts.taskType]
 * @param {Function} [opts.applyPhaseStatus]          Sink-1 injected impl.
 * @param {Function} [opts.convergeLabel]             Sink-2 injected impl.
 * @param {Function} [opts.appendWorkerTransitionEvent] Sink-3 injected impl.
 * @returns {Promise<{stageResult: object|null, labelWrites: number|null, eventEmitted: boolean}>}
 */
export async function recordWorkerTransition({
  ticket,
  orchId = null,
  toStage = null,
  isTerminal = false,
  fromStage = null,
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
  applyPhaseStatus = null,
  convergeLabel = null,
  appendWorkerTransitionEvent = null,
} = {}) {
  let stageResult = null;
  let labelWrites = null;
  let eventEmitted = false;

  // Sink 1 — Linear workflow status.
  // Only invoked when a stage transition is requested (toStage or isTerminal).
  if ((toStage || isTerminal) && applyPhaseStatus) {
    try {
      stageResult = await applyPhaseStatus({ ticket, phase: toStage, isTerminal });
    } catch (err) {
      log.error(
        { err: err?.message, ticket },
        "recordWorkerTransition: Sink-1 (applyPhaseStatus) failed"
      );
    }
  }

  // Resolve from/to stage from the stageResult (runTransition's return) when available.
  const resolvedFromStage = stageResult?.from_state ?? fromStage;
  const resolvedToStage = stageResult?.to_state ?? toStage;

  // Sink 2 — disposition label convergence.
  if (convergeLabel) {
    try {
      labelWrites = await convergeLabel({ ticket, toDisposition, fromDisposition });
    } catch (err) {
      log.error(
        { err: err?.message, ticket },
        "recordWorkerTransition: Sink-2 (convergeLabel) failed"
      );
    }
  }

  // Sink 3 — unified event log. Fail-open: any throw from an injected
  // appendWorkerTransitionEvent (e.g. a test spy) is caught here so callers
  // are never aborted by event-log failures.
  if (appendWorkerTransitionEvent) {
    try {
      eventEmitted = appendWorkerTransitionEvent({
        ticket,
        orchId,
        fromStage: resolvedFromStage,
        toStage: resolvedToStage,
        fromDisposition,
        toDisposition,
        reason,
        attempt,
        reviveCount,
        source,
        project,
        linearKey,
        branch,
        taskType,
      });
    } catch (err) {
      log.error(
        { err: err?.message, ticket },
        "recordWorkerTransition: Sink-3 (appendWorkerTransitionEvent) failed"
      );
    }
  }

  return { stageResult, labelWrites, eventEmitted };
}
