import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { sessionIdFromPid, readWorkerTasks } from "./task-reader";

export interface TaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  activeTask: string | null;
}

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
  taskSummary?: TaskSummary | null;
}

export interface StreamEvent {
  ts: number;
  type:
    | "tool_start"
    | "tool_end"
    | "text"
    | "turn"
    | "init"
    | "retry"
    | "result"
    | "rate_limit";
  tool?: string;
  toolInput?: string;
  text?: string;
  /** Tool names invoked in this assistant turn (extracted from message.content) */
  turnTools?: string[];
  retryInfo?: { attempt: number; maxRetries: number; error: string };
  rateLimitInfo?: { status: string; resetsAt?: number };
  usage?: Record<string, unknown>;
  sessionId?: string;
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

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
}

interface RawStreamObj {
  type?: string;
  subtype?: string;
  session_id?: string;
  data?: { attempt?: number; max_retries?: number; error?: string };
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  message?: {
    content?: ContentBlock[];
    stop_reason?: string;
  };
  rate_limit_info?: { status?: string; resets_at?: number; resetsAt?: number };
  usage?: Record<string, unknown>;
}

function parseStreamLine(line: string): StreamEvent[] {
  try {
    const obj = JSON.parse(line) as RawStreamObj | null;
    if (!obj || typeof obj.type !== "string") return [];

    if (obj.type === "system") {
      if (obj.subtype === "init") {
        return [{ ts: Date.now(), type: "init", sessionId: obj.session_id }];
      }
      if (obj.subtype === "api_retry") {
        return [
          {
            ts: Date.now(),
            type: "retry",
            retryInfo: {
              attempt: obj.data?.attempt ?? 0,
              maxRetries: obj.data?.max_retries ?? 0,
              error: obj.data?.error ?? "unknown",
            },
          },
        ];
      }
      return [];
    }

    if (obj.type === "stream_event" && obj.event) {
      const ev = obj.event;
      if (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "tool_use"
      ) {
        return [
          {
            ts: Date.now(),
            type: "tool_start",
            tool: ev.content_block.name ?? "unknown",
          },
        ];
      }
      if (ev.type === "content_block_stop") {
        return [{ ts: Date.now(), type: "tool_end" }];
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        return [{ ts: Date.now(), type: "text", text: ev.delta.text ?? "" }];
      }
      if (
        ev.type === "content_block_delta" &&
        ev.delta?.type === "input_json_delta"
      ) {
        return [
          {
            ts: Date.now(),
            type: "tool_start",
            toolInput: ev.delta.partial_json ?? "",
          },
        ];
      }
      return [];
    }

    if (obj.type === "assistant") {
      const tools: string[] = [];
      let textPreview: string | null = null;
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            tools.push(block.name);
          }
          if (block.type === "text" && block.text && !textPreview) {
            textPreview = block.text.slice(0, 120);
          }
        }
      }
      return [
        {
          ts: Date.now(),
          type: "turn",
          turnTools: tools.length > 0 ? tools : undefined,
          text: textPreview || undefined,
          sessionId: obj.session_id,
        },
      ];
    }

    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      return [
        {
          ts: Date.now(),
          type: "rate_limit",
          rateLimitInfo: {
            status: obj.rate_limit_info.status ?? "unknown",
            resetsAt:
              obj.rate_limit_info.resetsAt ?? obj.rate_limit_info.resets_at,
          },
        },
      ];
    }

    if (obj.type === "result") {
      return [{ ts: Date.now(), type: "result", usage: obj.usage ?? {} }];
    }

    return [];
  } catch {
    return [];
  }
}

export function readWorkerActivity(
  orchDir: string,
  ticket: string,
  pid?: number | null,
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
  let sessionId: string | null = null;
  let hasRetries = false;
  let toolCalls = 0;
  let turns = 0;

  for (const line of lines) {
    const events = parseStreamLine(line);
    for (const ev of events) {
      if (ev.sessionId && !sessionId) sessionId = ev.sessionId;

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
  }

  if (lastText && lastText.length > 120) {
    lastText = lastText.slice(-120);
  }

  // Read task list if we have a session ID (from stream) or can look it up via PID
  let taskSummary: TaskSummary | null = null;
  const resolvedSessionId =
    sessionId || (pid ? sessionIdFromPid(pid) : null);
  if (resolvedSessionId) {
    const taskList = readWorkerTasks(resolvedSessionId);
    if (taskList) {
      const activeTask = taskList.tasks.find(
        (t) => t.status === "in_progress",
      );
      taskSummary = {
        total: taskList.total,
        completed: taskList.completed,
        inProgress: taskList.inProgress,
        activeTask: activeTask?.activeForm || activeTask?.subject || null,
      };
    }
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
    taskSummary,
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
    events.push(...parseStreamLine(line));
  }

  return events.slice(-maxEvents);
}
