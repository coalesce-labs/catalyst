// projection-reader.mjs — CTL-1489: daemon-side projection-backed readers.
//
// Reconstruct the WorkerSignal / findHeldRun shapes from the broker's durable
// worker_state ⨝ latest ticket_state_transitions, with NO local-dir dependency —
// so a ticket served on another host is visible/recoverable here (closes the
// CTL-1475 gap). Daemon-only: it static-imports broker-state.mjs (which carries
// a top-level bun:sqlite import), mirroring scheduler.mjs's existing static
// broker import. It is NOT in the vite config graph, so a literal import is safe
// here — the orch-monitor twin (orch-monitor/lib/projection-reader.mjs) uses the
// computed-specifier form instead (CTL-1372).
//
// The broker DB must already be open (openBrokerStateDb) — the daemon opens it
// at boot; tests open a :memory: DB and seed before calling.

import {
  getAllWorkerStates,
  getLatestTicketStateTransition,
} from "../broker/broker-state.mjs";
import { workerStateRowToSignal, isHeldStatus } from "./projection-signal-map.mjs";

// readWorkerSignalsFromProjection — reconstruct one WorkerSignal per durable
// worker_state row. `orchDir` is accepted for call-site parity with
// readWorkerSignals(orchDir) but is intentionally ignored: the projection is a
// global (orchestrator, ticket) store, not dir-keyed. Optional `{ orchestrator }`
// narrows to one orchestrator's rows when a caller wants parity with a single
// orchDir's workers.
export function readWorkerSignalsFromProjection(orchDir, { orchestrator = null } = {}) {
  let rows;
  try {
    rows = getAllWorkerStates();
  } catch {
    return []; // DB not open / read failure → no signals (fail-safe, never throws)
  }
  const out = [];
  for (const row of rows) {
    if (orchestrator && row.orchestrator !== orchestrator) continue;
    let latest = null;
    try {
      latest = getLatestTicketStateTransition(row.ticket);
    } catch {
      latest = null;
    }
    const sig = workerStateRowToSignal(row, latest);
    if (sig) out.push(sig);
  }
  return out;
}

// findHeldRunFromProjection — the projection twin of respond-ticket.mjs
// findHeldRun. Returns { phase, signal } for the ticket's held run
// (status needs-input | stalled) reconstructed from durable state, or null.
export function findHeldRunFromProjection(ticket) {
  let rows;
  try {
    rows = getAllWorkerStates();
  } catch {
    return null;
  }
  for (const row of rows) {
    if (row.ticket !== ticket) continue;
    if (!isHeldStatus(row.status)) continue;
    let latest = null;
    try {
      latest = getLatestTicketStateTransition(ticket);
    } catch {
      latest = null;
    }
    const signal = workerStateRowToSignal(row, latest);
    return { phase: row.phase ?? null, signal };
  }
  return null;
}
