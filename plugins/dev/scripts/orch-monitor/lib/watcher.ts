import { watch, type FSWatcher } from "fs";
import {
  buildSnapshot,
  type MonitorSnapshot,
  type WorkerState,
} from "./state-reader";
import { emit } from "./event-bus";

export interface WatcherHandle {
  stop: () => void;
}

export interface WorkerChange {
  orchId: string;
  worker: WorkerState;
}

function flattenWorkers(snap: MonitorSnapshot): Map<string, WorkerChange> {
  const out = new Map<string, WorkerChange>();
  for (const orch of snap.orchestrators) {
    for (const [key, w] of Object.entries(orch.workers)) {
      out.set(`${orch.id}:${key}`, { orchId: orch.id, worker: w });
    }
  }
  return out;
}

export function diffWorkers(
  prev: MonitorSnapshot,
  next: MonitorSnapshot,
): WorkerChange[] {
  const prevMap = flattenWorkers(prev);
  const nextMap = flattenWorkers(next);
  const changed: WorkerChange[] = [];
  for (const [k, v] of nextMap) {
    const before = prevMap.get(k);
    if (
      !before ||
      before.worker.status !== v.worker.status ||
      before.worker.phase !== v.worker.phase ||
      before.worker.updatedAt !== v.worker.updatedAt ||
      before.worker.pid !== v.worker.pid
    ) {
      changed.push(v);
    }
  }
  return changed;
}

export function diffLiveness(
  prev: MonitorSnapshot,
  next: MonitorSnapshot,
): WorkerChange[] {
  const prevMap = flattenWorkers(prev);
  const nextMap = flattenWorkers(next);
  const flipped: WorkerChange[] = [];
  for (const [k, v] of nextMap) {
    const before = prevMap.get(k);
    if (before && before.worker.alive !== v.worker.alive) {
      flipped.push(v);
    }
  }
  return flipped;
}

export function isRelevant(filename: string): boolean {
  const norm = filename.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  if (base.startsWith(".")) return false;
  if (filename.endsWith(".json")) {
    return norm.includes("workers/") || base === "state.json";
  }
  if (/^wave-\d+-briefing\.md$/.test(base)) return true;
  if (base === "DASHBOARD.md") return true;
  return false;
}

export const DEBOUNCE_MS = 200;
export const LIVENESS_INTERVAL_MS = 5000;
export const SNAPSHOT_INTERVAL_MS = 30000;

export function startWatching(baseDir: string): WatcherHandle {
  let lastSnapshot: MonitorSnapshot = buildSnapshot(baseDir);
  emit("snapshot", lastSnapshot);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(baseDir, { recursive: true }, (_event, filename) => {
      if (!filename || !isRelevant(String(filename))) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = buildSnapshot(baseDir);
        for (const change of diffWorkers(lastSnapshot, next)) {
          emit("worker-update", change);
        }
        lastSnapshot = next;
      }, DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      console.error(`[watcher] fs.watch error on ${baseDir}:`, err);
    });
  } catch (err) {
    console.error(
      `[watcher] fs.watch failed to start on ${baseDir} (falling back to polling):`,
      err,
    );
  }

  const livenessInterval = setInterval(() => {
    const next = buildSnapshot(baseDir);
    for (const flip of diffLiveness(lastSnapshot, next)) {
      emit("liveness-change", flip);
    }
    lastSnapshot = next;
  }, LIVENESS_INTERVAL_MS);

  const snapshotInterval = setInterval(() => {
    lastSnapshot = buildSnapshot(baseDir);
    emit("snapshot", lastSnapshot);
  }, SNAPSHOT_INTERVAL_MS);

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(livenessInterval);
      clearInterval(snapshotInterval);
      try {
        watcher?.close();
      } catch (err) {
        console.error(`[watcher] close failed:`, err);
      }
    },
  };
}
