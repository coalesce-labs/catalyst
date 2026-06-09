// read-model-workers.ts — map the read-model's assembled BoardWorker[] onto the
// HUD's WorkerSignal[] shape (CTL-920 / HUD2).
//
// The HUD's Dashboard Workers view renders WorkerSignal rows it historically
// scanned itself from `~/catalyst/runs/<orch>/workers/*.json` (worker-signals-
// reader.ts). HUD2 makes the read-model the PRIMARY source: when the server is
// up, the assembled BoardWorker[] (the SAME slice the web/iPad render) is mapped
// to the WorkerSignal fields the WorkerList already knows how to draw, so the
// HUD shows the one assembled picture instead of re-deriving it. The raw scan
// stays the fallback when the server is down (chosen in the Dashboard).
//
// The mapping only fills the fields the Workers view actually reads (ticket,
// workerName, status, phaseName, lastHeartbeat, pr, startedAt) plus `raw` (the
// verbatim BoardWorker for the detail pane). Fields the read-model does not
// carry (legacy integer `phase`, `worktreePath`, `definitionOfDone`, …) are left
// null rather than fabricated — the list renders an em-dash for them, exactly as
// it does for a raw signal that omits them.

import type { BoardWorker } from "../../lib/read-model-client";
import type { WorkerSignal } from "./worker-signals-reader";

/**
 * Project the read-model's BoardWorker[] into WorkerSignal[] for the HUD's
 * Workers view. `nowMs` anchors the `lastActiveMs` → `lastHeartbeat` conversion
 * (injectable so tests are deterministic).
 */
export function boardWorkersToSignals(workers: BoardWorker[], nowMs: number): WorkerSignal[] {
  return workers.map((w) => boardWorkerToSignal(w, nowMs));
}

/**
 * The HUD's read-model-vs-raw worker source decision (CTL-920 / HUD2). When the
 * read-model is connected the caller passes the mapped read-model rows; null
 * means the server is down and the HUD must fall back to its raw-file scan. This
 * is the single, tested choke point for "one assembly, many readers" with a
 * graceful raw-file fallback — extracted so the rule is provable without
 * rendering the Dashboard.
 */
export function selectWorkers(
  readModelWorkers: WorkerSignal[] | null,
  rawWorkers: WorkerSignal[],
): WorkerSignal[] {
  return readModelWorkers ?? rawWorkers;
}

function boardWorkerToSignal(w: BoardWorker, nowMs: number): WorkerSignal {
  const lastHeartbeat =
    typeof w.lastActiveMs === "number" && Number.isFinite(w.lastActiveMs)
      ? new Date(nowMs - w.lastActiveMs).toISOString()
      : null;
  const startedAt =
    typeof w.startedAt === "number" && Number.isFinite(w.startedAt)
      ? new Date(w.startedAt).toISOString()
      : null;

  return {
    ticket: w.ticket,
    orchestrator: "",
    wave: null,
    workerName: w.name,
    label: null,
    status: w.status,
    stalledReason: null,
    phase: null,
    phaseName: w.phase || null,
    phaseTimestamps: {},
    lastHeartbeat,
    startedAt,
    updatedAt: lastHeartbeat,
    completedAt: null,
    worktreePath: null,
    // The read-model's worker slice carries no PR (PR lives on the ticket slice);
    // null renders an em-dash exactly as a raw signal without a PR does. We do
    // NOT fabricate one.
    pr: null,
    linearState: null,
    definitionOfDone: null,
    raw: w,
  };
}
