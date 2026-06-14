// ec-worker-screen.mjs — CTL-938: the live SCREEN poller for execution-core
// workers, the pre-transcript wedge window.
//
// The transcript live-tail (ec-worker-stream.mjs, CTL-887/CTL-918) only covers
// workers that have started a turn. The workers an operator most needs to see —
// wedged at session start ("Unknown command: /catalyst-dev:phase-plan"), blocked
// on a dialog, idle at an empty prompt — have NO transcript at all. Their
// rendered terminal screen IS available non-interactively: `claude logs
// <shortId>` dumps the bg session's screen buffer (a few KB of ANSI). There is
// no follow flag, so the only live surface is poll → normalize → diff →
// emit-on-change, which is exactly what ScreenPoller encodes.
//
// Conventions mirror ec-worker-stream.mjs: the stateful poller is a small class
// whose collaborator (the exec fn) is injectable so every branch — frame,
// unchanged, session-gone, claude-CLI-absent — unit-tests without a subprocess.
// The server route (server.ts /api/ec-worker-screen/<shortId>) owns the SSE
// framing + cadence; this module owns the screen semantics.

import { execFile } from "node:child_process";

/** Production poll cadence. `claude logs` is a cheap dump (a few KB) but spawns
 *  a subprocess, so ~2s balances wedge-visibility latency against fork load. */
export const SCREEN_POLL_MS = 2000;

/** Cap on a single screen dump read (defensive — a rendered screen buffer is a
 *  few KB; 5MB means even a pathological dump can't balloon the route). */
const MAX_SCREEN_BYTES = 5 * 1024 * 1024;

/** Hard timeout on one `claude logs` invocation so a hung CLI can't wedge the
 *  poll loop it exists to diagnose. */
const EXEC_TIMEOUT_MS = 10_000;

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";

// ── shortId derivation ───────────────────────────────────────────────────────
// `claude logs` only accepts the 8-char short form (full UUIDs are rejected —
// the same CTL-649 contract claude-ids.mjs encodes for `claude stop`). Local,
// throw-free mirror of shortIdFromSessionId: a route guard wants null, not an
// exception, and this lib must stay dependency-free of execution-core.
const HEX8 = /^[0-9a-f]{8}$/;
const HEX8_PREFIX = /^([0-9a-f]{8})-/;

/**
 * Derive the 8-char short id from a short or full bg job/session id. Returns
 * null on absent/malformed input — never throws (route-guard friendly).
 * @param {string | null | undefined} input
 * @returns {string | null}
 */
export function deriveScreenShortId(input) {
  if (typeof input !== "string" || input === "") return null;
  if (HEX8.test(input)) return input;
  const m = input.match(HEX8_PREFIX);
  return m ? m[1] : null;
}

// ── ANSI normalization ───────────────────────────────────────────────────────
// The dump is a RENDERED screen: CSI styling/cursor moves, OSC titles/links,
// two-byte ESC selects. Strip them all so (a) the client renders plain
// monospace text and (b) the change-diff ignores styling-only re-renders (a
// blinking cursor or a re-coloured spinner frame is NOT a screen change).

// eslint-disable-next-line no-control-regex -- ANSI escapes ARE control chars; stripping them is this regex's whole job
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=><]/g;
// eslint-disable-next-line no-control-regex -- residual C0 bytes (BEL etc.) are stripped after the escape pass
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Remove ANSI escape sequences (CSI, OSC, charset selects, lone ESC pairs) and
 * residual non-printing control bytes. Keeps \n, \r and \t for the line pass.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

/**
 * Canonical screen text for diffing + display: ANSI-stripped, CRLF→LF, each
 * line right-trimmed, trailing blank lines dropped. Two renders that differ
 * only in styling/trailing whitespace normalize identically (no false frame).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeScreen(raw) {
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ── the exec seam ────────────────────────────────────────────────────────────
// One `claude logs <shortId>` invocation, classified into the three outcomes
// the poller distinguishes:
//   { status: "ok", stdout }        — screen dump in hand
//   { status: "gone", detail }      — claude ran but the session doesn't exist
//                                     (non-zero exit) → terminal for the stream
//   { status: "unavailable", detail } — claude itself can't run (ENOENT /
//                                     spawn failure / timeout) → terminal too
// Injectable everywhere it's consumed; this default is the only impure bit.

/**
 * @param {string} shortId
 * @returns {Promise<import("./ec-worker-screen.d.mts").ScreenLogsResult>}
 */
export function defaultClaudeLogsExec(shortId) {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ["logs", shortId],
      { encoding: "utf8", maxBuffer: MAX_SCREEN_BYTES, timeout: EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: "ok", stdout: String(stdout ?? "") });
          return;
        }
        // Spawn-level failures (CLI absent / not executable / killed by our
        // timeout) are "unavailable"; a clean non-zero exit means claude ran
        // and reported the session gone.
        const code = /** @type {{ code?: unknown; killed?: boolean }} */ (err).code;
        if (code === "ENOENT" || code === "EACCES" || err.killed) {
          resolve({ status: "unavailable", detail: err.message });
          return;
        }
        const detail = String(stderr ?? "").trim() || String(stdout ?? "").trim() || err.message;
        resolve({ status: "gone", detail });
      },
    );
  });
}

// ── the poller ───────────────────────────────────────────────────────────────

/**
 * Stateful poll→diff over one bg session's rendered screen. Each `poll()`
 * invokes the exec fn once and classifies the outcome:
 *   { kind: "frame", screen }       — first dump, or the normalized screen
 *                                     changed (the FULL new screen, never a
 *                                     delta — frames are droppable)
 *   { kind: "unchanged" }           — identical screen; `unchangedPolls`
 *                                     increments (the wedge observation)
 *   { kind: "gone", reason }        — session no longer exists → terminal
 *   { kind: "unavailable", reason } — claude CLI can't run → terminal
 * Never throws: an exec rejection is contained as "unavailable".
 */
export class ScreenPoller {
  /**
   * @param {string} shortId
   * @param {{ exec?: (shortId: string) => Promise<import("./ec-worker-screen.d.mts").ScreenLogsResult> }} [options]
   */
  constructor(shortId, options = {}) {
    this.shortId = shortId;
    this.exec = options.exec ?? defaultClaudeLogsExec;
    /** @type {string | null} last normalized screen (the diff baseline). */
    this.lastScreen = null;
    /** Consecutive polls with an identical screen — the frozen-screen tell. */
    this.unchangedPolls = 0;
  }

  /**
   * @returns {Promise<import("./ec-worker-screen.d.mts").ScreenPollResult>}
   */
  async poll() {
    let res;
    try {
      res = await this.exec(this.shortId);
    } catch (err) {
      return {
        kind: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (!res || typeof res !== "object" || typeof res.status !== "string") {
      return { kind: "unavailable", reason: "screen exec returned no result" };
    }
    if (res.status === "unavailable") {
      return { kind: "unavailable", reason: res.detail ?? "claude CLI unavailable" };
    }
    if (res.status === "gone") {
      return { kind: "gone", reason: res.detail ?? "session gone" };
    }
    const screen = normalizeScreen(res.stdout ?? "");
    if (this.lastScreen !== null && screen === this.lastScreen) {
      this.unchangedPolls += 1;
      return { kind: "unchanged" };
    }
    this.lastScreen = screen;
    this.unchangedPolls = 0;
    return { kind: "frame", screen };
  }
}
