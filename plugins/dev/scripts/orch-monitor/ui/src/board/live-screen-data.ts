// live-screen-data.ts — PURE logic for the worker "Live screen" pane (CTL-938),
// the PRE-transcript wedge window. React-/DOM-free on purpose (the same
// discipline as live-tail-data.ts / worker-detail-data.ts) so the pane's whole
// acceptance surface unit-tests under `bun test` without an SSE connection.
//
// The pane consumes the change-driven /api/ec-worker-screen/<shortId> SSE
// (server.ts, backed by lib/ec-worker-screen.mjs): each `event: screen` frame
// carries the FULL normalized screen (never a delta — frames are droppable),
// and an unchanged screen produces NOTHING on the wire. Everything the skin
// shows is therefore derived CLIENT-SIDE from frame receipt times:
//   • the shortId from the worker's bg_job_id (signal field)
//   • the parsed frame → ScreenViewState (screen + lastChangeAt)
//   • the "last change Xs ago" age off the local clock
//   • the frozen-screen WEDGE label once nothing has changed for
//     SCREEN_WEDGE_AFTER_MS (~10 polls at the 2s cadence — ticket Scenario 2)
//   • the hand-off to the richer transcript live-tail once it has rows
//     (ticket Scenario 3)

// ── shortId derivation ───────────────────────────────────────────────────────
// `claude logs` only accepts the 8-char short form (the CTL-649 contract).
// Client-side mirror of lib/ec-worker-screen.mjs deriveScreenShortId — the lib
// is server-only (node:child_process) and must NEVER enter the UI import graph
// (the vite.config bun:sqlite-class build trap), so the 4-line rule is
// duplicated rather than imported.
const HEX8 = /^[0-9a-f]{8}$/;
const HEX8_PREFIX = /^([0-9a-f]{8})-/;

/** Derive the 8-char short id from a worker's bg_job_id (short or full UUID).
 *  Returns null on absent/malformed input — never throws. */
export function shortIdFromBgJobId(input: string | null | undefined): string | null {
  if (typeof input !== "string" || input === "") return null;
  if (HEX8.test(input)) return input;
  const m = input.match(HEX8_PREFIX);
  return m ? m[1] : null;
}

// ── SSE frame parsing ────────────────────────────────────────────────────────

/** One `event: screen` payload: the FULL normalized screen + the server's
 *  emit timestamp. */
export interface ScreenFrame {
  screen: string;
  ts: number;
}

/** Parse one `event: screen` frame's data. Defensive: malformed JSON or an
 *  off-shape payload yields null (the caller skips it) so a single bad frame
 *  never crashes the pane. */
export function parseScreenFrame(data: string): ScreenFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec["screen"] !== "string") return null;
  if (typeof rec["ts"] !== "number" || !Number.isFinite(rec["ts"])) return null;
  return { screen: rec["screen"], ts: rec["ts"] };
}

// ── view state ───────────────────────────────────────────────────────────────

/** What the pane holds: the current screen and WHEN it last changed (stamped at
 *  frame-receipt time off the LOCAL clock, so the age math never mixes the
 *  server's clock with ours). */
export interface ScreenViewState {
  screen: string | null;
  lastChangeAt: number | null;
}

/**
 * Fold one received frame into the view state. The server is change-driven so
 * every frame SHOULD be a change — but defensively, an identical screen returns
 * the SAME state reference (no re-render, lastChangeAt does not advance: an
 * echoed frame is not evidence of progress). Pure: a real change returns a new
 * object.
 */
export function applyScreenFrame(
  state: ScreenViewState,
  frame: ScreenFrame,
  now: number,
): ScreenViewState {
  if (state.screen !== null && frame.screen === state.screen) return state;
  return { screen: frame.screen, lastChangeAt: now };
}

// ── the frozen-screen wedge signal (ticket Scenario 2) ───────────────────────

/** Unchanged for this long → the pane labels the worker as producing no output.
 *  10 consecutive unchanged polls at the server's ~2s cadence. */
export const SCREEN_WEDGE_AFTER_MS = 20_000;

export interface ScreenStatus {
  /** ms since the screen last changed (clamped ≥ 0), or null before any frame. */
  ageMs: number | null;
  /** true once the screen has sat unchanged past SCREEN_WEDGE_AFTER_MS — the
   *  "producing no output" tell. Never true before the first frame (an absent
   *  screen is "no data yet", not a wedge observation). */
  wedged: boolean;
}

/** Derive the "last change Xs ago" age + wedge flag from the last-change stamp
 *  and the current clock. Negative skew clamps to 0. */
export function deriveScreenStatus(lastChangeAt: number | null, now: number): ScreenStatus {
  if (lastChangeAt == null) return { ageMs: null, wedged: false };
  const ageMs = Math.max(0, now - lastChangeAt);
  return { ageMs, wedged: ageMs >= SCREEN_WEDGE_AFTER_MS };
}

// ── the transcript hand-off (ticket Scenario 3) ──────────────────────────────

/** What the pane should be doing right now:
 *  "no-id"      — no derivable shortId (bg_job_id absent/malformed): dim
 *                 honestly, never attempt a stream.
 *  "screen"     — the pre-transcript window: stream + render the live screen.
 *  "handed-off" — the transcript live-tail has rows; the richer view takes
 *                 over and the screen pane steps back (collapsed/on-standby). */
export type ScreenPaneMode = "no-id" | "screen" | "handed-off";

/** Resolve the pane mode. `transcriptLive` is "the live tail has received at
 *  least one row" (the same signal that lights the DIAGNOSTICS rail). A null
 *  shortId wins over everything — with no screen source the pane can only dim. */
export function deriveScreenPaneMode(
  shortId: string | null,
  transcriptLive: boolean,
): ScreenPaneMode {
  if (!shortId) return "no-id";
  return transcriptLive ? "handed-off" : "screen";
}

// ── age formatting ───────────────────────────────────────────────────────────

/** Compact age for the "last change Xs ago" indicator: `0s`, `12s`, `1m 15s`,
 *  `61m 0s` (minutes never roll into hours — a screen frozen for an hour should
 *  read alarmingly, not compactly). */
export function fmtScreenAge(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
