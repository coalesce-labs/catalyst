// Type declarations for read-model.mjs (CTL-883 cache-backed read-model core).
import type { BoardPayload } from "./board-data.mjs";

/** The transport-agnostic read-model interface. Process-split-ready: an HTTP/SSE
 *  shim can wrap subscribe/getSnapshot in a standalone catalyst-readmodel process
 *  without any consumer (UI route, HUD) changing, because they bind to this shape. */
export interface ReadModel {
  /** Register a client. Starts the reactive loop on the first subscriber and
   *  stops it when the last one leaves. Returns an unsubscribe fn. */
  subscribe(cb: (snapshot: BoardPayload) => void): () => void;
  /** One-shot read of the full payload. */
  getSnapshot(): Promise<BoardPayload>;
  /** One-shot read of a single named entity slice, projected off the snapshot.
   *  Throws on an unknown entity name. */
  getEntity(name: string): Promise<unknown>;
  /** Tear down the reactive loop (watcher + timers). */
  stop(): void;
  readonly entityNames: string[];
  readonly subscriberCount: number;
}

export interface ReadModelEntity {
  assemble?: () => Promise<BoardPayload>;
  project?: (snapshot: BoardPayload) => unknown;
}

export interface ReadModelOptions {
  debounceMs?: number;
  pollMs?: number;
  onDemandTtlMs?: number;
  assemble?: () => Promise<BoardPayload>;
  workersDir?: string;
  entities?: Record<string, ReadModelEntity>;
}

export function createReadModel(opts?: ReadModelOptions): ReadModel;
