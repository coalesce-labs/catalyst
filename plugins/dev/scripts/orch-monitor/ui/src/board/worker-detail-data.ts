// worker-detail-data.ts — PURE logic for the worker detail page body
// (CTL-914 / DETAIL3). Deliberately React-/DOM-free so it can be unit-tested
// under `bun test` directly (same pattern as detail-chrome.ts / route-search.ts).
//
// It owns the diagnostics math (liveness colour, stale-bg gate), the header
// field resolution (signal-model AVAILABLE-NOW vs the bg_job_id/attempt/gen rows
// that are NEEDS-PLUMBING until the BFF ec-worker endpoint), the THIS-RUN phase
// timestamp extraction, and the BoardWorker scalar fallbacks — every value is a
// real field or an honest `null`/NEEDS-PLUMBING marker, NEVER a fabricated one.

import type { BoardWorker } from "./types";

// ── stale-bg gate: the literal daemon revive threshold ──────────────────────
// The execution-core daemon revives a worker whose bg job has gone stale after
// EXECUTION_CORE_GHOST_GRACE_MS (`execution-core/config.mjs:264`, default 90s).
// The worker page's stale-bg gate shows `idle / 90s` against THIS literal so the
// operator reads the same number the daemon acts on — not an invented one.
export const STALE_BG_GATE_MS = 90_000;

// ── liveness indicator: green → yellow → red off now − lastActiveMs ──────────
// The primary stuck-tell (design §5.2). Thresholds mirror the board's own
// staleness bands (WORKING_MS 45s "generating right now", STUCK_MS 30m
// "abandoned"; board-data.mjs:156-157). Between them the worker is "idle but
// not yet stuck" → yellow. A null lastActiveMs (no transcript seen) is "unknown".
export const LIVENESS_GREEN_MS = 45_000; // < 45s idle → actively generating
export const LIVENESS_RED_MS = 1_800_000; // > 30m idle → likely stuck/abandoned

export type LivenessLevel = "green" | "yellow" | "red" | "unknown";

export interface LivenessState {
  level: LivenessLevel;
  /** now − lastActiveMs, or null when lastActiveMs is absent. */
  idleMs: number | null;
}

/** Derive the liveness indicator from the resident `lastActiveMs` and a clock. */
export function deriveLiveness(
  lastActiveMs: number | null | undefined,
  now: number,
): LivenessState {
  if (lastActiveMs == null) return { level: "unknown", idleMs: null };
  const idleMs = Math.max(0, now - lastActiveMs);
  if (idleMs < LIVENESS_GREEN_MS) return { level: "green", idleMs };
  if (idleMs >= LIVENESS_RED_MS) return { level: "red", idleMs };
  return { level: "yellow", idleMs };
}

export interface StaleBgGateState {
  /** Idle ms measured the same way as liveness (now − lastActiveMs). */
  idleMs: number | null;
  thresholdMs: number;
  /** true once idle exceeds the daemon's ghost-grace — the daemon would revive. */
  tripped: boolean;
}

/** The stale-bg gate: idle vs the 90s daemon revive threshold. `tripped` mirrors
 *  when the daemon's ghost-grace would fire — `false` (and dimmed by the caller)
 *  when lastActiveMs is absent (we can't claim it tripped without data). */
export function deriveStaleBgGate(
  lastActiveMs: number | null | undefined,
  now: number,
): StaleBgGateState {
  if (lastActiveMs == null) {
    return { idleMs: null, thresholdMs: STALE_BG_GATE_MS, tripped: false };
  }
  const idleMs = Math.max(0, now - lastActiveMs);
  return { idleMs, thresholdMs: STALE_BG_GATE_MS, tripped: idleMs >= STALE_BG_GATE_MS };
}

// ── the verbatim phase signal (from /api/ec-worker/<ticket>/<phase>) ─────────
// The signal is served untransformed (Record<string, unknown>), so we read its
// fields defensively. AVAILABLE-NOW from the signal: model, bg_job_id, attempt,
// generation, startedAt/completedAt. Each absent field stays null (dimmed).
export interface PhaseSignalFields {
  model: string | null;
  bgJobId: string | null;
  attempt: number | null;
  generation: number | null;
  startedAt: string | null;
  completedAt: string | null;
  status: string | null;
}

function sigStr(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function sigNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Extract the header/timestamp fields from one verbatim phase signal. A null
 *  signal (no on-disk file → 404) yields all-null (every header row dims). */
export function readPhaseSignalFields(
  signal: Record<string, unknown> | null,
): PhaseSignalFields {
  const s = signal ?? {};
  return {
    model: sigStr(s["model"]),
    bgJobId: sigStr(s["bg_job_id"]) ?? sigStr(s["bgJobId"]),
    attempt: sigNum(s["attempt"]),
    generation: sigNum(s["generation"]) ?? sigNum(s["gen"]),
    startedAt: sigStr(s["startedAt"]) ?? sigStr(s["started_at"]),
    completedAt: sigStr(s["completedAt"]) ?? sigStr(s["completed_at"]),
    status: sigStr(s["status"]),
  };
}

/** The header's model line. The design is explicit: model is SIGNAL-served, NOT
 *  a BoardWorker field — so it resolves from the verbatim signal alone and dims
 *  (null) until that fetch lands. `worker` is accepted for symmetry with the
 *  other header resolvers but contributes no model (BoardWorker carries none). */
export function resolveHeaderModel(
  signal: PhaseSignalFields | null,
  _worker: BoardWorker | undefined,
): string | null {
  return signal?.model ?? null;
}

// ── PHASE TIMESTAMPS — THIS run's phases only (the IA cut) ───────────────────
// The worker page shows only the phases of THIS run (not the full-lifecycle
// gantt, which lives on the ticket page). The verbatim signal is one phase's
// file; a run is one phase execution, so "this run's phases" is the single phase
// the page is bound to plus whatever phaseTimestamps the signal itself carries.
export interface PhaseTimestamp {
  phase: string;
  startedAt: string | null;
  completedAt: string | null;
  /** the phase the page is currently bound to (the active run's phase). */
  current: boolean;
}

/** Build the THIS-RUN phase-timestamp list from the verbatim signal. The signal
 *  may carry a `phaseTimestamps` map ({phase: iso}) for the run's lifecycle; if
 *  it does we surface those, marking `currentPhase`. Otherwise we surface the
 *  single bound phase with the signal's own started/completed. Never invents a
 *  phase that the signal doesn't attest. */
export function readRunPhaseTimestamps(
  signal: Record<string, unknown> | null,
  currentPhase: string,
): PhaseTimestamp[] {
  const fields = readPhaseSignalFields(signal);
  const raw = signal?.["phaseTimestamps"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    const out: PhaseTimestamp[] = [];
    for (const [phase, ts] of Object.entries(map)) {
      out.push({
        phase,
        startedAt: sigStr(ts),
        completedAt: null,
        current: phase === currentPhase,
      });
    }
    if (out.length > 0) return out;
  }
  // Single-phase fallback: the run IS this phase.
  return [
    {
      phase: currentPhase,
      startedAt: fields.startedAt,
      completedAt: fields.completedAt,
      current: true,
    },
  ];
}

// ── BoardWorker scalar fallbacks (resident, AVAILABLE-NOW) ───────────────────
export interface WorkerScalars {
  costUSD: number | null;
  runtimeMs: number | null;
  sessionId: string | null;
  /** The catalyst sess_ id (second id space) — null when catalyst.db has no row. */
  catalystSessionId: string | null;
}

export function readWorkerScalars(worker: BoardWorker | undefined): WorkerScalars {
  return {
    costUSD: worker?.costUSD ?? null,
    runtimeMs: worker?.runtimeMs ?? null,
    sessionId: worker?.sessionId ?? null,
    catalystSessionId: worker?.catalystSessionId ?? null,
  };
}

// ── death-freeze: ring grey, status flips, NO layout reflow ──────────────────
// On the worker's death the header ring freezes grey and the status flips to
// complete/failed. `isAlive` mirrors the title-dot rule (working && active);
// the caller keeps the SAME DOM (no conditional remove) so there is zero reflow.
export function isWorkerAlive(worker: BoardWorker | undefined): boolean {
  return !!worker && worker.working && worker.activeState === "active";
}
