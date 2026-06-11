// ec-worker-stream.mjs — CTL-887 (BFF5): the live transcript tail for
// execution-core workers.
//
// The legacy /api/worker-stream (lib/stream-reader.ts) reads the Plane-B
// `runs/<orch>/workers/<ticket>-stream.jsonl` tree, which is EMPTY for
// execution-core `claude --bg` workers (design §2). This module is the EC
// equivalent: it tails the RESTING transcript that every Claude Code session
// writes to `~/.claude/projects/<dir>/<sessionId>.jsonl` and converts the
// growing file into the same typed StreamEvent[] the existing StreamEventRow
// renderer consumes (tool calls, text, reasoning, turns, retries, rate-limits).
//
// Two format families exist. The legacy stream-reader parses the `claude --bg`
// stream-json frames (system/init, stream_event/content_block_*, assistant,
// rate_limit_event, result). The on-disk transcript this module tails is the
// RESTING format: line-delimited records of type "assistant" | "user" |
// "system", each carrying an ISO `timestamp` and (for assistant/user) a
// `message.content[]` array of `{type: thinking|text|tool_use|tool_result}`
// blocks. `system` records of subtype "api_error" carry retryAttempt /
// maxRetries / retryInMs plus a nested error whose `error.error.type` tells a
// rate-limit apart from a generic overloaded/server retry.
//
// Path resolution reuses board-data.mjs's resident transcript-path cache
// (peekTranscriptCache — cache HITS only, no ~1.5k-dir rescan) and only falls
// back to a single scan (resolveTranscript) on a cold miss.
//
// Cross-node note (CTL-873/BFF3, single-node-descoped): this tail is
// host-local and stateless — a multi-host fan-in is a clean wrap around N of
// these, keyed by host.name. No cluster state is read here.

import { stat, open } from "node:fs/promises";
import { peekTranscriptCache, resolveTranscript } from "./board-data.mjs";

/** Max bytes to read on the very first poll so a huge resting transcript does
 *  not flood the client — the live tail only needs the recent window. */
export const INITIAL_TAIL_BYTES = 64 * 1024;

/** Cap on how many bytes a single growth poll reads (defensive against a
 *  pathological burst); the next poll picks up any remainder. */
const MAX_GROWTH_BYTES = 1024 * 1024;

/** Parse an ISO-8601 timestamp to epoch-ms, or fall back to `fallback`. */
function tsToMs(iso, fallback) {
  if (typeof iso === "string") {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/**
 * Convert ONE resting-transcript JSONL line into zero or more StreamEvents.
 * Pure + exported so the conversion is exhaustively unit-testable without any
 * filesystem. `now` is the fallback ts for records that carry no timestamp.
 *
 * @param {string} line
 * @param {number} [now]
 * @returns {import("./ec-worker-stream.d.mts").StreamEvent[]}
 */
export function parseTranscriptLine(line, now = Date.now()) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj.type !== "string") return [];
  const ts = tsToMs(obj.timestamp, now);

  // ── system records: retries / rate-limits ──────────────────────────────
  if (obj.type === "system") {
    if (obj.subtype === "api_error") {
      // The nested error type disambiguates a rate-limit from a generic retry.
      const nestedType =
        obj?.error?.error?.error?.type ?? // {error:{error:{type,error:{type}}}}
        obj?.error?.error?.type ??
        obj?.error?.type ??
        null;
      const isRateLimit =
        typeof nestedType === "string" && nestedType.includes("rate_limit");
      if (isRateLimit) {
        const resetsAt =
          typeof obj.retryInMs === "number"
            ? Math.round((ts + obj.retryInMs) / 1000)
            : undefined;
        return [
          {
            ts,
            type: "rate_limit",
            rateLimitInfo: { status: nestedType ?? "rate_limited", resetsAt },
          },
        ];
      }
      return [
        {
          ts,
          type: "retry",
          retryInfo: {
            attempt:
              typeof obj.retryAttempt === "number" ? obj.retryAttempt : 0,
            maxRetries:
              typeof obj.maxRetries === "number" ? obj.maxRetries : 0,
            error:
              (typeof nestedType === "string" && nestedType) ||
              (typeof obj.error === "string" ? obj.error : "api_error"),
          },
        },
      ];
    }
    return [];
  }

  // ── assistant records: turn + per-block text / reasoning / tool_use ─────
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    const events = [];
    const tools = [];
    let textPreview;
    for (const block of obj.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const thinking =
          typeof block.thinking === "string" ? block.thinking : "";
        events.push({ ts, type: "reasoning", text: thinking.slice(0, 200) });
      } else if (block.type === "text" && typeof block.text === "string") {
        if (textPreview === undefined) textPreview = block.text.slice(0, 200);
        events.push({ ts, type: "text", text: block.text.slice(0, 200) });
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        tools.push(name);
        events.push({
          ts,
          type: "tool_start",
          tool: name,
          toolInput: summarizeToolInput(block.input),
        });
      }
    }
    // One `turn` row anchors the assistant message (turnTools + first text).
    events.unshift({
      ts,
      type: "turn",
      turnTools: tools.length > 0 ? tools : undefined,
      text: textPreview,
      sessionId:
        typeof obj.sessionId === "string" ? obj.sessionId : undefined,
    });
    return events;
  }

  // user / tool_result records are not surfaced as their own rows (the
  // tool_start already carries the call; the next assistant turn shows the
  // reaction). Everything else is silently skipped.
  return [];
}

/** A short, single-line preview of a tool's input for the activity row. */
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return undefined;
  // Prefer the human-meaningful fields, in priority order.
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "description",
    "prompt",
    "url",
  ]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) {
      return v.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return undefined;
}

/**
 * Resolve a sessionId to its transcript path WITHOUT a full project-dir rescan
 * on the hot path. Prefers the resident cache (a live worker has already been
 * resolved by board assembly); falls back to a single scan only on a cold
 * miss (e.g. a freshly-spawned session whose first board pass hasn't run yet).
 *
 * @param {string} sessionId
 * @param {{ allowScan?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
export async function resolveTranscriptPath(sessionId, options = {}) {
  if (!sessionId) return null;
  const cached = peekTranscriptCache(sessionId);
  if (cached) return cached;
  if (options.allowScan === false) return null;
  return resolveTranscript(sessionId);
}

/**
 * A stateful tail over one transcript file. `poll()` reads only the bytes
 * appended since the last call, parses any newly-completed lines into
 * StreamEvents, and carries a partial trailing line forward. The first poll
 * starts from the tail (last INITIAL_TAIL_BYTES) so a long resting transcript
 * doesn't replay in full.
 */
export class TranscriptTail {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.carry = "";
    this.primed = false;
    // When primed from a non-zero offset the first chunk's leading bytes are a
    // partial line; drop everything up to the first newline so a half-record is
    // never parsed.
    this.skipPartialLead = false;
  }

  /**
   * @returns {Promise<import("./ec-worker-stream.d.mts").StreamEvent[]>}
   */
  async poll() {
    let size;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return [];
    }
    if (!this.primed) {
      // Start from the tail of the existing file on the first poll.
      if (size > INITIAL_TAIL_BYTES) {
        this.offset = size - INITIAL_TAIL_BYTES;
        this.skipPartialLead = true;
      } else {
        this.offset = 0;
      }
      this.primed = true;
    }
    if (size < this.offset) {
      // File truncated/rotated under us — restart from its current end.
      this.offset = 0;
      this.carry = "";
      this.skipPartialLead = false;
    }
    if (size <= this.offset) return [];

    const length = Math.min(size - this.offset, MAX_GROWTH_BYTES);
    let chunk;
    let fh;
    try {
      fh = await open(this.filePath, "r");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, this.offset);
      chunk = buf.toString("utf8", 0, bytesRead);
      this.offset += bytesRead;
    } catch {
      return [];
    } finally {
      if (fh) await fh.close().catch(() => {});
    }

    let text = this.carry + chunk;
    if (this.skipPartialLead) {
      const firstNl = text.indexOf("\n");
      // Drop the leading partial line; if no newline yet, wait for more bytes.
      text = firstNl === -1 ? "" : text.slice(firstNl + 1);
      if (firstNl !== -1) this.skipPartialLead = false;
    }

    const lastNl = text.lastIndexOf("\n");
    let complete;
    if (lastNl === -1) {
      // No complete line yet — carry it all forward.
      this.carry = this.skipPartialLead ? "" : text;
      complete = "";
    } else {
      complete = text.slice(0, lastNl);
      this.carry = text.slice(lastNl + 1);
    }

    const now = Date.now();
    const events = [];
    for (const line of complete.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push(...parseTranscriptLine(trimmed, now));
    }
    return events;
  }
}
