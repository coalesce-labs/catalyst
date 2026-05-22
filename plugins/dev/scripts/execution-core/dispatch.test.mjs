// Unit tests for the execution-core worker-dispatch adapter (CTL-565, CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test dispatch.test.mjs
//
// CTL-582: defaultDispatch became self-contained — resolve the project, create
// the worktree, run phase-agent-dispatch. All three steps are injectable seams,
// so no test ever spawns a real script.

import { describe, test, expect } from "bun:test";
import { dispatchTicket, defaultDispatch, teamOf } from "./dispatch.mjs";

describe("teamOf", () => {
  test("extracts the team prefix from a ticket identifier", () => {
    expect(teamOf("CTL-123")).toBe("CTL");
    expect(teamOf("ADV-7")).toBe("ADV");
  });

  test("returns null for anything that is not <prefix>-<n>", () => {
    expect(teamOf("garbage")).toBeNull();
    expect(teamOf("")).toBeNull();
    expect(teamOf(null)).toBeNull();
    expect(teamOf("CTL-")).toBeNull();
  });
});

describe("defaultDispatch", () => {
  // baseSeams — a happy-path seam set that records the call sequence.
  const baseSeams = () => {
    const calls = [];
    return {
      calls,
      resolveProject: (ticket) => {
        calls.push(["resolve", ticket]);
        return { team: "CTL", repoRoot: "/repo" };
      },
      createWorktree: (args) => {
        calls.push(["create", args]);
        return { code: 0, worktreePath: `/wt/${args.ticket}`, stderr: "" };
      },
      runPhaseAgent: (args) => {
        calls.push(["run", args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };
  };

  test("resolves the project → creates the worktree → runs the phase agent, in order", () => {
    const s = baseSeams();
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-1", phase: "research" }, s);
    expect(s.calls.map((c) => c[0])).toEqual(["resolve", "create", "run"]);
    expect(s.calls[1][1]).toEqual({ ticket: "CTL-1", repoRoot: "/repo" });
    expect(s.calls[2][1]).toEqual({
      orchDir: "/ec",
      ticket: "CTL-1",
      phase: "research",
      worktreePath: "/wt/CTL-1",
    });
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "" });
  });

  test("no registry entry → code 1, createWorktree never called", () => {
    const s = baseSeams();
    s.resolveProject = (t) => {
      s.calls.push(["resolve", t]);
      return null;
    };
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-1", phase: "research" }, s);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no registry entry/);
    expect(s.calls.map((c) => c[0])).toEqual(["resolve"]);
  });

  test("createWorktree failure → returns its code, runPhaseAgent never called", () => {
    const s = baseSeams();
    s.createWorktree = (args) => {
      s.calls.push(["create", args]);
      return { code: 5, worktreePath: null, stderr: "wt boom" };
    };
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-9", phase: "research" }, s);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/CTL-9/);
    expect(s.calls.map((c) => c[0])).toEqual(["resolve", "create"]);
  });

  test("a code-0 worktree result with no worktreePath is still a failure", () => {
    const s = baseSeams();
    s.createWorktree = (args) => {
      s.calls.push(["create", args]);
      return { code: 0, worktreePath: null, stderr: "" };
    };
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-9", phase: "research" }, s);
    expect(r.code).not.toBe(0);
    expect(s.calls.map((c) => c[0])).toEqual(["resolve", "create"]);
  });

  test("the runPhaseAgent result is returned verbatim", () => {
    const s = baseSeams();
    s.runPhaseAgent = () => ({ code: 7, stdout: "", stderr: "phase boom" });
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-1", phase: "plan" }, s);
    expect(r).toEqual({ code: 7, stdout: "", stderr: "phase boom" });
  });
});

describe("dispatchTicket", () => {
  test("delegates to the injected dispatch function with orchDir/ticket/phase", () => {
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = dispatchTicket("/orch", "CTL-1", "triage", { dispatch });
    expect(calls).toEqual([{ orchDir: "/orch", ticket: "CTL-1", phase: "triage" }]);
    expect(r.code).toBe(0);
  });

  test("surfaces a non-zero dispatch code without throwing", () => {
    const dispatch = () => ({ code: 7, stdout: "", stderr: "boom" });
    expect(dispatchTicket("/orch", "CTL-1", "research", { dispatch }).code).toBe(7);
  });
});
