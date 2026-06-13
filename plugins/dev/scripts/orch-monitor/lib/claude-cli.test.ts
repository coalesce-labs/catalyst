import { describe, it, expect } from "bun:test";
import { runClaudeCli } from "./claude-cli";

function fakeSpawn(result: { status: number; stdout: string; stderr?: string }) {
  const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
  const spawn = (bin: string, args: string[], opts: { input?: string }) => {
    calls.push({ bin, args, input: opts?.input });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { spawn, calls };
}

describe("runClaudeCli", () => {
  it("invokes `claude -p --model <model>` and returns trimmed stdout", () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: "  hello world\n" });
    const res = runClaudeCli(
      { model: "claude-haiku-4-5-20251001", systemPrompt: "SYS", userPrompt: "USR" },
      { spawn },
    );
    expect(res.text).toBe("hello world");
    expect(calls[0].bin).toContain("claude");
    expect(calls[0].args).toEqual(["-p", "--model", "claude-haiku-4-5-20251001"]);
    expect(calls[0].input).toContain("SYS");
    expect(calls[0].input).toContain("USR");
  });

  it("returns null text on non-zero exit", () => {
    const { spawn } = fakeSpawn({ status: 1, stdout: "", stderr: "boom" });
    const res = runClaudeCli(
      { model: "m", systemPrompt: "", userPrompt: "x" },
      { spawn },
    );
    expect(res.text).toBeNull();
  });

  it("returns null text when spawn throws", () => {
    const spawn = () => { throw new Error("ENOENT"); };
    const res = runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, { spawn });
    expect(res.text).toBeNull();
  });

  it("returns null text when stdout is empty string after trim", () => {
    const { spawn } = fakeSpawn({ status: 0, stdout: "   \n  " });
    const res = runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, { spawn });
    expect(res.text).toBeNull();
  });

  it("always returns tokens: 0 (no usage envelope from claude -p)", () => {
    const { spawn } = fakeSpawn({ status: 0, stdout: "hi" });
    const res = runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "x" }, { spawn });
    expect(res.tokens).toBe(0);
  });

  it("concatenates systemPrompt and userPrompt with double newline", () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: "ok" });
    runClaudeCli({ model: "m", systemPrompt: "SYSTEM", userPrompt: "USER" }, { spawn });
    expect(calls[0].input).toBe("SYSTEM\n\nUSER");
  });

  it("uses only userPrompt when systemPrompt is empty", () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: "ok" });
    runClaudeCli({ model: "m", systemPrompt: "", userPrompt: "ONLY_USER" }, { spawn });
    expect(calls[0].input).toBe("ONLY_USER");
  });
});
