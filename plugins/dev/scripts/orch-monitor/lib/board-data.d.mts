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
  sessionId: string;
}

export interface BoardPhaseCost {
  costUSD: number;
  tokens: number;
  turns: number;
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
  pr: number | null;
  updatedAt: string;
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
export function assembleBoard(): Promise<BoardPayload>;
