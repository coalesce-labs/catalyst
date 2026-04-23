import { existsSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import {
  readOrchestratorState,
  type OrchestratorState,
  type WorkerState,
} from "../state-reader";

export interface SummarizeSnapshot {
  orchId: string;
  state: OrchestratorState;
  workers: Record<string, WorkerState>;
  briefings: Record<number, string>;
  summaryMd: string | null;
  snapshotHash: string;
}

const SAFE_ORCH_ID = /^[A-Za-z0-9._-]+$/;

export function isSafeOrchId(id: string): boolean {
  if (id.length === 0 || id.length > 120) return false;
  if (id === "." || id === "..") return false;
  return SAFE_ORCH_ID.test(id);
}

function hashSnapshotInput(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function buildSummarizeSnapshot(
  wtDir: string,
  orchId: string,
): SummarizeSnapshot | null {
  if (!isSafeOrchId(orchId)) return null;

  const resolvedWt = resolve(wtDir);
  const orchDir = resolve(wtDir, orchId);
  if (orchDir !== resolvedWt && !orchDir.startsWith(resolvedWt + sep)) {
    return null;
  }
  if (!existsSync(orchDir)) return null;

  let state: OrchestratorState;
  try {
    state = readOrchestratorState(orchDir);
  } catch (err) {
    console.error(
      `[summarize] readOrchestratorState failed for ${orchId}:`,
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }

  const summaryPath = join(orchDir, "SUMMARY.md");
  const summaryMd = existsSync(summaryPath)
    ? readFileSync(summaryPath, "utf8")
    : null;

  const normalizedWorkers: Record<string, Record<string, unknown>> = {};
  for (const [key, worker] of Object.entries(state.workers)) {
    const { timeSinceUpdate: _t, alive: _a, ...rest } = worker;
    normalizedWorkers[key] = rest;
  }

  const hashInput = {
    workers: normalizedWorkers,
    briefings: state.briefings,
    waves: state.waves,
    currentWave: state.currentWave,
    summaryMd,
  };

  return {
    orchId,
    state,
    workers: state.workers,
    briefings: state.briefings,
    summaryMd,
    snapshotHash: hashSnapshotInput(hashInput),
  };
}
