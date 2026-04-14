import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseOutputJson, analyticsPath } from "../lib/output-parser";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "output-parser-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeOutput(name: string, data: unknown): string {
  const path = join(tmpRoot, `${name}.output.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

function resultMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 100_000,
    duration_api_ms: 60_000,
    num_turns: 12,
    total_cost_usd: 1.23,
    modelUsage: { "claude-opus-4-6": { costUSD: 1.23 } },
    ...overrides,
  };
}

function assistantToolUse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input }],
    },
  };
}

function userToolResult(timestamp?: string): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: "user",
    message: { content: [{ type: "tool_result" }] },
  };
  if (timestamp) msg.timestamp = timestamp;
  return msg;
}

describe("parseOutputJson", () => {
  it("extracts analytics from a valid session with tool_use blocks and an Agent call", () => {
    const path = writeOutput("ADV-1", [
      { type: "system", subtype: "init" },
      assistantToolUse("Bash", { command: "ls" }),
      userToolResult("2026-04-13T19:31:50.000Z"),
      assistantToolUse("Read", { file_path: "/x" }),
      userToolResult("2026-04-13T19:31:51.000Z"),
      assistantToolUse("Agent", {
        description: "research codebase",
        subagent_type: "catalyst-dev:codebase-locator",
      }),
      userToolResult("2026-04-13T19:31:52.000Z"),
      resultMsg(),
    ]);

    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.durationMs).toBe(100_000);
    expect(a!.durationApiMs).toBe(60_000);
    expect(a!.numTurns).toBe(12);
    expect(a!.costUSD).toBe(1.23);
    expect(a!.model).toBe("claude-opus-4-6");
    expect(a!.toolUsage).toEqual({ Bash: 1, Read: 1, Agent: 1 });
    expect(a!.subAgents).toHaveLength(1);
    expect(a!.subAgents[0].description).toBe("research codebase");
    expect(a!.subAgents[0].subagentType).toBe("catalyst-dev:codebase-locator");
    expect(a!.subAgents[0].messageIndex).toBe(5);
    expect(a!.timeline).toHaveLength(3);
    expect(a!.timeline[0]).toEqual({
      timestamp: "2026-04-13T19:31:50.000Z",
      type: "tool_result",
    });
  });

  it("returns null and warns when the file is missing", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = parseOutputJson(join(tmpRoot, "does-not-exist.output.json"));
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("[output-parser]");
    warn.mockRestore();
  });

  it("returns null and warns when JSON is malformed", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const path = join(tmpRoot, "bad.output.json");
    writeFileSync(path, "{this is not json");
    const result = parseOutputJson(path);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("parse failed");
    warn.mockRestore();
  });

  it("parses summary object format (claude --output-format json)", () => {
    const path = writeOutput("summary", {
      type: "result",
      duration_ms: 5000,
      duration_api_ms: 3000,
      num_turns: 10,
      total_cost_usd: 4.26,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 80, outputTokens: 180,
          cacheReadInputTokens: 300, costUSD: 4.0,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 20, outputTokens: 20,
          cacheReadInputTokens: 0, costUSD: 0.26,
        },
      },
    });
    const result = parseOutputJson(path);
    expect(result).not.toBeNull();
    expect(result!.costUSD).toBe(4.26);
    expect(result!.inputTokens).toBe(100);
    expect(result!.outputTokens).toBe(200);
    expect(result!.cacheReadTokens).toBe(300);
    expect(result!.model).toBe("claude-opus-4-6");
    expect(Object.keys(result!.modelBreakdown)).toHaveLength(2);
    expect(result!.modelBreakdown["claude-opus-4-6"].costUSD).toBe(4.0);
    expect(result!.modelBreakdown["claude-haiku-4-5-20251001"].costUSD).toBe(0.26);
  });

  it("returns null when the top-level value is a non-result object", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const path = writeOutput("obj", { type: "assistant", content: "hello" });
    const result = parseOutputJson(path);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null when array contains no result message", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const path = writeOutput("noresult", [
      { type: "system", subtype: "init" },
      assistantToolUse("Bash"),
    ]);
    const result = parseOutputJson(path);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns empty toolUsage and subAgents when no tool_use blocks present", () => {
    const path = writeOutput("empty-tools", [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      resultMsg(),
    ]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.toolUsage).toEqual({});
    expect(a!.subAgents).toEqual([]);
  });

  it("captures multiple Agent calls in message order", () => {
    const path = writeOutput("multi-agent", [
      assistantToolUse("Agent", { description: "first", subagent_type: "type-a" }),
      userToolResult(),
      assistantToolUse("Agent", { description: "second", subagent_type: "type-b" }),
      assistantToolUse("Agent", { description: "third", subagent_type: "type-c" }),
      resultMsg(),
    ]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.subAgents).toHaveLength(3);
    expect(a!.subAgents.map((s) => s.description)).toEqual(["first", "second", "third"]);
    expect(a!.subAgents.map((s) => s.subagentType)).toEqual(["type-a", "type-b", "type-c"]);
    expect(a!.subAgents[0].messageIndex).toBe(0);
    expect(a!.subAgents[1].messageIndex).toBe(2);
    expect(a!.subAgents[2].messageIndex).toBe(3);
    expect(a!.toolUsage).toEqual({ Agent: 3 });
  });

  it("populates timeline only from user messages that have timestamps", () => {
    const path = writeOutput("timeline", [
      userToolResult("2026-04-13T20:00:00.000Z"),
      userToolResult(),
      userToolResult("2026-04-13T20:00:01.000Z"),
      resultMsg(),
    ]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.timeline).toHaveLength(2);
    expect(a!.timeline[0].timestamp).toBe("2026-04-13T20:00:00.000Z");
    expect(a!.timeline[1].timestamp).toBe("2026-04-13T20:00:01.000Z");
  });

  it("falls back to defaults when result fields are missing", () => {
    const path = writeOutput("partial-result", [{ type: "result" }]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.durationMs).toBe(0);
    expect(a!.durationApiMs).toBe(0);
    expect(a!.numTurns).toBe(0);
    expect(a!.costUSD).toBe(0);
    expect(a!.model).toBe("unknown");
    expect(a!.inputTokens).toBe(0);
    expect(a!.outputTokens).toBe(0);
    expect(a!.cacheReadTokens).toBe(0);
  });

  it("extracts token usage from result.usage when present", () => {
    const path = writeOutput("tokens", [
      resultMsg({
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 9876,
        },
      }),
    ]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.inputTokens).toBe(1234);
    expect(a!.outputTokens).toBe(567);
    expect(a!.cacheReadTokens).toBe(9876);
  });

  it("defaults token counts to zero when usage field absent", () => {
    const path = writeOutput("no-usage", [resultMsg()]);
    const a = parseOutputJson(path);
    expect(a).not.toBeNull();
    expect(a!.inputTokens).toBe(0);
    expect(a!.outputTokens).toBe(0);
    expect(a!.cacheReadTokens).toBe(0);
  });
});

describe("analyticsPath", () => {
  it("returns the conventional output.json path inside an orch dir", () => {
    const path = analyticsPath("/tmp/orch-foo", "ADV-216");
    expect(path).toBe("/tmp/orch-foo/workers/logs/ADV-216.output.json");
  });

  it("composes paths cleanly even when orchDir ends without trailing slash", () => {
    const orchDir = mkdtempSync(join(tmpRoot, "orch-"));
    mkdirSync(join(orchDir, "workers", "logs"), { recursive: true });
    const expected = join(orchDir, "workers", "logs", "T-1.output.json");
    expect(analyticsPath(orchDir, "T-1")).toBe(expected);
  });
});
