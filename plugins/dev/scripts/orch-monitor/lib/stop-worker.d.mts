// Type declarations for stop-worker.mjs (CTL-890, BFF8) — the read-model's ONE
// destructive endpoint (the design's P10). Lets the strict TS server (server.ts)
// import stopWorker without a TS7016 implicit-any error. Keep in sync with the
// objects returned in stop-worker.mjs.

/** Verbatim phase signal shape (the subset stopWorker reads). */
interface PhaseSignalLike {
  bg_job_id?: unknown;
  generation?: unknown;
  status?: unknown;
  phase?: unknown;
  ticket?: unknown;
  [key: string]: unknown;
}

/**
 * The injectable spawnSync seam. Typed as the SUBSET of the spawnSync return the
 * lib actually reads (status/stdout/stderr/error), so unit-test fakes can return
 * a minimal object without satisfying the full SpawnSyncReturns shape (pid/output/
 * signal). The real spawnSync return is structurally assignable to this.
 */
export type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options?: unknown,
) => {
  status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

/** Outcome of the cross-host fence-check (single-host no-op pass or CLI). */
export interface FenceOutcome {
  /** true ⇒ proceed (current, or single-host no-op). */
  ok: boolean;
  /** true ⇒ single-host identity no-op pass (no subprocess ran). */
  noop: boolean;
  /** true ⇒ VERIFIED stale (fence CLI exit 10) — a partitioned/stale generation. */
  stale: boolean;
}

/** Result of the `claude stop <shortId>` primitive. */
export interface ClaudeStopResult {
  ok: boolean;
  error?: string;
}

/**
 * Discriminated outcome of stopWorker; the route maps `status` to an HTTP code.
 * - not_found            → 404 (no run signal on disk)
 * - confirm_mismatch     → 400 (typed confirm did not match the ticket id)
 * - no_session           → 409 (run never had a live bg session)
 * - fenced               → 409 (verified-stale fence; a partitioned node rejected)
 * - fence_indeterminate  → 409 (multi-host fence unconfirmed; refuse to kill)
 * - stop_failed          → 502 (`claude stop` errored)
 * - stopping             → 200 (kill issued; UI marks `stopping` + arms rollback)
 */
export type StopWorkerResult =
  | { status: "not_found" }
  | { status: "confirm_mismatch"; expected: string }
  | { status: "no_session"; ticket: string; phase: string }
  | { status: "fenced"; ticket: string; phase: string; shortId: string }
  | { status: "fence_indeterminate"; ticket: string; phase: string; shortId: string }
  | { status: "stop_failed"; ticket: string; phase: string; shortId: string; error?: string }
  | { status: "stopping"; ticket: string; phase: string; shortId: string; fenceNoop: boolean };

export function readClusterHostCount(opts?: {
  env?: Record<string, string | undefined>;
  read?: (path: string, encoding: "utf8") => string;
}): number;

export function runFenceCheck(
  args: { ticket: string; generation: number | null },
  opts?: {
    hostCount?: number;
    spawn?: SpawnSyncLike;
    nodeBin?: string;
    cli?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
  },
): FenceOutcome;

export function claudeStop(
  shortId: string,
  opts?: { spawn?: SpawnSyncLike },
): ClaudeStopResult;

export function stopWorker(
  args: { ticket: string; phase: string; confirm: unknown },
  opts?: {
    readSignal?: (ticket: string, phase: string) => Promise<PhaseSignalLike | null>;
    fenceCheck?: (args: { ticket: string; generation: number | null }) => FenceOutcome;
    stop?: (shortId: string) => ClaudeStopResult;
  },
): Promise<StopWorkerResult>;
