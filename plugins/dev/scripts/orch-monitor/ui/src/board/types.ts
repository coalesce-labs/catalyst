// Shared board types — hoisted out of Board.tsx (CTL-733 PR-2b) so the React
// view, the SharedWorker, and the transport client all agree on ONE shape.
// Mirrors the server's declared payload in lib/board-data.d.mts (intentionally a
// UI subset: BoardQueueItem.state is omitted because the board never renders it).
import type { ConnectionStatus } from "@/lib/types";

export type BoardActiveState = "active" | "stuck" | null;

export interface BoardWorker {
  name: string;
  ticket: string;
  tickets: string[];
  phase: string;
  status: string;
  activeState: BoardActiveState;
  working: boolean;
  lastActiveMs: number | null;
  repo: string;
  team: string;
  runtimeMs: number | null;
  costUSD: number | null;
  sessionId?: string;
}

export interface BoardPhaseCost {
  costUSD: number;
  tokens: number;
  turns: number;
}

export interface BoardPhaseTiming {
  phase: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BoardTicket {
  id: string;
  title: string;
  type: string;
  repo: string;
  team: string;
  phase: string;
  status: string;
  model: string | null;
  linearState: string;
  workerStatus: string | null;
  activeState: BoardActiveState;
  working: boolean;
  lastActiveMs: number | null;
  priority: number;
  estimate: number | null;
  scope: string | null;
  project: string | null;
  costUSD: number | null;
  tokens: number | null;
  turns: number | null;
  phaseCosts: Record<string, BoardPhaseCost> | null;
  phaseSummary: BoardPhaseTiming[];
  pr: number | null;
  updatedAt: string;
  subSteps?: WorkflowSubStep[];
  /** CTL-755 held indicator from the ticket's Linear labels: the admission gate
   *  holds a triaged-waiting ticket before the triage→research promotion. */
  held?: "blocked" | "waiting" | null;
  /** Dependency ids a `blocked` hold is waiting on (only meaningful when held === "blocked"). */
  blockers?: string[];
}

export interface WorkflowSubStep {
  ts: string;
  workflowName: string;
  stepLabel: string;
  stepIndex: number;
  status: "started" | "complete" | "failed";
}

export interface BoardQueueItem {
  id: string;
  title: string;
  priority: number;
  createdAt: string;
  repo: string;
  team: string;
  rank: number;
  estimate: number | null;
  scope: string | null;
  project: string | null;
}

export interface BoardConfig {
  maxParallel: number;
  inFlight: number;
  freeSlots: number;
  active: number;
  working: number;
  stuck: number;
}

export interface BoardPayload {
  generatedAt: string;
  config: BoardConfig;
  repos: string[];
  workers: BoardWorker[];
  tickets: BoardTicket[];
  queue: BoardQueueItem[];
}

// ── SharedWorker ⇄ client message protocol (CTL-733 PR-2b) ──────────────────
// One source of truth for the postMessage contract: because both board-worker.ts
// and board-client.ts import these, any drift between the two sides is a compile
// error rather than a silent runtime mismatch.

/** Messages the worker/leader pushes out to every connected port. */
export type BoardOutbound =
  | { kind: "snapshot"; payload: BoardPayload }
  | { kind: "status"; status: ConnectionStatus };

/** Messages a port sends back to the worker. `bye` lets the worker prune a port
 *  deterministically on tab/effect teardown — a closed MessagePort fires no event
 *  and postMessage to it is a silent no-op, so without this the worker can only
 *  learn a port is dead on a (never-arriving) failed send. */
export type BoardInbound = { kind: "reconcile" } | { kind: "bye" };

export type { ConnectionStatus };
