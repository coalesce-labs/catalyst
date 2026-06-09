// Type declarations for ec-worker-stream.mjs (CTL-887, BFF5) — the live
// transcript tail for execution-core workers. Lets the typechecked TS server
// (server.ts) import the parser + tail without a TS7016 implicit-any error.
// The StreamEvent shape MUST stay in sync with lib/stream-reader.ts and
// ui/src/lib/types.ts so the existing StreamEventRow renderer consumes it
// unchanged.

export type StreamEventType =
  | "tool_start"
  | "tool_end"
  | "text"
  | "reasoning"
  | "turn"
  | "init"
  | "retry"
  | "result"
  | "rate_limit";

export interface StreamEvent {
  ts: number;
  type: StreamEventType;
  tool?: string;
  toolInput?: string;
  text?: string;
  /** Tool names invoked in this assistant turn. */
  turnTools?: string[];
  retryInfo?: { attempt: number; maxRetries: number; error: string };
  rateLimitInfo?: { status: string; resetsAt?: number };
  usage?: Record<string, unknown>;
  sessionId?: string;
}

/** Max bytes read on the first poll so a long resting transcript isn't replayed. */
export const INITIAL_TAIL_BYTES: number;

/**
 * Convert ONE resting-transcript JSONL line into zero or more StreamEvents.
 * Pure — no filesystem. `now` is the fallback ts for records with no timestamp.
 */
export function parseTranscriptLine(line: string, now?: number): StreamEvent[];

/**
 * Resolve a sessionId to its `~/.claude/projects/<dir>/<sessionId>.jsonl` path.
 * Prefers the resident board-data transcript-path cache (no rescan); falls back
 * to a single scan only on a cold miss unless `allowScan` is false.
 */
export function resolveTranscriptPath(
  sessionId: string,
  options?: { allowScan?: boolean },
): Promise<string | null>;

/** A stateful, incremental tail over one transcript file. */
export class TranscriptTail {
  constructor(filePath: string);
  filePath: string;
  offset: number;
  /** Read only the bytes appended since the last poll; parse new lines. */
  poll(): Promise<StreamEvent[]>;
}
