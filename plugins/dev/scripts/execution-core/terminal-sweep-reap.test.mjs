import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTerminalSweepReap, defaultResolveTerminalSweepReapTarget,
  terminalSweepReapMarkerPath,
} from "./terminal-sweep-reap.mjs";

describe("classifyTerminalSweepReap", () => {
  const valid = Object.freeze({ terminal: true, terminalReason: "pr-merged", worktreePath: "/wt/CAT-9", worktreeOnDisk: true, branch: "CAT-9" });
  test.each([
    [{ ...valid, alreadyRequested: true }, "already-requested"],
    [{ ...valid, liveSessionInWorktree: true }, "live-session-in-worktree"],
    [{ ...valid, inFlight: true }, "in-flight"],
    [{ ...valid, terminal: false }, "not-terminal"],
    [{ ...valid, terminalReason: "linear-terminal", linearState: "Canceled" }, "canceled-not-merged"],
    [{ ...valid, worktreePath: null }, "no-worktree-target"],
    [{ ...valid, worktreeOnDisk: false }, "no-worktree-on-disk"],
    [{ ...valid, branch: null }, "no-branch"],
  ])("skips %s", (ctx, reason) => expect(classifyTerminalSweepReap(ctx)).toEqual({ action: "skip", reason }));
  test("accepts PR merge or explicit Done", () => {
    expect(classifyTerminalSweepReap(valid).action).toBe("reap-request");
    expect(classifyTerminalSweepReap({ ...valid, terminalReason: "linear-terminal", linearState: "Done" }).action).toBe("reap-request");
  });
  test("is pure", () => expect(classifyTerminalSweepReap(valid)).toEqual(classifyTerminalSweepReap(valid)));
});

describe("target and marker", () => {
  test("marker rejects absent identity", () => {
    expect(terminalSweepReapMarkerPath("/orch", "CAT-9")).toBe("/orch/workers/CAT-9/.terminal-sweep-reap.applied");
    for (const value of [null, undefined, "", 9]) expect(() => terminalSweepReapMarkerPath("/orch", value)).toThrow();
    expect(() => terminalSweepReapMarkerPath("", "CAT-9")).toThrow();
  });
  test("resolves registered target and boundary-safe live cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "cat169-")); const wt = join(root, "CAT-9"); mkdirSync(wt);
    const porcelain = `worktree ${wt}\nbranch refs/heads/CAT-9\n`;
    const calls = [];
    const out = defaultResolveTerminalSweepReapTarget({ orchDir: root, ticket: "CAT-9", projects: [{ repoRoot: "/repo" }], agents: [{ cwd: `${wt}/src` }, { cwd: `${wt}-other` }], readWorkerSignals: () => [{ ticket: "CAT-9", worktreePath: wt }], runGit: (args) => { calls.push(args); return { status: 0, stdout: porcelain }; } });
    expect(out).toMatchObject({ worktreePath: wt, branch: "CAT-9", worktreeOnDisk: true, liveSessionInWorktree: true });
    expect(calls).toHaveLength(1);
  });
  test("falls back by branch and never throws on failures", () => {
    const root = mkdtempSync(join(tmpdir(), "cat169-")); const wt = join(root, "CAT-9"); mkdirSync(wt);
    expect(defaultResolveTerminalSweepReapTarget({ orchDir: root, ticket: "CAT-9", projects: [{ repoRoot: "/repo" }], readWorkerSignals: () => [], runGit: () => ({ status: 0, stdout: `worktree ${wt}\nbranch refs/heads/CAT-9\n` }) }).worktreePath).toBe(wt);
    expect(() => defaultResolveTerminalSweepReapTarget({ orchDir: root, ticket: "CAT-9", projects: [{ repoRoot: "/repo" }], readWorkerSignals: () => { throw new Error("bad"); }, runGit: () => { throw new Error("bad"); } })).not.toThrow();
  });
  test("reads the last phase signal carrying bg_job_id", () => {
    const root = mkdtempSync(join(tmpdir(), "cat169-")); const dir = join(root, "workers", "CAT-9"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-a.json"), JSON.stringify({ bg_job_id: "one" }));
    writeFileSync(join(dir, "phase-b.json"), JSON.stringify({ bg_job_id: "two" }));
    expect(defaultResolveTerminalSweepReapTarget({ orchDir: root, ticket: "CAT-9" }).bgJobId).toBe("two");
  });
});
