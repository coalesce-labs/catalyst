import { readFileSync } from "fs";
import { join } from "path";

export interface SubAgentCall {
  description: string;
  subagentType: string;
  messageIndex: number;
}

export interface TimelineEntry {
  timestamp: string;
  type: "tool_call" | "tool_result" | "text";
  tool?: string;
  description?: string;
}

export interface WorkerAnalytics {
  ticket: string;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  costUSD: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolUsage: Record<string, number>;
  subAgents: SubAgentCall[];
  timeline: TimelineEntry[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

function asNumber(x: unknown, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function findResultMessage(messages: unknown[]): Record<string, unknown> | null {
  for (const msg of messages) {
    if (isRecord(msg) && msg.type === "result") return msg;
  }
  return null;
}

function firstModelName(modelUsage: unknown): string {
  if (!isRecord(modelUsage)) return "unknown";
  const keys = Object.keys(modelUsage);
  return keys.length > 0 ? keys[0] : "unknown";
}

/**
 * Parse a worker's output.json (a Claude Code session transcript) into a
 * compact analytics object. Returns null if the file is missing, malformed,
 * or does not contain a final `result` message.
 */
export function parseOutputJson(path: string): WorkerAnalytics | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    console.warn(`[output-parser] read failed for ${path}: ${errno.message}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[output-parser] parse failed for ${path}: ${message}`);
    return null;
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[output-parser] expected array at ${path}, got ${typeof parsed}`);
    return null;
  }

  const messages: unknown[] = parsed;
  const result = findResultMessage(messages);
  if (!result) {
    console.warn(`[output-parser] no result message in ${path}`);
    return null;
  }

  const toolUsage: Record<string, number> = {};
  const subAgents: SubAgentCall[] = [];
  const timeline: TimelineEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg: unknown = messages[i];
    if (!isRecord(msg)) continue;

    if (msg.type === "user" && typeof msg.timestamp === "string") {
      timeline.push({ timestamp: msg.timestamp, type: "tool_result" });
    }

    const innerMessage = isRecord(msg.message) ? msg.message : null;
    const content = innerMessage?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = asString(block.name);
      if (!name) continue;
      toolUsage[name] = (toolUsage[name] ?? 0) + 1;

      if (name === "Agent") {
        const input = isRecord(block.input) ? block.input : {};
        subAgents.push({
          description: asString(input.description),
          subagentType: asString(input.subagent_type, "general"),
          messageIndex: i,
        });
      }
    }
  }

  const usage = isRecord(result.usage) ? result.usage : {};
  return {
    ticket: "unknown",
    durationMs: asNumber(result.duration_ms),
    durationApiMs: asNumber(result.duration_api_ms),
    numTurns: asNumber(result.num_turns),
    costUSD: asNumber(result.total_cost_usd),
    model: firstModelName(result.modelUsage),
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    toolUsage,
    subAgents,
    timeline,
  };
}

/**
 * Convenience: returns the conventional path where a worker's output.json
 * lives within an orchestrator directory.
 */
export function analyticsPath(orchDir: string, ticket: string): string {
  return join(orchDir, "workers", "logs", `${ticket}.output.json`);
}
