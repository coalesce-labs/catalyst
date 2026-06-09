// Type declarations for board-data.mjs (plain-JS data layer for the CTL-727
// Worker/Ticket board). Lets the typechecked TS server (server.ts) and the
// Vite config import assembleBoard() without a TS7016 implicit-any error.
// Keep in sync with the object assembled in board-data.mjs.

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
  /** CC-UUID from `claude agents --json .sessionId` (Prometheus/Loki claude-code key). */
  sessionId: string;
  /** CTL-888 (BFF6) P6: exact wall-clock start (epoch ms) for precise elapsed. */
  startedAt: number | null;
  /** CTL-888 (BFF6) P7: OS pid of the bg worker. */
  pid: number | null;
  /** CTL-888 (BFF6) P7: catalyst `sess_…` id (catalyst.session heartbeat key); null when unknown. */
  catalystSessionId: string | null;
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
  /** CTL-888 (BFF6) P5: per-phase model for the spine + gantt; null when absent. */
  model: string | null;
}

export interface BoardCurrentPhase {
  phase: string;
  status: string;
  model: string | null;
  startedAt?: string;
  updatedAt?: string;
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
  /** CTL-755 held indicator from the ticket's Linear labels. */
  held: "blocked" | "waiting" | null;
  /** Dependency ids a `blocked` hold is waiting on (from triage.json). */
  blockers: string[];
}

export interface BoardQueueItem {
  id: string;
  title: string;
  priority: number;
  createdAt: string;
  state: string | null;
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

export const PHASE_ORDER: string[];
export const PHASE_TO_LINEAR: Record<string, string>;
export const TERMINAL: Set<string>;
export const HELD_LABEL_BLOCKED: string;
export const HELD_LABEL_WAITING: string;
export function heldFor(labels: unknown): "blocked" | "waiting" | null;
export function buildPhaseSummary(phaseSigs: unknown[], now: number): BoardPhaseTiming[];
export function deriveCurrentPhase(phaseSigs: unknown[]): BoardCurrentPhase;
export function assembleBoard(): Promise<BoardPayload>;
