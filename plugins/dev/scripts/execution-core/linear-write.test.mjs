// linear-write.test.mjs — execution-core Linear status write-back (CTL-558).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write.test.mjs
import { describe, test, expect } from "bun:test";
import {
  applyPhaseStatus,
  applyTerminalDone,
  applyLabel,
  teamOf,
} from "./linear-write.mjs";

const okExec = (calls) => (cmd, args) => {
  calls.push({ cmd, args });
  return { code: 0, stdout: JSON.stringify({ action: "transitioned" }), stderr: "" };
};

describe("teamOf", () => {
  test("extracts the identifier prefix", () => {
    expect(teamOf("CTL-558")).toBe("CTL");
    expect(teamOf("ENG-1")).toBe("ENG");
  });
  test("returns null for a malformed identifier", () => {
    expect(teamOf("nonsense")).toBeNull();
    expect(teamOf("")).toBeNull();
    expect(teamOf(null)).toBeNull();
  });
});

describe("applyPhaseStatus", () => {
  test("skips triage — no status key, no exec call", () => {
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "triage",
      resolveRepoRoot: () => "/repo",
      exec: okExec(calls),
    });
    expect(r.skipped).toBe("no-status-key");
    expect(calls).toHaveLength(0);
  });
  test("shells linear-transition.sh with the phase's mapped --transition key", () => {
    const calls = [];
    applyPhaseStatus({
      ticket: "CTL-1",
      phase: "verify",
      resolveRepoRoot: () => "/repo",
      exec: okExec(calls),
    });
    const args = calls[0].args;
    expect(args).toContain("--transition");
    expect(args[args.indexOf("--transition") + 1]).toBe("verifying");
    expect(args).toContain("--ticket");
    expect(args).toContain("CTL-1");
    expect(args.join(" ")).toContain("/repo/.catalyst/config.json");
  });
  test("returns applied:false when the repo root cannot be resolved", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot: () => null,
      exec: okExec([]),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("no-repo-root");
  });
  test("returns applied:false on a non-zero linear-transition exit", () => {
    const exec = () => ({ code: 2, stdout: "", stderr: "update-failed" });
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot: () => "/repo",
      exec,
    });
    expect(r.applied).toBe(false);
  });
  test("never throws — a thrown exec is caught and reported", () => {
    const exec = () => {
      throw new Error("spawn boom");
    };
    expect(() =>
      applyPhaseStatus({
        ticket: "CTL-1",
        phase: "plan",
        resolveRepoRoot: () => "/repo",
        exec,
      })
    ).not.toThrow();
  });
});

describe("applyTerminalDone", () => {
  test("shells linear-transition.sh with --transition done", () => {
    const calls = [];
    applyTerminalDone({ ticket: "CTL-1", resolveRepoRoot: () => "/repo", exec: okExec(calls) });
    const args = calls[0].args;
    expect(args[args.indexOf("--transition") + 1]).toBe("done");
  });
});

describe("applyLabel", () => {
  test("shells linearis issues update --labels <l> --label-mode add", () => {
    const calls = [];
    applyLabel({ ticket: "CTL-1", label: "needs-human", exec: okExec(calls) });
    const args = calls[0].args;
    expect(args.slice(0, 3)).toEqual(["issues", "update", "CTL-1"]);
    expect(args).toContain("--labels");
    expect(args[args.indexOf("--labels") + 1]).toBe("needs-human");
    expect(args[args.indexOf("--label-mode") + 1]).toBe("add");
  });
  test("never throws on a failed label exec", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "no such label" });
    expect(() => applyLabel({ ticket: "CTL-1", label: "needs-human", exec })).not.toThrow();
  });
});
