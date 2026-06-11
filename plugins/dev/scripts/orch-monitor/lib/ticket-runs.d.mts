// Type declarations for ticket-runs.mjs (CTL-886, BFF4) — the run→worker
// identity layer. Lets the typechecked TS server (server.ts) import
// assembleTicketRuns / readPhaseSignalVerbatim without a TS7016 implicit-any
// error. Keep in sync with the objects assembled in ticket-runs.mjs.

/** Host attribution for a run (single-host identity no-op default — CTL-886). */
export interface RunHost {
  name: string;
  id: string;
}

/** Per-run cost, JOINED from catalyst.db (never fabricated onto the signal). */
export interface RunCost {
  costUSD: number;
  tokens: number;
  turns: number;
}

/**
 * One phase-agent execution surfaced as a RUN entity. Identity + timestamp
 * fields are carried straight through from the phase-<phase>.json signal; `host`
 * is resolved (signal value or single-host default); `pr` is the signal's own
 * verbatim PR shape (null when the phase carries none); `cost` is the joined
 * telemetry row or null.
 */
export interface TicketRun {
  ticket: string | null;
  phase: string;
  status: string;
  model: string | null;
  bg_job_id: string | null;
  attempt: number | null;
  generation: number | null;
  orchestrator: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  host: RunHost;
  worktreePath: string | null;
  sessionId: string | null;
  /** Verbatim PR shape from the signal (phase-pr / monitor-merge / deploy / draftPr). */
  pr: Record<string, unknown> | null;
  /** Joined per-phase cost from catalyst.db, or null when no telemetry row. */
  cost: RunCost | null;
}

/** A ticket's full run history — one run per phase-*.json signal on disk. */
export interface TicketRuns {
  ticket: string;
  runs: TicketRun[];
}

export interface TicketRunsOptions {
  workersDir?: string;
  dbPath?: string;
}

export function toRunEntity(
  phase: string,
  sig: Record<string, unknown>,
  costRow?: RunCost,
): TicketRun;

export function assembleTicketRuns(
  ticket: string,
  options?: TicketRunsOptions,
): Promise<TicketRuns>;

export function readPhaseSignalVerbatim(
  ticket: string,
  phase: string,
  options?: { workersDir?: string },
): Promise<Record<string, unknown> | null>;
