// Unit tests for the execution-core worker-dispatch adapter (CTL-565, CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test dispatch.test.mjs
//
// CTL-582: defaultDispatch became self-contained — resolve the project, create
// the worktree, run phase-agent-dispatch. All three steps are injectable seams,
// so no test ever spawns a real script.

import { describe, test, expect } from "bun:test";
import { dispatchTicket, defaultDispatch, defaultRunPhaseAgent, teamOf } from "./dispatch.mjs";

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
    // CTL-615: createWorktree now receives expectedBranch === ticket.
    expect(s.calls[1][1]).toEqual({
      ticket: "CTL-1",
      repoRoot: "/repo",
      expectedBranch: "CTL-1",
    });
    expect(s.calls[2][1]).toEqual({
      orchDir: "/ec",
      ticket: "CTL-1",
      phase: "research",
      worktreePath: "/wt/CTL-1",
    });
    // CTL-615: dispatch result now also surfaces worktreePath.
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "", worktreePath: "/wt/CTL-1" });
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
    expect(r.code).toBe(1); // wt.code || 1 — the 0 falls through to the fallback
    expect(s.calls.map((c) => c[0])).toEqual(["resolve", "create"]);
  });

  test("the runPhaseAgent result is returned verbatim (plus worktreePath — CTL-615)", () => {
    const s = baseSeams();
    s.runPhaseAgent = () => ({ code: 7, stdout: "", stderr: "phase boom" });
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-1", phase: "plan" }, s);
    expect(r).toEqual({ code: 7, stdout: "", stderr: "phase boom", worktreePath: "/wt/CTL-1" });
  });
});

describe("defaultDispatch — worktreePath / expectedBranch wiring (CTL-615)", () => {
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

  test("passes expectedBranch: ticket through to createWorktree", () => {
    const s = baseSeams();
    defaultDispatch({ orchDir: "/ec", ticket: "CTL-7", phase: "implement" }, s);
    const createCall = s.calls.find((c) => c[0] === "create");
    expect(createCall[1].expectedBranch).toBe("CTL-7");
  });

  test("the dispatch result carries the resolved worktreePath", () => {
    const s = baseSeams();
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-8", phase: "implement" }, s);
    expect(r.worktreePath).toBe("/wt/CTL-8");
  });

  test("expectedWorktreePath match → dispatch proceeds, runs phase agent", () => {
    const s = baseSeams();
    const r = defaultDispatch(
      {
        orchDir: "/ec",
        ticket: "CTL-9",
        phase: "implement",
        expectedWorktreePath: "/wt/CTL-9",
      },
      s,
    );
    expect(r.code).toBe(0);
    expect(s.calls.some((c) => c[0] === "run")).toBe(true);
  });

  test("expectedWorktreePath mismatch → code:1, runPhaseAgent never called, reason='revive-aborted-wrong-cwd'", () => {
    const s = baseSeams();
    s.createWorktree = (args) => {
      s.calls.push(["create", args]);
      return { code: 0, worktreePath: "/wt/ADV-1129", stderr: "" };
    };
    const r = defaultDispatch(
      {
        orchDir: "/ec",
        ticket: "CTL-9",
        phase: "implement",
        expectedWorktreePath: "/wt/CTL-9",
      },
      s,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/revive-aborted-wrong-cwd/);
    expect(r.worktreePath).toBe("/wt/ADV-1129");
    expect(s.calls.map((c) => c[0])).toEqual(["resolve", "create"]);
  });

  test("expectedWorktreePath unset (initial dispatch) → no comparison, proceeds normally", () => {
    const s = baseSeams();
    s.createWorktree = (args) => {
      s.calls.push(["create", args]);
      return { code: 0, worktreePath: "/wt/whatever", stderr: "" };
    };
    const r = defaultDispatch({ orchDir: "/ec", ticket: "CTL-9", phase: "research" }, s);
    expect(r.code).toBe(0);
    expect(s.calls.some((c) => c[0] === "run")).toBe(true);
  });
});

// CTL-658: resumeSession threads from the daemon revive seam down to the
// phase-agent-dispatch spawn args, so the dispatched worker runs
// `claude --bg --resume <uuid>` instead of a fresh phase-0 start.
describe("defaultDispatch — resumeSession passthrough (CTL-658)", () => {
  const baseSeams = () => {
    const calls = [];
    return {
      calls,
      resolveProject: () => ({ team: "CTL", repoRoot: "/repo" }),
      createWorktree: (args) => ({ code: 0, worktreePath: `/wt/${args.ticket}`, stderr: "" }),
      runPhaseAgent: (args) => {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };
  };

  test("forwards resumeSession to runPhaseAgent when set", () => {
    const s = baseSeams();
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", resumeSession: "9f8e-uuid" },
      s,
    );
    expect(s.calls[0].resumeSession).toBe("9f8e-uuid");
  });

  test("forwards resumeSession: undefined on a cold dispatch (no resume)", () => {
    const s = baseSeams();
    defaultDispatch({ orchDir: "/ec", ticket: "CTL-1", phase: "implement" }, s);
    expect(s.calls[0].resumeSession).toBeUndefined();
  });
});

describe("defaultRunPhaseAgent — spawn-arg construction (CTL-658)", () => {
  // Inject a spawnSync spy so we assert the built arg array without a real spawn.
  const spy = () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: "ok", stderr: "" };
    };
    spawn.calls = calls;
    return spawn;
  };

  test("appends --resume-session <uuid> when resumeSession is set", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", worktreePath: "/wt/CTL-1", resumeSession: "9f8e-uuid" },
      { spawn },
    );
    const { args } = spawn.calls[0];
    expect(args).toContain("--resume-session");
    // The flag's value immediately follows the token.
    expect(args[args.indexOf("--resume-session") + 1]).toBe("9f8e-uuid");
  });

  test("omits both tokens when resumeSession is null/undefined", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", worktreePath: "/wt/CTL-1" },
      { spawn },
    );
    const { args } = spawn.calls[0];
    expect(args).not.toContain("--resume-session");
    expect(args).toEqual(["--phase", "implement", "--ticket", "CTL-1", "--orch-dir", "/ec", "--orch-id", "CTL-1"]);
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
