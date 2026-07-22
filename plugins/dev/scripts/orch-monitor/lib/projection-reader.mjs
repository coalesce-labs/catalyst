// projection-reader.mjs — CTL-1489: vite-safe orch-monitor twin of the daemon
// projection reader (execution-core/projection-reader.mjs). Reconstructs the
// WorkerSignal / findHeldRun shapes from the broker's durable worker_state ⨝
// latest ticket_state_transitions, with NO local-dir dependency, so the board
// (and respond-ticket) can see a ticket served on another host.
//
// CTL-1372 (vite-graph trap): broker-state.mjs carries a top-level
// `import { Database } from "bun:sqlite"`. board-data.mjs (Phase 6) will
// static-import THIS module, and ui/vite.config.ts static-imports board-data.mjs,
// so a LITERAL dynamic import of the broker-state module here would let esbuild
// follow the relative graph and pull bun:sqlite into the Node-evaluated vite
// config bundle → ERR_UNSUPPORTED_ESM_URL_SCHEME, breaking `vite build` (the
// monitor's deploy path). The specifier MUST be a module-level COMPUTED string so
// it stays an opaque runtime import() esbuild can't follow. DO NOT inline it to
// a literal. Under Bun at runtime the string resolves identically.
//
// projection-signal-map.mjs is PURE (no bun:sqlite), so it is a safe static
// import and keeps this reader byte-for-byte in lock-step with the daemon twin.

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workerStateRowToSignal, isHeldStatus } from "../../execution-core/projection-signal-map.mjs";

// CTL-1372: computed specifier — see the header note. DO NOT inline to a literal.
const BROKER_STATE_MODULE = ["..", "..", "broker", "broker-state.mjs"].join("/");

// The broker worker_state / ticket_state_transitions tables live in filter-state.db
// (broker-state.mjs DEFAULT_DB_PATH). Resolved per-call, honoring CATALYST_DIR.
function defaultBrokerDbPath() {
  return join(process.env.CATALYST_DIR || join(homedir(), "catalyst"), "filter-state.db");
}

// readWorkerSignalsFromProjection — reconstruct one WorkerSignal per durable
// worker_state row. Async: the broker-state import is dynamic (vite-safe).
export async function readWorkerSignalsFromProjection(dbPath = defaultBrokerDbPath(), { orchestrator = null } = {}) {
  if (!existsSync(dbPath)) return [];
  let mod;
  try {
    mod = await import(BROKER_STATE_MODULE);
  } catch {
    return [];
  }
  const { openBrokerStateDb, getAllWorkerStates, getLatestTicketStateTransition } = mod;
  try {
    openBrokerStateDb(dbPath);
    const out = [];
    for (const row of getAllWorkerStates()) {
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
  } catch {
    return [];
  }
}

// findHeldRunFromProjection — projection twin of respond-ticket.mjs findHeldRun.
// Returns { phase, signal } for the ticket's held run (needs-input | stalled)
// reconstructed from durable state, or null.
export async function findHeldRunFromProjection(ticket, dbPath = defaultBrokerDbPath()) {
  if (!existsSync(dbPath)) return null;
  let mod;
  try {
    mod = await import(BROKER_STATE_MODULE);
  } catch {
    return null;
  }
  const { openBrokerStateDb, getAllWorkerStates, getLatestTicketStateTransition } = mod;
  try {
    openBrokerStateDb(dbPath);
    for (const row of getAllWorkerStates()) {
      if (row.ticket !== ticket) continue;
      if (!isHeldStatus(row.status)) continue;
      let latest = null;
      try {
        latest = getLatestTicketStateTransition(ticket);
      } catch {
        latest = null;
      }
      return { phase: row.phase ?? null, signal: workerStateRowToSignal(row, latest) };
    }
    return null;
  } catch {
    return null;
  }
}
