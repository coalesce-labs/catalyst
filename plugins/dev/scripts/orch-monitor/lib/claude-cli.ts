import { spawnSync } from "node:child_process";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ClaudeCliArgs {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface ClaudeCliResult {
  text: string | null;
  tokens: number;
}

// Injectable spawn seam (mirrors stop-worker.mjs pattern): tests pass a fake.
export function runClaudeCli(
  args: ClaudeCliArgs,
  { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS }: {
    spawn?: typeof spawnSync;
    timeout?: number;
  } = {},
): ClaudeCliResult {
  const input = args.systemPrompt
    ? `${args.systemPrompt}\n\n${args.userPrompt}`
    : args.userPrompt;
  try {
    const res = spawn(CLAUDE_BIN, ["-p", "--model", args.model], {
      input,
      encoding: "utf8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if ((res?.status ?? 1) !== 0) return { text: null, tokens: 0 };
    const text = typeof res.stdout === "string" ? res.stdout.trim() : "";
    return { text: text.length > 0 ? text : null, tokens: 0 };
  } catch {
    return { text: null, tokens: 0 };
  }
}
