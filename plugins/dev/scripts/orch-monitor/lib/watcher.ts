import { watch, type FSWatcher } from "fs";
import {
  buildSnapshot,
  type MonitorSnapshot,
  type WorkerState,
  type SessionState,
  type BuildSnapshotOptions,
} from "./state-reader";
import { emit } from "./event-bus";
import { createEvent } from "./events";

export interface WatcherHandle {
  stop: () => void;
}

export interface WorkerChange {
  orchId: string;
  worker: WorkerState;
}

export interface SessionChange {
  session: SessionState;
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

function flattenSessions(snap: MonitorSnapshot): Map<string, SessionState> {
  const out = new Map<string, SessionState>();
  for (const s of snap.sessions) out.set(s.sessionId, s);
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

export function diffSessions(
  prev: MonitorSnapshot,
  next: MonitorSnapshot,
): SessionChange[] {
  const prevMap = flattenSessions(prev);
  const nextMap = flattenSessions(next);
  const changed: SessionChange[] = [];
  for (const [id, s] of nextMap) {
    const before = prevMap.get(id);
    if (
      !before ||
      before.status !== s.status ||
      before.phase !== s.phase ||
      before.updatedAt !== s.updatedAt ||
      before.pid !== s.pid
    ) {
      changed.push({ session: s });
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
export const SQLITE_POLL_INTERVAL_MS = 2000;

export interface StartWatchingOptions {
  dbPath?: string | null;
  sqlitePollIntervalMs?: number;
}

export function startWatching(
  baseDir: string,
  options: StartWatchingOptions = {},
): WatcherHandle {
  const buildOpts: BuildSnapshotOptions = { dbPath: options.dbPath ?? null };
  let lastSnapshot: MonitorSnapshot = buildSnapshot(baseDir, buildOpts);
  emit("snapshot", createEvent("snapshot", lastSnapshot, "filesystem"));

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(baseDir, { recursive: true }, (_event, filename) => {
      if (!filename || !isRelevant(String(filename))) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = buildSnapshot(baseDir, buildOpts);
        for (const change of diffWorkers(lastSnapshot, next)) {
          emit("worker-update", createEvent("worker-update", change, "filesystem"));
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
    const next = buildSnapshot(baseDir, buildOpts);
    for (const flip of diffLiveness(lastSnapshot, next)) {
      emit("liveness-change", createEvent("liveness-change", flip, "filesystem"));
    }
    lastSnapshot = next;
  }, LIVENESS_INTERVAL_MS);

  const snapshotInterval = setInterval(() => {
    lastSnapshot = buildSnapshot(baseDir, buildOpts);
    emit("snapshot", createEvent("snapshot", lastSnapshot, "filesystem"));
  }, SNAPSHOT_INTERVAL_MS);

  let sqliteInterval: ReturnType<typeof setInterval> | null = null;
  if (options.dbPath) {
    const pollMs = options.sqlitePollIntervalMs ?? SQLITE_POLL_INTERVAL_MS;
    sqliteInterval = setInterval(() => {
      const next = buildSnapshot(baseDir, buildOpts);
      for (const change of diffSessions(lastSnapshot, next)) {
        emit("session-update", createEvent("session-update", change, "sqlite"));
      }
      lastSnapshot = next;
    }, pollMs);
  }

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(livenessInterval);
      clearInterval(snapshotInterval);
      if (sqliteInterval) clearInterval(sqliteInterval);
      try {
        watcher?.close();
      } catch (err) {
        console.error(`[watcher] close failed:`, err);
      }
    },
  };
}
