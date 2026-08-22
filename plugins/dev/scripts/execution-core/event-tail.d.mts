// Type declarations for event-tail.mjs.
//
// CTL-1216: added when orch-monitor/lib/event-log-reader.ts and
// otel-forward/lib/tail.ts began sharing drainAndSwitch. Same .d.mts sidecar
// shape as lib/event-name.d.mts and lib/event-log-paths.d.mts — without it a
// TS consumer's `.mjs` import resolves to `any` and eslint's no-unsafe-* rules
// fire (the orch-monitor lint gate is real CI).
//
// This declares the module's full public surface rather than only the two
// functions TS happens to import today: a sidecar that covers a subset silently
// types the next import as `any` again.

export declare function tornLineCount(): number;
export declare function resetTornLineCount(): void;
export declare function noteTornLine(line: string): void;

export interface ParsedTailChunk {
  events: unknown[];
  leftover: string;
}
export declare function parseEventTailChunk(
  chunk: string,
  leftover?: string,
  lineFilter?: ((line: string) => boolean) | null,
): ParsedTailChunk;

export declare function scanEventsChunked(opts: {
  path: string;
  fromOffset?: number;
  leftover?: string;
  chunkSize?: number;
  onEvent?: (event: unknown) => void;
  lineFilter?: ((line: string) => boolean) | null;
}): { endOffset: number; leftover: string };

export declare const DEFAULT_TAIL_MAX_BYTES: number;
export declare const COVERAGE_PROBE_SAMPLE: number;
export declare function robustCoverageMs(samplesMs: number[]): number;

export declare function scanEventsSince(opts: {
  path: string;
  targetSinceMs: number;
  maxBytes?: number;
  chunkSize?: number;
  initialWindow?: number;
  lineFilter?: ((line: string) => boolean) | null;
  onEvent?: (event: unknown) => void;
}): {
  covered: boolean;
  windowBytes: number;
  size: number;
  oldestTs: string | null;
  reachedBof?: boolean;
};

export declare function tailParsedEvents(opts: {
  path: string;
  maxLines?: number;
  maxBytes?: number;
}): unknown[];

/** CTL-1216: the rollover drain — read `oldPath` from `oldOffset` to EOF and
 *  hand each COMPLETE line to `onLines` before a reader retargets. Bounded, and
 *  it reports truncation rather than quietly reading less. */
export declare const DEFAULT_DRAIN_MAX_BYTES: number;
export declare function drainAndSwitch(opts: {
  oldPath: string | null;
  oldOffset?: number;
  leftover?: string;
  onLines?: (lines: string[]) => void;
  maxBytes?: number;
}): { drained: number; lines: number; truncated: boolean };
