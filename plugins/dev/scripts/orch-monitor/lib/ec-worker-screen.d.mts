// Type declarations for ec-worker-screen.mjs (CTL-938) — the live SCREEN
// poller for execution-core workers (the pre-transcript wedge window). Lets
// the typechecked TS server (server.ts) and the tests import the poller
// without a TS7016 implicit-any error.

/** One classified `claude logs <shortId>` invocation. */
export type ScreenLogsResult =
  | { status: "ok"; stdout: string }
  | { status: "gone"; detail?: string }
  | { status: "unavailable"; detail?: string };

/** The injectable exec seam (production default: `claude logs <shortId>`). */
export type ScreenLogsExec = (shortId: string) => Promise<ScreenLogsResult>;

/** One classified poll outcome. `gone`/`unavailable` are terminal. */
export type ScreenPollResult =
  | { kind: "frame"; screen: string }
  | { kind: "unchanged" }
  | { kind: "gone"; reason: string }
  | { kind: "unavailable"; reason: string };

/** Production poll cadence for the route (~2s). */
export const SCREEN_POLL_MS: number;

/** 8-char short id from a short or full bg job/session id; null on malformed. */
export function deriveScreenShortId(input: string | null | undefined): string | null;

/** Remove ANSI escape sequences + residual control bytes (keeps \n \r \t). */
export function stripAnsi(text: string): string;

/** Canonical screen text for diff + display (ANSI-stripped, lines trimmed). */
export function normalizeScreen(raw: string): string;

/** The production exec: one `claude logs <shortId>` run, classified. */
export function defaultClaudeLogsExec(shortId: string): Promise<ScreenLogsResult>;

/** Stateful poll→diff over one bg session's rendered screen. Never throws. */
export class ScreenPoller {
  constructor(shortId: string, options?: { exec?: ScreenLogsExec });
  shortId: string;
  lastScreen: string | null;
  /** Consecutive polls with an identical screen — the frozen-screen tell. */
  unchangedPolls: number;
  poll(): Promise<ScreenPollResult>;
}
