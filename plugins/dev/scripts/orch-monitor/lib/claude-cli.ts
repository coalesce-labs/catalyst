import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
// Bounded poll budget for a one-shot --bg job to reach a terminal state.
// A --bg one-shot spins a full agent session (~5s) so we allow headroom but
// cap it: this provider is LOW-VOLUME only (escalation blurbs / briefings).
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

export interface ClaudeCliArgs {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface ClaudeCliResult {
  text: string | null;
  tokens: number;
}

/**
 * Minimal spawn seam (CTL-1109 remediate). We only depend on this slice of
 * `spawnSync`, so test doubles satisfy it without `as unknown as` casts —
 * unlike `typeof spawnSync`, whose `NonSharedBuffer` stdout and full overload
 * set the fakes could not match.
 */
export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { input?: string; encoding?: string; timeout?: number },
) => { status: number | null; stdout: string; stderr: string };

/** The slice of `~/.claude/jobs/<jobid>/state.json` we read. */
export interface ClaudeJobState {
  state?: string;
  sessionId?: string;
  cwd?: string;
  firstTerminalAt?: string;
}

/** Injectable seams for the --bg job lifecycle so tests touch no real fs/clock. */
export interface ClaudeCliDeps {
  spawn?: SpawnFn;
  /** Read+parse `~/.claude/jobs/<jobid>/state.json`; null if absent/unreadable. */
  readState?: (jobId: string) => ClaudeJobState | null;
  /** Last assistant text from the session transcript; null if absent/empty. */
  readTranscript?: (cwd: string, sessionId: string) => string | null;
  /** Poll delay — injected so tests resolve instantly. */
  sleep?: (ms: number) => Promise<void>;
  timeout?: number;
}

export type RunClaudeCli = (
  args: ClaudeCliArgs,
  deps?: ClaudeCliDeps,
) => Promise<ClaudeCliResult>;

// A daemon job that has reached any of these is done (or `firstTerminalAt` set).
const TERMINAL_STATES = new Set([
  "stopped",
  "completed",
  "complete",
  "failed",
  "error",
  "killed",
  "cancelled",
]);

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const res = spawnSync(bin, args, {
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeout,
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
};

function defaultReadState(jobId: string): ClaudeJobState | null {
  try {
    const raw = readFileSync(`${homedir()}/.claude/jobs/${jobId}/state.json`, "utf8");
    return JSON.parse(raw) as ClaudeJobState;
  } catch {
    return null;
  }
}

/**
 * Encode an absolute cwd to its `~/.claude/projects/<dir>` form. Claude Code
 * maps `/` and `.` to `-` (e.g. `/a/.claude` → `-a--claude`); verified against
 * live project dirs (CTL-1109).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function extractAssistantText(evt: unknown): string | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as { type?: string; message?: { role?: string; content?: unknown } };
  if (e.type !== "assistant" || e.message?.role !== "assistant") return null;
  const content = e.message.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object" &&
      (block as { type?: string }).type === "text"
    ) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

function defaultReadTranscript(cwd: string, sessionId: string): string | null {
  try {
    const path =
      `${homedir()}/.claude/projects/${encodeProjectDir(cwd)}/${sessionId}.jsonl`;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    // Walk backwards to the LAST assistant message that carries text — the
    // final turn is often a tool_use block with no text (verified live).
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractAssistantText(evt);
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse the `backgrounded · <jobid>` banner `claude --bg` prints to stdout.
 * The job ID is the 8-char hex short ID (see lib/claude-ids.sh).
 */
export function parseBackgroundJobId(stdout: string): string | null {
  const banner = stdout.match(/backgrounded[^0-9a-f]*([0-9a-f]{8})\b/i);
  if (banner) return banner[1];
  const hex = stdout.match(/\b([0-9a-f]{8})\b/);
  return hex ? hex[1] : null;
}

function isTerminal(state: ClaudeJobState): boolean {
  if (state.firstTerminalAt) return true;
  return state.state ? TERMINAL_STATES.has(state.state) : false;
}

/**
 * Run a one-shot Claude generation on the host's **Claude Max subscription**
 * (cost = 0 against the metered API) by driving `claude --bg`, NOT `claude -p`.
 *
 * Correction verified live 2026-06-13 (CTL-1109): `-p` now bills the metered
 * API; only `--bg` runs on the subscription windows. Flow:
 *   1. spawn `claude --bg --model <m> --dangerously-skip-permissions "<prompt>"`,
 *      parse `backgrounded · <jobid>` from stdout;
 *   2. read sessionId from `~/.claude/jobs/<jobid>/state.json`;
 *   3. poll state.json to a terminal state (bounded by `timeout`);
 *   4. extract the last assistant text from the session transcript
 *      `~/.claude/projects/<enc(cwd)>/<sessionId>.jsonl`.
 * `claude logs` is deliberately avoided — it returns raw TUI escape codes.
 *
 * All failure modes (spawn throw, non-zero exit, no banner, missing state,
 * timeout, empty transcript) degrade to `{ text: null, tokens: 0 }` with a
 * single `[claude-cli]` warn for observability (the degrade-to-null contract
 * the callers depend on is unchanged). tokens is always 0: subscription runs
 * carry no API usage envelope here.
 */
export async function runClaudeCli(
  args: ClaudeCliArgs,
  deps: ClaudeCliDeps = {},
): Promise<ClaudeCliResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const readState = deps.readState ?? defaultReadState;
  const readTranscript = deps.readTranscript ?? defaultReadTranscript;
  const sleep = deps.sleep ?? defaultSleep;
  const timeout = deps.timeout ?? DEFAULT_TIMEOUT_MS;

  const prompt = args.systemPrompt
    ? `${args.systemPrompt}\n\n${args.userPrompt}`
    : args.userPrompt;

  try {
    const launch = spawn(
      CLAUDE_BIN,
      ["--bg", "--model", args.model, "--dangerously-skip-permissions", prompt],
      { encoding: "utf8", timeout },
    );
    if ((launch?.status ?? 1) !== 0) {
      console.warn(
        `[claude-cli] --bg launch exited ${String(launch?.status)}: ${launch?.stderr ?? ""}`,
      );
      return { text: null, tokens: 0 };
    }
    const jobId = parseBackgroundJobId(launch.stdout ?? "");
    if (!jobId) {
      console.warn(`[claude-cli] could not parse a job id from --bg stdout`);
      return { text: null, tokens: 0 };
    }

    let waited = 0;
    let state: ClaudeJobState | null = null;
    for (;;) {
      state = readState(jobId);
      if (state && isTerminal(state)) break;
      if (waited >= timeout) {
        console.warn(
          `[claude-cli] job ${jobId} did not reach terminal within ${String(timeout)}ms`,
        );
        return { text: null, tokens: 0 };
      }
      await sleep(POLL_INTERVAL_MS);
      waited += POLL_INTERVAL_MS;
    }

    const sessionId = state.sessionId;
    const cwd = state.cwd;
    if (!sessionId || !cwd) {
      console.warn(
        `[claude-cli] job ${jobId} terminal but missing sessionId/cwd in state.json`,
      );
      return { text: null, tokens: 0 };
    }

    const text = readTranscript(cwd, sessionId);
    if (!text) {
      console.warn(
        `[claude-cli] no assistant text in transcript for session ${sessionId}`,
      );
      return { text: null, tokens: 0 };
    }
    return { text, tokens: 0 };
  } catch (err) {
    console.warn(
      `[claude-cli] run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { text: null, tokens: 0 };
  }
}
