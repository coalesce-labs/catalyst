import { describe, it, expect } from "bun:test";
import {
  type ClaudeCliDeps,
  type ClaudeJobState,
  type SpawnFn,
  encodeProjectDir,
  parseBackgroundJobId,
  runClaudeCli,
} from "./claude-cli";

// A spawn double that records calls and returns a fixed `claude --bg` result.
// Typed as the minimal SpawnFn seam — no `as unknown as typeof spawnSync` cast.
function fakeSpawn(result: { status: number; stdout: string; stderr?: string }) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { spawn, calls };
}

// Default happy-path deps: a launch banner, an immediately-terminal job, and a
// transcript that yields text. Individual tests override one seam at a time.
function happyDeps(
  overrides: Partial<ClaudeCliDeps> = {},
  spawnResult: { status: number; stdout: string; stderr?: string } = {
    status: 0,
    stdout: "backgrounded · 729bf9f1\n",
  },
): { deps: ClaudeCliDeps; spawnCalls: Array<{ bin: string; args: string[] }> } {
  const { spawn, calls } = fakeSpawn(spawnResult);
  const state: ClaudeJobState = {
    state: "stopped",
    sessionId: "729bf9f1-0708-4723-9aa3-f1f1ad3eac3f",
    cwd: "/Users/me/wt/CTL-1",
    firstTerminalAt: "2026-06-13T22:00:00Z",
  };
  const deps: ClaudeCliDeps = {
    spawn,
    readState: () => state,
    readTranscript: () => "hello world",
    sleep: () => Promise.resolve(),
    ...overrides,
  };
  return { deps, spawnCalls: calls };
}

describe("parseBackgroundJobId", () => {
  it("extracts the short hex id from the backgrounded banner", () => {
    expect(parseBackgroundJobId("backgrounded · 729bf9f1\n")).toBe("729bf9f1");
  });
  it("tolerates banner spacing/punctuation variants", () => {
    expect(parseBackgroundJobId("✔ backgrounded - 164891e9 (CTL-1)")).toBe("164891e9");
  });
  it("returns null when no 8-hex token is present", () => {
    expect(parseBackgroundJobId("nothing here")).toBeNull();
  });
});

describe("encodeProjectDir", () => {
  it("maps / and . to - (matches ~/.claude/projects encoding)", () => {
    expect(encodeProjectDir("/a/b/CTL-1")).toBe("-a-b-CTL-1");
    expect(encodeProjectDir("/x/.claude/wt")).toBe("-x--claude-wt");
  });
});

describe("runClaudeCli (--bg subscription flow)", () => {
  it("drives `claude --bg --model <m> --dangerously-skip-permissions <prompt>`", async () => {
    const { deps, spawnCalls } = happyDeps();
    const res = await runClaudeCli(
      { model: "claude-haiku-4-5-20251001", systemPrompt: "SYS", userPrompt: "USR" },
      deps,
    );
    expect(res.text).toBe("hello world");
    expect(spawnCalls[0].bin).toContain("claude");
    expect(spawnCalls[0].args.slice(0, 4)).toEqual([
      "--bg",
      "--model",
      "claude-haiku-4-5-20251001",
      "--dangerously-skip-permissions",
    ]);
    // Prompt is passed as the trailing positional arg (NOT `-p`, NOT stdin).
    expect(spawnCalls[0].args[4]).toBe("SYS\n\nUSR");
    expect(spawnCalls[0].args).not.toContain("-p");
  });

  it("uses only userPrompt when systemPrompt is empty", async () => {
    const { deps, spawnCalls } = happyDeps();
    await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "ONLY" }, deps);
    expect(spawnCalls[0].args[4]).toBe("ONLY");
  });

  it("reads the last assistant text from the resolved transcript", async () => {
    const seen: Array<{ cwd: string; sessionId: string }> = [];
    const { deps } = happyDeps({
      readTranscript: (cwd, sessionId) => {
        seen.push({ cwd, sessionId });
        return "the summary";
      },
    });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBe("the summary");
    expect(seen[0]).toEqual({
      cwd: "/Users/me/wt/CTL-1",
      sessionId: "729bf9f1-0708-4723-9aa3-f1f1ad3eac3f",
    });
  });

  it("always returns tokens: 0 (subscription run, no API usage envelope)", async () => {
    const { deps } = happyDeps();
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.tokens).toBe(0);
  });

  it("returns null when the --bg launch exits non-zero", async () => {
    const { deps } = happyDeps({}, { status: 1, stdout: "", stderr: "boom" });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBeNull();
  });

  it("returns null when spawn throws", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    const res = await runClaudeCli(
      { model: "m", systemPrompt: "", userPrompt: "x" },
      { spawn, sleep: () => Promise.resolve() },
    );
    expect(res.text).toBeNull();
  });

  it("returns null when no job id can be parsed from the banner", async () => {
    const { deps } = happyDeps({}, { status: 0, stdout: "no id here\n" });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBeNull();
  });

  it("polls until the job reaches a terminal state", async () => {
    const states: ClaudeJobState[] = [
      { state: "running" },
      { state: "running" },
      {
        state: "stopped",
        sessionId: "abc",
        cwd: "/w",
        firstTerminalAt: "2026-06-13T22:00:00Z",
      },
    ];
    let i = 0;
    const { deps } = happyDeps({
      readState: () => states[Math.min(i++, states.length - 1)],
      readTranscript: () => "done",
    });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBe("done");
    expect(i).toBeGreaterThanOrEqual(3);
  });

  it("returns null when the job never reaches a terminal state before timeout", async () => {
    const { deps } = happyDeps({ readState: () => ({ state: "running" }) });
    const res = await runClaudeCli(
      { model: "m", systemPrompt: "", userPrompt: "x" },
      { ...deps, timeout: 3000 },
    );
    expect(res.text).toBeNull();
  });

  it("returns null when the transcript has no assistant text", async () => {
    const { deps } = happyDeps({ readTranscript: () => null });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBeNull();
  });

  it("returns null when the terminal state lacks sessionId/cwd", async () => {
    const { deps } = happyDeps({ readState: () => ({ state: "stopped" }) });
    const res = await runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, deps);
    expect(res.text).toBeNull();
  });
});
