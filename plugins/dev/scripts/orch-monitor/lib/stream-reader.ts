import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface WorkerActivity {
  currentTool: string | null;
  lastText: string | null;
  eventCount: number;
  toolCalls: number;
  turns: number;
  streamFile: string | null;
  streamSizeBytes: number;
  sessionId: string | null;
  hasRetries: boolean;
}

export interface StreamEvent {
  ts: number;
  type: "tool_start" | "tool_end" | "text" | "turn" | "init" | "retry" | "result";
  tool?: string;
  toolInput?: string;
  text?: string;
  retryInfo?: { attempt: number; maxRetries: number; error: string };
  usage?: Record<string, unknown>;
}

const TAIL_BYTES = 32_768;

function tailLines(filePath: string, maxBytes: number): string[] {
  try {
    const size = statSync(filePath).size;
    if (size === 0) return [];

    const content = readFileSync(filePath, "utf8");
    const trimmed = size <= maxBytes ? content : content.slice(-maxBytes);

    return trimmed.split("\n").filter((l: string) => l.trim().length > 0);
  } catch {
    return [];
  }
}

interface RawStreamObj {
  type?: string;
  subtype?: string;
  data?: { attempt?: number; max_retries?: number; error?: string };
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  usage?: Record<string, unknown>;
}

function parseStreamLine(line: string): StreamEvent | null {
  try {
    const obj = JSON.parse(line) as RawStreamObj | null;
    if (!obj || typeof obj.type !== "string") return null;

    if (obj.type === "system") {
      if (obj.subtype === "init") {
        return { ts: Date.now(), type: "init" };
      }
      if (obj.subtype === "api_retry") {
        return {
          ts: Date.now(),
          type: "retry",
          retryInfo: {
            attempt: obj.data?.attempt ?? 0,
            maxRetries: obj.data?.max_retries ?? 0,
            error: obj.data?.error ?? "unknown",
          },
        };
      }
      return null;
    }

    if (obj.type === "stream_event" && obj.event) {
      const ev = obj.event;
      if (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "tool_use"
      ) {
        return {
          ts: Date.now(),
          type: "tool_start",
          tool: ev.content_block.name ?? "unknown",
        };
      }
      if (ev.type === "content_block_stop") {
        return { ts: Date.now(), type: "tool_end" };
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        return { ts: Date.now(), type: "text", text: ev.delta.text ?? "" };
      }
      if (
        ev.type === "content_block_delta" &&
        ev.delta?.type === "input_json_delta"
      ) {
        return {
          ts: Date.now(),
          type: "tool_start",
          toolInput: ev.delta.partial_json ?? "",
        };
      }
      return null;
    }

    if (obj.type === "assistant") {
      return { ts: Date.now(), type: "turn" };
    }

    if (obj.type === "result") {
      return { ts: Date.now(), type: "result", usage: obj.usage ?? {} };
    }

    return null;
  } catch {
    return null;
  }
}

export function readWorkerActivity(
  orchDir: string,
  ticket: string,
): WorkerActivity | null {
  const streamFile = join(orchDir, "workers", `${ticket}-stream.jsonl`);
  if (!existsSync(streamFile)) return null;

  let streamSizeBytes: number;
  try {
    streamSizeBytes = statSync(streamFile).size;
  } catch {
    return null;
  }

  const lines = tailLines(streamFile, TAIL_BYTES);
  if (lines.length === 0) return null;

  let currentTool: string | null = null;
  let lastText: string | null = null;
  const sessionId: string | null = null;
  let hasRetries = false;
  let toolCalls = 0;
  let turns = 0;

  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (!ev) continue;

    switch (ev.type) {
      case "tool_start":
        if (ev.tool) {
          currentTool = ev.tool;
          toolCalls++;
        }
        break;
      case "tool_end":
        break;
      case "text":
        if (ev.text) lastText = ev.text;
        break;
      case "turn":
        turns++;
        break;
      case "init":
        break;
      case "retry":
        hasRetries = true;
        break;
      case "result":
        currentTool = null;
        break;
    }
  }

  if (lastText && lastText.length > 120) {
    lastText = lastText.slice(-120);
  }

  return {
    currentTool,
    lastText,
    eventCount: lines.length,
    toolCalls,
    turns,
    streamFile,
    streamSizeBytes,
    sessionId,
    hasRetries,
  };
}

export function readRecentStreamEvents(
  orchDir: string,
  ticket: string,
  maxEvents = 30,
): StreamEvent[] {
  const streamFile = join(orchDir, "workers", `${ticket}-stream.jsonl`);
  if (!existsSync(streamFile)) return [];

  const lines = tailLines(streamFile, TAIL_BYTES);
  const events: StreamEvent[] = [];

  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (ev) events.push(ev);
  }

  return events.slice(-maxEvents);
}
