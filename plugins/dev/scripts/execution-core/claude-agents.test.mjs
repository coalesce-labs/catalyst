// claude-agents.test.mjs — CTL-657. `claude agents --json` is the single source
// of truth for bg-worker liveness, termination, and concurrency. These tests
// exercise the pure logic against injected payloads (the `exec`/`agents`/`spawn`
// seams) so nothing shells out to the real `claude`.

import { describe, test, expect } from "bun:test";
import {
  listClaudeAgents,
  agentForShortId,
  isBgJobAlive,
  countBackgroundAgents,
  claudeStop,
} from "./claude-agents.mjs";

const agents = [
  { sessionId: "11111111-aaaa-bbbb-cccc-000000000001", status: "busy", kind: "background" },
  { sessionId: "22222222-aaaa-bbbb-cccc-000000000002", status: "idle", kind: "background" },
  { sessionId: "33333333-aaaa-bbbb-cccc-000000000003", status: "busy", kind: "interactive" },
];

describe("listClaudeAgents", () => {
  test("parses the JSON array from exec", () => {
    expect(listClaudeAgents({ exec: () => JSON.stringify(agents) })).toHaveLength(3);
  });

  test("returns [] on a throwing exec (binary missing)", () => {
    const exec = () => {
      throw new Error("claude: command not found");
    };
    expect(listClaudeAgents({ exec })).toEqual([]);
  });

  test("returns [] on non-JSON output", () => {
    expect(listClaudeAgents({ exec: () => "not json" })).toEqual([]);
  });

  test("returns [] when the parsed value is not an array", () => {
    expect(listClaudeAgents({ exec: () => JSON.stringify({ not: "an array" }) })).toEqual([]);
  });
});

describe("agentForShortId", () => {
  test("finds the matching session by 8-char prefix", () => {
    expect(agentForShortId("22222222", agents)?.status).toBe("idle");
  });

  test("null when no session matches or inputs are malformed", () => {
    expect(agentForShortId("deadbeef", agents)).toBeNull();
    expect(agentForShortId("", agents)).toBeNull();
    expect(agentForShortId("11111111", null)).toBeNull();
  });
});

describe("isBgJobAlive", () => {
  test("true for a busy matching session", () => {
    expect(isBgJobAlive("11111111", { agents })).toBe(true);
  });

  test("true for an idle-between-turns session (still listed = alive)", () => {
    expect(isBgJobAlive("22222222", { agents })).toBe(true);
  });

  test("false when no session matches (crashed → dropped off the list)", () => {
    expect(isBgJobAlive("deadbeef", { agents })).toBe(false);
  });

  test("false for a falsy or malformed id, without consulting agents", () => {
    expect(isBgJobAlive(null, { agents })).toBe(false);
    expect(isBgJobAlive("bg-9", { agents })).toBe(false);
  });

  test("accepts the full UUID form (truncates to the short id)", () => {
    expect(isBgJobAlive("11111111-aaaa-bbbb-cccc-000000000001", { agents })).toBe(true);
  });

  test("falls back to listing agents when no list is injected", () => {
    expect(isBgJobAlive("22222222", { exec: () => JSON.stringify(agents) })).toBe(true);
  });
});

describe("countBackgroundAgents", () => {
  test("counts only kind==='background' (interactive sessions are excluded)", () => {
    expect(countBackgroundAgents({ agents })).toBe(2);
  });

  test("does NOT count an absent/unknown kind (fail-low so it can't starve dispatch)", () => {
    const mixed = [
      { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", kind: "background" },
      { sessionId: "bbbbbbbb-0000-0000-0000-000000000000" }, // no kind
      { sessionId: "cccccccc-0000-0000-0000-000000000000", kind: "interactive" },
    ];
    expect(countBackgroundAgents({ agents: mixed })).toBe(1);
  });

  test("0 for an empty fleet", () => {
    expect(countBackgroundAgents({ agents: [] })).toBe(0);
  });
});

describe("claudeStop", () => {
  test("issues `claude stop <shortId>` and reports ok on rc 0", () => {
    const calls = [];
    const spawn = (bin, args) => {
      calls.push({ bin, args });
      return { status: 0 };
    };
    expect(claudeStop("12345678", { spawn })).toEqual({ ok: true });
    expect(calls[0].args).toEqual(["stop", "12345678"]);
  });

  test("reports {ok:false} with stderr on a non-zero rc", () => {
    const spawn = () => ({ status: 1, stderr: "no such session\n" });
    expect(claudeStop("12345678", { spawn })).toEqual({ ok: false, error: "no such session" });
  });

  test("never throws — a throwing spawn becomes {ok:false}", () => {
    const spawn = () => {
      throw new Error("spawn EACCES");
    };
    expect(claudeStop("12345678", { spawn }).ok).toBe(false);
  });
});
