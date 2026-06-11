// live-tail-data.ts — PURE logic for the worker [● live] activity tail and the
// ticket active-node live tail (CTL-918 / DETAIL7, detail design §5.2 + §4.2).
// React-/DOM-free on purpose (the same discipline as worker-detail-data.ts /
// worker-burn-data.ts / ticket-page-model.ts), so the live tail's whole
// acceptance surface — buffer management, footer counters, the retry/rate-limit/
// turn/tool-error DIAGNOSTICS derivation, the pause decoupling, the single-row
// MVP fallback, and the ticket active-node `now: …` summary — unit-tests
// directly under `bun test` without spinning up an SSE connection.
//
// The wire shape is the SAME StreamEvent the BFF live-tail SSE emits
// (lib/ec-worker-stream.d.mts) and that the harvested StreamEventRow renderer
// already consumes — there is ONE row shape across live (SSE) and history
// (Loki) so the renderer is shared (design §5.2 "one StreamEventRow renderer,
// two sources"). Every derived value is a count/field off the RECEIVED rows or
// an honest null — NEVER a fabricated diagnostic (no fake `2/3`).

import type { StreamEvent } from "@/lib/types";
import type { BoardWorker } from "./types";

// ── SSE frame parsing ────────────────────────────────────────────────────────
// The BFF live SSE emits one StreamEvent JSON per `event: stream-event` frame.
// Parse defensively: a malformed/non-object frame yields null (the caller skips
// it) so a single bad line never crashes the tail. A valid object must carry a
// numeric `ts` and a string `type` to be a StreamEvent.

const STREAM_EVENT_TYPES: readonly StreamEvent["type"][] = [
  "tool_start",
  "tool_end",
  "text",
  "reasoning",
  "turn",
  "init",
  "retry",
  "result",
  "rate_limit",
];

function isStreamEventType(v: unknown): v is StreamEvent["type"] {
  return typeof v === "string" && (STREAM_EVENT_TYPES as readonly string[]).includes(v);
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse one SSE frame's `data` into a StreamEvent, or null when malformed. The
 *  validated fields are copied onto a fresh, properly-typed StreamEvent (no cast
 *  through `any`/`unknown`) so a hostile frame can never smuggle an off-shape
 *  field past the type system. */
export function parseStreamEvent(data: string): StreamEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec["ts"] !== "number" || !Number.isFinite(rec["ts"])) return null;
  if (!isStreamEventType(rec["type"])) return null;

  const event: StreamEvent = { ts: rec["ts"], type: rec["type"] };
  const tool = optStr(rec["tool"]);
  if (tool !== undefined) event.tool = tool;
  const toolInput = optStr(rec["toolInput"]);
  if (toolInput !== undefined) event.toolInput = toolInput;
  const text = optStr(rec["text"]);
  if (text !== undefined) event.text = text;
  if (Array.isArray(rec["turnTools"])) {
    const tools = rec["turnTools"].filter((t): t is string => typeof t === "string");
    if (tools.length > 0) event.turnTools = tools;
  }
  if (rec["retryInfo"] && typeof rec["retryInfo"] === "object") {
    const ri = rec["retryInfo"] as Record<string, unknown>;
    event.retryInfo = {
      attempt: typeof ri["attempt"] === "number" ? ri["attempt"] : 0,
      maxRetries: typeof ri["maxRetries"] === "number" ? ri["maxRetries"] : 0,
      error: optStr(ri["error"]) ?? "",
    };
  }
  if (rec["rateLimitInfo"] && typeof rec["rateLimitInfo"] === "object") {
    const rl = rec["rateLimitInfo"] as Record<string, unknown>;
    event.rateLimitInfo = {
      status: optStr(rl["status"]) ?? "rate_limited",
      ...(typeof rl["resetsAt"] === "number" ? { resetsAt: rl["resetsAt"] } : {}),
    };
  }
  if (rec["usage"] && typeof rec["usage"] === "object") {
    event.usage = rec["usage"] as Record<string, unknown>;
  }
  const sessionId = optStr(rec["sessionId"]);
  if (sessionId !== undefined) event.sessionId = sessionId;
  return event;
}

// ── live buffer management ───────────────────────────────────────────────────
// The SSE keeps appending StreamEvents; the buffer is the rolling tail. We cap
// it so a long-lived worker's tail can't grow without bound (the renderer only
// shows the newest window anyway). The cap drops the OLDEST rows — the live
// console is a tail, not a full transcript (Loki [history] is the full record).

/** Default max rows held in the live buffer. A live console only ever shows the
 *  newest window; the full transcript is the Loki [history] tail. */
export const LIVE_BUFFER_CAP = 500;

/**
 * Append newly-received SSE rows to the live buffer, capping at `cap` (oldest
 * dropped). Pure: returns a NEW array (never mutates `buffer`) so the React
 * state update is referentially honest. An empty `incoming` returns the buffer
 * unchanged (same reference) so a no-op poll doesn't trigger a re-render.
 */
export function appendLiveRows(
  buffer: StreamEvent[],
  incoming: StreamEvent[],
  cap: number = LIVE_BUFFER_CAP,
): StreamEvent[] {
  if (incoming.length === 0) return buffer;
  const next = buffer.concat(incoming);
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
}

// ── pause decouples VIEW from DATA ───────────────────────────────────────────
// Pause freezes the VIEW (a snapshot of the buffer length at pause-time) while
// the SSE keeps appending to the buffer underneath. Resume replays the gap by
// returning the full buffer again. The view is therefore a pure function of
// (buffer, paused, frozenLength) — no separate "frozen copy" to drift out of
// sync; we just stop advancing the slice end while paused (design Scenario 2).

export interface PausedView {
  /** The rows the renderer should show right now. */
  rows: StreamEvent[];
  /** Rows that arrived since pause and are buffered-but-hidden (the "gap"). On
   *  resume these become visible; while paused the footer surfaces the count so
   *  the operator knows data is still flowing. */
  bufferedWhilePaused: number;
}

/**
 * Resolve the visible rows given the live buffer, the pause flag, and the buffer
 * length captured AT pause-time (`frozenLength`). When live, the whole buffer
 * shows and `bufferedWhilePaused` is 0. When paused, the view freezes at
 * `frozenLength` rows while the buffer keeps growing — `bufferedWhilePaused` is
 * the count still streaming in behind the freeze (resume drops the freeze and
 * the gap replays). `frozenLength` is clamped to the buffer so a buffer that was
 * capped/trimmed under the freeze can never produce a negative gap.
 */
export function resolvePausedView(
  buffer: StreamEvent[],
  paused: boolean,
  frozenLength: number,
): PausedView {
  if (!paused) {
    return { rows: buffer, bufferedWhilePaused: 0 };
  }
  const frozen = Math.max(0, Math.min(frozenLength, buffer.length));
  return {
    rows: buffer.slice(0, frozen),
    bufferedWhilePaused: buffer.length - frozen,
  };
}

// ── footer counters (events / tools / retries / stream-size) ─────────────────
// design §5.2 footer: "57 events · 11 tools · 1 retry · stream 1.2MB". ALL
// derived client-side from the RECEIVED rows (there is no eventCount on
// BoardWorker — the footer is `—` until streaming, never fabricated).

export interface FooterCounters {
  events: number;
  tools: number;
  retries: number;
  /** Approx wire size of the received rows (the JSON byte length) — the
   *  "stream 1.2MB" cell. Derived from the rows we hold, not a server field. */
  streamBytes: number;
}

/** Count a tool_start as one "tool" invocation; a `turn` row carries turnTools[]
 *  but the individual tool_start rows already count each call, so we count
 *  tool_start to avoid double-counting the turn's summary list. */
export function deriveFooterCounters(rows: StreamEvent[]): FooterCounters {
  let tools = 0;
  let retries = 0;
  let streamBytes = 0;
  for (const r of rows) {
    if (r.type === "tool_start") tools += 1;
    if (r.type === "retry") retries += 1;
    // The wire size of THIS row (what actually streamed over the SSE).
    streamBytes += jsonByteLength(r);
  }
  return { events: rows.length, tools, retries, streamBytes };
}

/** UTF-8 byte length of one row's JSON encoding (TextEncoder is universally
 *  available in the browser + bun). Pure — no side effects. */
function jsonByteLength(row: StreamEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(row)).length;
  } catch {
    return 0;
  }
}

// ── DIAGNOSTICS rail (retries / rate-limit / turn / tool-errors) ─────────────
// design §5.2 DIAGNOSTICS: these rows were rendered DIMMED ("— ↯") in DETAIL3
// because nothing fed them; DETAIL7 lights them up off the SAME received rows.
// `plumbed` flips true once at least one row has arrived (the stream is live);
// while no rows have arrived they stay honestly dimmed — we never claim `0`
// retries we can't attest. `turn` reports the LATEST turn ordinal seen.

export interface TailDiagnostics {
  /** count of `retry` rows. */
  retries: number;
  /** count of `rate_limit` rows. */
  rateLimit: number;
  /** count of assistant turns (`turn` rows) — also the current turn ordinal. */
  turn: number;
  /** count of tool errors seen. A `retry` whose error names a tool/exec failure
   *  is the closest signal the transcript carries; we count `retry` rows that
   *  are NOT rate-limits as the tool/exec-error tell. */
  toolErrors: number;
  /** true once any row has arrived (the stream is live) — flips the rail from
   *  the DETAIL3 dimmed "— ↯" to live counters. */
  plumbed: boolean;
}

/** Derive the DIAGNOSTICS counters from the received rows. With zero rows the
 *  rail is `plumbed:false` (dimmed, as in DETAIL3) — we never fabricate a 0/—. */
export function deriveTailDiagnostics(rows: StreamEvent[]): TailDiagnostics {
  let retries = 0;
  let rateLimit = 0;
  let turn = 0;
  let toolErrors = 0;
  for (const r of rows) {
    if (r.type === "retry") {
      retries += 1;
      // A retry that names a rate-limit error is counted under rate-limit only;
      // any other retry error is the tool/exec-error tell.
      const err = r.retryInfo?.error ?? "";
      if (err.includes("rate_limit") || err.includes("rate-limit")) {
        rateLimit += 1;
      } else {
        toolErrors += 1;
      }
    } else if (r.type === "rate_limit") {
      rateLimit += 1;
    } else if (r.type === "turn") {
      turn += 1;
    }
  }
  return { retries, rateLimit, turn, toolErrors, plumbed: rows.length > 0 };
}

// ── ticket active-node live tail (design §4.2) ───────────────────────────────
// The ticket page's active spine node shows `now: <current tool> · turn N ·
// ctx%` plus a 3-line in-loop tail, fed by the SAME per-phase live source keyed
// by the running phase's sessionId. `ctx%` comes from the session context_pct
// when the stream carries it; until that field arrives it is honestly null
// (the skin renders `ctx —`, never a fabricated 41%).

export const ACTIVE_NODE_TAIL_LINES = 3;

export interface ActiveNodeTail {
  /** The current tool the agent is invoking (latest tool_start), or null when no
   *  tool row has been seen yet. */
  currentTool: string | null;
  /** The current turn ordinal (count of turn rows), or null when no turn seen. */
  turn: number | null;
  /** The session context percentage (0-100) when the stream carries it; null
   *  until the context_pct field arrives (never fabricated). */
  contextPct: number | null;
  /** The newest `ACTIVE_NODE_TAIL_LINES` rows for the in-loop 3-line tail. */
  tail: StreamEvent[];
  /** true once any row has arrived — the skin renders the resident
   *  phase/status/duration/model only (never blank) while this is false. */
  hasRows: boolean;
}

/**
 * Derive the active-node live tail summary from the running phase's received
 * rows. `contextPct` is read off the latest row that carries a numeric
 * `usage.context_pct` (the session context signal); absent → null. The tail is
 * the newest 3 rows. Pure: an empty rows array yields a null/empty summary with
 * `hasRows:false` so the skin keeps the resident node cells and never blanks.
 */
export function deriveActiveNodeTail(rows: StreamEvent[]): ActiveNodeTail {
  let currentTool: string | null = null;
  let turn = 0;
  let contextPct: number | null = null;
  for (const r of rows) {
    if (r.type === "tool_start" && r.tool) currentTool = r.tool;
    if (r.type === "turn") turn += 1;
    const ctx = readContextPct(r.usage);
    if (ctx != null) contextPct = ctx;
  }
  return {
    currentTool,
    turn: rows.length > 0 ? turn : null,
    contextPct,
    tail: rows.slice(-ACTIVE_NODE_TAIL_LINES),
    hasRows: rows.length > 0,
  };
}

/** Read a numeric `context_pct` off a row's `usage` map (the session context
 *  signal), clamped to [0,100]. Any non-numeric / absent value → null so the
 *  caller dims `ctx —` rather than fabricating a percentage. */
function readContextPct(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null;
  const raw = usage["context_pct"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

// ── graceful MVP: a single derived row when the stream is briefly unavailable ─
// design §5.2: "MVP without it: a single derived row (current tool + now −
// lastActiveMs), never an empty terminal." When the SSE is momentarily down (or
// has produced no rows yet) but we DO know the resident current tool + last
// active time, render exactly one synthesized tool_start row so the terminal is
// never blank. As soon as real rows arrive this is superseded.

/**
 * Build the single-row MVP fallback for an empty/unavailable live tail. Returns
 * one synthesized `tool_start` StreamEvent stamped at `lastActiveMs` (so the
 * renderer's `now − ts` age reads as the idle duration) when a `currentTool` is
 * known. Returns null when there is no current tool to synthesize from — the
 * caller then shows an honest "stream momentarily unavailable" line rather than
 * a fabricated row.
 *
 * This is ONLY used when the real buffer is empty; a non-empty buffer always
 * wins (the real rows are the truth).
 */
export function deriveMvpRow(
  currentTool: string | null | undefined,
  lastActiveMs: number | null | undefined,
  now: number,
): StreamEvent | null {
  if (!currentTool) return null;
  // Stamp at lastActiveMs when known so the row's age reads as the real idle
  // gap; fall back to `now` (age 0) when we have no last-active timestamp.
  const ts =
    lastActiveMs != null && Number.isFinite(lastActiveMs) ? lastActiveMs : now;
  return { ts, type: "tool_start", tool: currentTool };
}

/**
 * Resolve what the live terminal should render: the real buffer when it has
 * rows, else the single-row MVP fallback, else an empty list (the caller shows
 * the honest "stream momentarily unavailable" placeholder). Centralizes the
 * "never an empty terminal" rule so the React skin can't accidentally blank.
 */
export interface LiveTerminalRows {
  rows: StreamEvent[];
  /** "live" = real SSE rows; "mvp" = the single derived fallback row;
   *  "empty" = nothing to show (the placeholder line renders). */
  source: "live" | "mvp" | "empty";
}

export function resolveLiveTerminalRows(
  buffer: StreamEvent[],
  currentTool: string | null | undefined,
  lastActiveMs: number | null | undefined,
  now: number,
): LiveTerminalRows {
  if (buffer.length > 0) return { rows: buffer, source: "live" };
  const mvp = deriveMvpRow(currentTool, lastActiveMs, now);
  if (mvp) return { rows: [mvp], source: "mvp" };
  return { rows: [], source: "empty" };
}

// ── active-node session resolution (ticket page → per-phase live source) ─────
// The ticket active-node live tail (design §4.2) rides the SAME per-phase live
// source keyed by the RUNNING phase's sessionId. The board payload carries the
// live workers (BoardWorker.sessionId is the CC-UUID); the active node's session
// is the live worker for THIS ticket whose phase matches the ticket's current
// phase. Returns null when no such LIVE worker exists (a non-running ticket, or a
// finished phase with no bg worker) — the skin then shows the resident node
// cells only, never an empty live tail.

/**
 * Resolve the CC-UUID sessionId of the ticket's currently-running phase from the
 * resident live workers. Matches a worker that is for this ticket AND on the
 * active phase AND actually working (a stale/dead worker has no live transcript
 * to tail). Pure: no workers / no match → null.
 */
export function resolveActivePhaseSession(
  ticketId: string,
  activePhase: string | null,
  workers: BoardWorker[],
): string | null {
  if (!activePhase) return null;
  for (const w of workers) {
    const onThisTicket = w.ticket === ticketId || w.tickets?.includes(ticketId);
    if (onThisTicket && w.phase === activePhase && w.working && w.sessionId) {
      return w.sessionId;
    }
  }
  return null;
}
