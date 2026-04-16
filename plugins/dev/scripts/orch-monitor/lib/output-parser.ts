import { existsSync, readFileSync } from "fs";
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

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUSD: number;
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
  modelBreakdown: Record<string, ModelUsage>;
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

function extractModelBreakdown(modelUsage: unknown): Record<string, ModelUsage> {
  const breakdown: Record<string, ModelUsage> = {};
  if (!isRecord(modelUsage)) return breakdown;
  for (const [model, data] of Object.entries(modelUsage)) {
    if (!isRecord(data)) continue;
    breakdown[model] = {
      inputTokens: asNumber(data.inputTokens),
      outputTokens: asNumber(data.outputTokens),
      cacheReadTokens: asNumber(data.cacheReadInputTokens),
      costUSD: asNumber(data.costUSD),
    };
  }
  return breakdown;
}

function parseResultObject(result: Record<string, unknown>): Omit<WorkerAnalytics, "toolUsage" | "subAgents" | "timeline"> {
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
    modelBreakdown: extractModelBreakdown(result.modelUsage),
  };
}

/**
 * Parse a worker's output.json into analytics. Supports two formats:
 * - Array of messages (streaming transcript with a "result" entry)
 * - Single object (claude --output-format json summary)
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

  // Summary object format (claude --output-format json)
  if (isRecord(parsed) && parsed.type === "result") {
    const base = parseResultObject(parsed);
    return { ...base, toolUsage: {}, subAgents: [], timeline: [] };
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[output-parser] unexpected format at ${path}`);
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

  const base = parseResultObject(result);
  return { ...base, toolUsage, subAgents, timeline };
}

/**
 * Returns the path to a worker's output.json within an orchestrator directory.
 * Checks, in priority order:
 *   1. workers/output/<ticket>-output.json (CTL-59 layout — runs/<id>/workers/output/)
 *   2. workers/logs/<ticket>.output.json   (older convention, pre-CTL-59)
 *   3. workers/<ticket>-output.json        (flat legacy convention)
 */
export function analyticsPath(orchDir: string, ticket: string): string {
  const outputSubdirPath = join(orchDir, "workers", "output", `${ticket}-output.json`);
  if (existsSync(outputSubdirPath)) return outputSubdirPath;
  const logsPath = join(orchDir, "workers", "logs", `${ticket}.output.json`);
  if (existsSync(logsPath)) return logsPath;
  const flatPath = join(orchDir, "workers", `${ticket}-output.json`);
  if (existsSync(flatPath)) return flatPath;
  return outputSubdirPath;
}
