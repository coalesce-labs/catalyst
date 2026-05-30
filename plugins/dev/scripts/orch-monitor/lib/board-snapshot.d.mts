// Type declarations for board-snapshot.mjs (CTL-733 reactive snapshot manager).
import type { BoardPayload } from "./board-data.mjs";

export interface BoardSnapshotManager {
  /** Register an SSE client. Starts the reactive loop on the first subscriber
   *  and stops it when the last one leaves. Returns an unsubscribe fn. */
  subscribe(cb: (snapshot: BoardPayload) => void): () => void;
  /** One-shot read for the /api/board route + SSE bootstrap. */
  getLatest(): Promise<BoardPayload>;
  /** Tear down the reactive loop (watcher + timers). */
  stop(): void;
  readonly subscriberCount: number;
}

export interface BoardSnapshotOptions {
  debounceMs?: number;
  pollMs?: number;
  onDemandTtlMs?: number;
  assemble?: () => Promise<BoardPayload>;
  workersDir?: string;
}

export function createBoardSnapshotManager(
  opts?: BoardSnapshotOptions,
): BoardSnapshotManager;
