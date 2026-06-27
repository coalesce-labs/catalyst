// Unit tests for the execution-core worker-dispatch adapter (CTL-565, CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test dispatch.test.mjs
//
// CTL-582: defaultDispatch became self-contained — resolve the project, create
// the worktree, run phase-agent-dispatch. All three steps are injectable seams,
// so no test ever spawns a real script.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTicket, defaultDispatch, defaultRunPhaseAgent, dispatchForExecutor, sdkDispatch, makeCommentWakeDispatch, teamOf, settleDispatchSync, sdkSignalRunnable, isThenable, backstopOnRejection } from "./dispatch.mjs";

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
      s
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
      s
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
      s
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
      {
        orchDir: "/ec",
        ticket: "CTL-1",
        phase: "implement",
        worktreePath: "/wt/CTL-1",
        resumeSession: "9f8e-uuid",
      },
      { spawn }
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
      { spawn }
    );
    const { args } = spawn.calls[0];
    expect(args).not.toContain("--resume-session");
    expect(args).toEqual([
      "--phase",
      "implement",
      "--ticket",
      "CTL-1",
      "--orch-dir",
      "/ec",
      "--orch-id",
      "CTL-1",
    ]);
  });

  // CTL-990: an exec-looping phase-agent-dispatch (the recreate→rebase-refused
  // recursion) blocked the daemon's synchronous spawn forever — no rc, no
  // failure ladder. The spawn must carry a hard timeout + SIGKILL.
  test("passes a hard timeout + SIGKILL so a wedged dispatch cannot block the daemon (CTL-990)", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "research", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    const { opts } = spawn.calls[0];
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.killSignal).toBe("SIGKILL");
  });

  test("CATALYST_DISPATCH_TIMEOUT_MS overrides the spawn timeout (CTL-990)", () => {
    const spawn = spy();
    process.env.CATALYST_DISPATCH_TIMEOUT_MS = "12345";
    try {
      defaultRunPhaseAgent(
        { orchDir: "/ec", ticket: "CTL-1", phase: "research", worktreePath: "/wt/CTL-1" },
        { spawn }
      );
    } finally {
      delete process.env.CATALYST_DISPATCH_TIMEOUT_MS;
    }
    expect(spawn.calls[0].opts.timeout).toBe(12345);
  });

  // CTL-990: the recreate-once marker must be PER DISPATCH CHAIN (set only by
  // phase-agent-dispatch's own exec). An ambient value in the daemon's env
  // would pre-spend every fresh dispatch's recreate budget via ...process.env.
  test("strips an ambient CATALYST_RECREATE_ATTEMPTED from the spawned env (CTL-990)", () => {
    const spawn = spy();
    process.env.CATALYST_RECREATE_ATTEMPTED = "1";
    try {
      defaultRunPhaseAgent(
        { orchDir: "/ec", ticket: "CTL-1", phase: "research", worktreePath: "/wt/CTL-1" },
        { spawn }
      );
    } finally {
      delete process.env.CATALYST_RECREATE_ATTEMPTED;
    }
    expect("CATALYST_RECREATE_ATTEMPTED" in spawn.calls[0].opts.env).toBe(false);
  });
});

// CTL-1004 / CTL-1056 Bug 2: a failing dispatch must surface the captured
// stderr + the spawn error code / kill signal so the scheduler's "dispatch
// failed" log is diagnosable (today it logged a bare {ticket, code} with no
// stderr). defaultRunPhaseAgent must thread res.error?.code (e.g. ETIMEDOUT) and
// res.signal (e.g. SIGKILL from the CTL-990 timeout) into its result.
describe("defaultRunPhaseAgent — failure diagnostics (CTL-1004/CTL-1056 Bug 2)", () => {
  test("a spawn that exits non-zero returns its stderr verbatim", () => {
    const spawn = () => ({ status: 2, stdout: "", stderr: "phase-agent-dispatch: prior artifact missing\n" });
    const r = defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "research", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/prior artifact missing/);
  });

  test("a timeout (res.error ETIMEDOUT + res.signal SIGKILL) surfaces spawnError + signal", () => {
    const err = new Error("spawnSync phase-agent-dispatch ETIMEDOUT");
    err.code = "ETIMEDOUT";
    const spawn = () => ({ error: err, signal: "SIGKILL", stdout: "", stderr: "partial output before kill" });
    const r = defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    expect(r.code).toBe(127);
    expect(r.spawnError).toBe("ETIMEDOUT");
    expect(r.signal).toBe("SIGKILL");
    // stderr captured up to the kill must still be carried (not dropped for the error message).
    expect(r.stderr).toMatch(/ETIMEDOUT|partial output before kill/);
  });

  test("a clean exit carries res.signal=null and no spawnError (keys absent)", () => {
    const spawn = () => ({ status: 0, stdout: "ok", stderr: "", signal: null });
    const r = defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "research", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    expect(r.code).toBe(0);
    expect("spawnError" in r).toBe(false);
    expect(r.signal == null).toBe(true);
  });

  test("a SIGKILL'd spawn without res.error still surfaces the signal", () => {
    const spawn = () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "killed mid-run" });
    const r = defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "verify", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    expect(r.signal).toBe("SIGKILL");
    expect(r.stderr).toMatch(/killed mid-run/);
  });
});

// CTL-1365b Stage C: the executor → dispatch-function selection at the launch
// seam. bg/oneshot-legacy resolve to the unchanged defaultDispatch (the
// `claude --bg` path, BYTE-IDENTICAL to today); sdk resolves to sdkDispatch, which
// injects sdkRunPhaseAgent (the in-process Agent SDK worker).
describe("dispatchForExecutor (CTL-1365b)", () => {
  test("bg → the unchanged defaultDispatch (byte-identical to today)", () => {
    expect(dispatchForExecutor("bg")).toBe(defaultDispatch);
  });

  test("oneshot-legacy → the unchanged defaultDispatch", () => {
    expect(dispatchForExecutor("oneshot-legacy")).toBe(defaultDispatch);
  });

  test("sdk → sdkDispatch (identity-stable; the sdk launch verb is wired, not a bg fallback)", () => {
    expect(dispatchForExecutor("sdk")).toBe(sdkDispatch);
    // identity-stable: the SAME function object every call, so the daemon's
    // four-entry-point wiring is assertable by reference.
    expect(dispatchForExecutor("sdk")).toBe(dispatchForExecutor("sdk"));
  });

  test("the injected bg dispatch behaves IDENTICALLY to defaultDispatch — same arg array reaches runPhaseAgent", () => {
    // Prove the executor=bg path threads through to runPhaseAgent with the exact
    // arg array the existing dispatch tests assert, via the same injectable seams.
    const calls = [];
    const seams = {
      resolveProject: () => ({ team: "CTL", repoRoot: "/repo" }),
      createWorktree: (args) => ({ code: 0, worktreePath: `/wt/${args.ticket}`, stderr: "" }),
      runPhaseAgent: (args) => {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "", signal: null };
      },
    };
    const dispatch = dispatchForExecutor("bg"); // === defaultDispatch
    dispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", clusterGeneration: 7 },
      seams
    );
    expect(calls[0]).toEqual({
      orchDir: "/ec",
      ticket: "CTL-1",
      phase: "implement",
      worktreePath: "/wt/CTL-1",
      resumeSession: undefined,
      handoffPath: undefined,
      attempt: undefined,
      clusterGeneration: 7,
    });
  });
});

// CTL-1365b: sdkDispatch reuses defaultDispatch's resolve→worktree→run pipeline,
// swapping ONLY the launch verb (defaultRunPhaseAgent → sdkRunPhaseAgent). The
// runPhaseAgent seam stays injectable for the wiring assertion; the default is the
// real (async) sdkRunPhaseAgent.
describe("sdkDispatch (CTL-1365b)", () => {
  test("forwards through defaultDispatch with an injectable launch verb", () => {
    const calls = [];
    const spy = (args) => { calls.push(args); return { code: 0, stdout: "ok", stderr: "", signal: null }; };
    const r = sdkDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", clusterGeneration: 7 },
      {
        resolveProject: () => ({ team: "CTL", repoRoot: "/repo" }),
        createWorktree: (a) => ({ code: 0, worktreePath: `/wt/${a.ticket}`, stderr: "" }),
        runPhaseAgent: spy, // override the sdk verb for a hermetic wiring check
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orchDir: "/ec",
      ticket: "CTL-1",
      phase: "implement",
      worktreePath: "/wt/CTL-1",
      resumeSession: undefined,
      handoffPath: undefined,
      attempt: undefined,
      clusterGeneration: 7,
    });
    // sync launch verb → defaultDispatch's object branch → sync result + worktreePath.
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "", signal: null, worktreePath: "/wt/CTL-1" });
  });

  test("defaults the launch verb to the real (async) sdkRunPhaseAgent — proven via the auth guard + the thenable result", async () => {
    // No runPhaseAgent override → the real sdkRunPhaseAgent runs. With no
    // CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY it refuses at the auth guard
    // BEFORE any spawn/SDK call, so this is hermetic. sdkRunPhaseAgent is async, so
    // defaultDispatch's THENABLE branch composes worktreePath onto the awaited
    // result — the sync bg path never reaches that branch (byte-identical).
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedAuth = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const r = sdkDispatch(
        { orchDir: "/ec", ticket: "CTL-1", phase: "implement" },
        {
          resolveProject: () => ({ team: "CTL", repoRoot: "/repo" }),
          createWorktree: (a) => ({ code: 0, worktreePath: `/wt/${a.ticket}`, stderr: "" }),
        },
      );
      expect(typeof r.then).toBe("function"); // async sdk verb → defaultDispatch returns a Promise
      const awaited = await r;
      expect(awaited.code).toBe(1); // auth guard refused
      expect(awaited.stderr).toMatch(/OAUTH_TOKEN is missing|refusing to dispatch under executor=sdk/);
      expect(awaited.worktreePath).toBe("/wt/CTL-1"); // defaultDispatch wrapped worktreePath onto the awaited result
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedTok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTok;
      if (savedAuth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuth;
    }
  });
});

// CTL-1365b: makeCommentWakeDispatch binds the resolved executor dispatch into the
// positional (orchDir,ticket,phase,opts) shape handleCommentWake invokes — the
// comment-wake entry point honors the SAME executor (no split-brain).
describe("makeCommentWakeDispatch (CTL-1365b)", () => {
  test("threads the executor dispatch into dispatchTicket with orchDir/ticket/phase + opts", () => {
    const calls = [];
    const fakeDispatch = (args) => { calls.push(args); return { code: 0 }; };
    const cw = makeCommentWakeDispatch(fakeDispatch);
    const r = cw("/orch", "CTL-1", "implement", { handoffPath: "/h.md", resumeSession: "u1" });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    // dispatchTicket forwarded our executor dispatch (NOT its defaultDispatch default).
    expect(calls[0]).toEqual({
      orchDir: "/orch",
      ticket: "CTL-1",
      phase: "implement",
      handoffPath: "/h.md",
      resumeSession: "u1",
    });
  });

  test("bg binding (defaultDispatch) is byte-identical to the prior dispatch:dispatchTicket wiring", () => {
    // For executor=bg, dispatch === defaultDispatch, which is also dispatchTicket's
    // OWN default — so makeCommentWakeDispatch(defaultDispatch) routes exactly as the
    // pre-CTL-1365 `dispatch: dispatchTicket` wiring did.
    const cw = makeCommentWakeDispatch(defaultDispatch);
    expect(typeof cw).toBe("function");
    // No resumeSession/handoffPath → dispatchTicket omits both keys (back-compat).
    const calls = [];
    const cw2 = makeCommentWakeDispatch((args) => { calls.push(args); return { code: 0 }; });
    cw2("/orch", "CTL-2", "triage", {});
    expect(calls[0]).toEqual({ orchDir: "/orch", ticket: "CTL-2", phase: "triage" });
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

  // CTL-705 Phase 3: resumeSession thread-through
  test("backward compat: no resumeSession → dispatch receives exactly {orchDir, ticket, phase}", () => {
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "triage", { dispatch });
    expect(calls[0]).toEqual({ orchDir: "/orch", ticket: "CTL-1", phase: "triage" });
    expect("resumeSession" in calls[0]).toBe(false);
  });

  test("forwards resumeSession to dispatch when provided", () => {
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "implement", { dispatch, resumeSession: "uuid-123" });
    expect(calls[0].resumeSession).toBe("uuid-123");
  });

  // CTL-549: handoffPath thread-through
  test("backward compat: no handoffPath → dispatch receives no handoffPath key", () => {
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "triage", { dispatch });
    expect("handoffPath" in calls[0]).toBe(false);
  });

  test("forwards handoffPath to dispatch when provided", () => {
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "implement", { dispatch, handoffPath: "/path/to/handoff.md" });
    expect(calls[0].handoffPath).toBe("/path/to/handoff.md");
  });
});

// CTL-549: handoffPath → CATALYST_HANDOFF_PATH env var in spawned process
describe("defaultRunPhaseAgent — handoffPath env injection (CTL-549)", () => {
  const spy = () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: "ok", stderr: "" };
    };
    spawn.calls = calls;
    return spawn;
  };

  test("sets CATALYST_HANDOFF_PATH when handoffPath provided", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      {
        orchDir: "/ec",
        ticket: "CTL-1",
        phase: "implement",
        worktreePath: "/wt/CTL-1",
        handoffPath: "/path/to/handoff.md",
      },
      { spawn }
    );
    expect(spawn.calls[0].opts.env.CATALYST_HANDOFF_PATH).toBe("/path/to/handoff.md");
  });

  test("does NOT set CATALYST_HANDOFF_PATH when handoffPath absent", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    expect(spawn.calls[0].opts.env.CATALYST_HANDOFF_PATH).toBeUndefined();
  });
});

// CTL-549: defaultDispatch forwards handoffPath to runPhaseAgent
describe("defaultDispatch — handoffPath passthrough (CTL-549)", () => {
  const seams = (handoffPath) => {
    const calls = [];
    return {
      resolveProject: () => ({ repoRoot: "/repo" }),
      createWorktree: () => ({ code: 0, worktreePath: "/wt/CTL-1" }),
      runPhaseAgent: (args) => {
        calls.push(args);
        return { code: 0 };
      },
      calls,
      handoffPath,
    };
  };

  test("forwards handoffPath to runPhaseAgent when set", () => {
    const s = seams("/path/to/handoff.md");
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", handoffPath: "/path/to/handoff.md" },
      {
        resolveProject: s.resolveProject,
        createWorktree: s.createWorktree,
        runPhaseAgent: s.runPhaseAgent,
      }
    );
    expect(s.calls[0].handoffPath).toBe("/path/to/handoff.md");
  });

  test("handoffPath is undefined on a cold dispatch (no handoffPath)", () => {
    const s = seams(undefined);
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement" },
      {
        resolveProject: s.resolveProject,
        createWorktree: s.createWorktree,
        runPhaseAgent: s.runPhaseAgent,
      }
    );
    expect(s.calls[0].handoffPath).toBeUndefined();
  });
});

// CTL-761: attempt thread-through (dispatch ordinal for revive observability)
describe("defaultRunPhaseAgent — attempt arg (CTL-761)", () => {
  const spy = () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: "ok", stderr: "" };
    };
    spawn.calls = calls;
    return spawn;
  };

  test("forwards --attempt to phase-agent-dispatch when provided", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      {
        orchDir: "/ec",
        ticket: "CTL-1",
        phase: "implement",
        worktreePath: "/wt/CTL-1",
        attempt: 2,
      },
      { spawn }
    );
    const { args } = spawn.calls[0];
    expect(args).toContain("--attempt");
    expect(args[args.indexOf("--attempt") + 1]).toBe("2");
  });

  test("backward compat: no attempt → no --attempt flag (exact arg array)", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement", worktreePath: "/wt/CTL-1" },
      { spawn }
    );
    const { args } = spawn.calls[0];
    expect(args).not.toContain("--attempt");
    expect(args).toEqual([
      "--phase",
      "implement",
      "--ticket",
      "CTL-1",
      "--orch-dir",
      "/ec",
      "--orch-id",
      "CTL-1",
    ]);
  });
});

describe("defaultDispatch — attempt passthrough (CTL-761)", () => {
  const seams = () => {
    const calls = [];
    return {
      resolveProject: () => ({ repoRoot: "/repo" }),
      createWorktree: () => ({ code: 0, worktreePath: "/wt/CTL-1" }),
      runPhaseAgent: (args) => {
        calls.push(args);
        return { code: 0 };
      },
      calls,
    };
  };

  test("forwards attempt to runPhaseAgent when provided", () => {
    const s = seams();
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "plan", attempt: 3 },
      {
        resolveProject: s.resolveProject,
        createWorktree: s.createWorktree,
        runPhaseAgent: s.runPhaseAgent,
      }
    );
    expect(s.calls[0].attempt).toBe(3);
  });

  test("attempt is undefined on a cold dispatch (no attempt)", () => {
    const s = seams();
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "implement" },
      {
        resolveProject: s.resolveProject,
        createWorktree: s.createWorktree,
        runPhaseAgent: s.runPhaseAgent,
      }
    );
    expect(s.calls[0].attempt).toBeUndefined();
  });
});

describe("dispatchTicket — attempt thread-through (CTL-761)", () => {
  test("backward compat: no attempt → dispatch receives no attempt key", () => {
    const calls = [];
    const dispatch = (a) => {
      calls.push(a);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "triage", { dispatch });
    expect("attempt" in calls[0]).toBe(false);
  });

  test("forwards attempt to dispatch when provided", () => {
    const calls = [];
    const dispatch = (a) => {
      calls.push(a);
      return { code: 0 };
    };
    dispatchTicket("/orch", "CTL-1", "implement", { dispatch, attempt: 2 });
    expect(calls[0].attempt).toBe(2);
  });
});

// CTL-864: clusterGeneration → CATALYST_CLUSTER_GENERATION env var in spawned process
describe("defaultRunPhaseAgent — clusterGeneration env injection (CTL-864)", () => {
  const spy = () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: "ok", stderr: "" };
    };
    spawn.calls = calls;
    return spawn;
  };

  test("sets CATALYST_CLUSTER_GENERATION when clusterGeneration provided", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "pr", worktreePath: "/wt/CTL-1", clusterGeneration: 7 },
      { spawn },
    );
    expect(spawn.calls[0].opts.env.CATALYST_CLUSTER_GENERATION).toBe("7");
  });

  test("does NOT set CATALYST_CLUSTER_GENERATION when clusterGeneration absent", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "pr", worktreePath: "/wt/CTL-1" },
      { spawn },
    );
    expect("CATALYST_CLUSTER_GENERATION" in spawn.calls[0].opts.env).toBe(false);
  });

  test("does NOT set CATALYST_CLUSTER_GENERATION when clusterGeneration is null", () => {
    const spawn = spy();
    defaultRunPhaseAgent(
      { orchDir: "/ec", ticket: "CTL-1", phase: "pr", worktreePath: "/wt/CTL-1", clusterGeneration: null },
      { spawn },
    );
    expect("CATALYST_CLUSTER_GENERATION" in spawn.calls[0].opts.env).toBe(false);
  });
});

// CTL-864: dispatchTicket forwards clusterGeneration
describe("dispatchTicket — clusterGeneration thread-through (CTL-864)", () => {
  test("backward compat: no clusterGeneration → dispatch receives no clusterGeneration key", () => {
    const calls = [];
    const dispatch = (args) => { calls.push(args); return { code: 0 }; };
    dispatchTicket("/orch", "CTL-1", "pr", { dispatch });
    expect("clusterGeneration" in calls[0]).toBe(false);
  });

  test("forwards clusterGeneration to dispatch when provided", () => {
    const calls = [];
    const dispatch = (args) => { calls.push(args); return { code: 0 }; };
    dispatchTicket("/orch", "CTL-1", "pr", { dispatch, clusterGeneration: 7 });
    expect(calls[0].clusterGeneration).toBe(7);
  });
});

// CTL-864: defaultDispatch forwards clusterGeneration to runPhaseAgent
describe("defaultDispatch — clusterGeneration passthrough (CTL-864)", () => {
  const seams = () => {
    const calls = [];
    return {
      resolveProject: () => ({ repoRoot: "/repo" }),
      createWorktree: () => ({ code: 0, worktreePath: "/wt/CTL-1" }),
      runPhaseAgent: (args) => { calls.push(args); return { code: 0 }; },
      calls,
    };
  };

  test("forwards clusterGeneration to runPhaseAgent when set", () => {
    const s = seams();
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "pr", clusterGeneration: 7 },
      { resolveProject: s.resolveProject, createWorktree: s.createWorktree, runPhaseAgent: s.runPhaseAgent },
    );
    expect(s.calls[0].clusterGeneration).toBe(7);
  });

  test("clusterGeneration is undefined on a cold dispatch (no clusterGeneration)", () => {
    const s = seams();
    defaultDispatch(
      { orchDir: "/ec", ticket: "CTL-1", phase: "pr" },
      { resolveProject: s.resolveProject, createWorktree: s.createWorktree, runPhaseAgent: s.runPhaseAgent },
    );
    expect(s.calls[0].clusterGeneration).toBeUndefined();
  });
});

// ── CTL-1367 P1: settleDispatchSync + sdkSignalRunnable + isThenable ──────────

describe("isThenable (CTL-1367 P1)", () => {
  test("true for promises, false for plain dispatch results", () => {
    expect(isThenable(Promise.resolve({ code: 0 }))).toBe(true);
    expect(isThenable({ then: () => {} })).toBe(true);
    expect(isThenable({ code: 0 })).toBe(false);
    expect(isThenable(null)).toBe(false);
    expect(isThenable(undefined)).toBe(false);
  });
});

describe("sdkSignalRunnable (CTL-1367 E3)", () => {
  let dir;
  const seed = (status, extra = {}) => {
    dir = mkdtempSync(join(tmpdir(), "sdk-sig-"));
    const wd = join(dir, "workers", "CTL-1");
    mkdirSync(wd, { recursive: true });
    writeFileSync(join(wd, "phase-implement.json"), JSON.stringify({ status, ...extra }));
    return dir;
  };
  test("accepts dispatched/running/done WITHOUT a bg_job_id (the SDK prelaunch has none)", () => {
    for (const st of ["dispatched", "running", "done"]) {
      const od = seed(st); // note: no bg_job_id
      expect(sdkSignalRunnable(od, "CTL-1", "implement")).toBe(true);
      rmSync(od, { recursive: true, force: true });
    }
  });
  test("rejects a failed/stalled or missing signal", () => {
    const od = seed("stalled");
    expect(sdkSignalRunnable(od, "CTL-1", "implement")).toBe(false);
    rmSync(od, { recursive: true, force: true });
    expect(sdkSignalRunnable("/nope", "CTL-1", "implement")).toBe(false);
  });
});

describe("settleDispatchSync (CTL-1367 P1)", () => {
  test("a SYNC result is returned UNCHANGED (bg path byte-identical)", () => {
    const r = { code: 0, stdout: "x", worktreePath: "/wt" };
    expect(settleDispatchSync(r)).toBe(r); // same object reference — no wrapping
  });
  test("a Promise → synchronous { code:0, async:true } when verifySync passes; query detached", async () => {
    let settled = false;
    const p = Promise.resolve({ code: 0 });
    const r = settleDispatchSync(p, { verifySync: () => true, onSettled: () => { settled = true; } });
    expect(r).toEqual({ code: 0, async: true }); // resolved SYNCHRONOUSLY
    await p; await Promise.resolve(); // let the detached handler run
    expect(settled).toBe(true);
  });
  test("a Promise → { code:1 } when verifySync fails (prelaunch never wrote a runnable signal)", () => {
    const r = settleDispatchSync(Promise.resolve({ code: 1 }), { verifySync: () => false });
    expect(r).toEqual({ code: 1, async: true });
  });
  test("a rejecting Promise never escapes as an unhandled rejection", async () => {
    let err = null;
    const r = settleDispatchSync(Promise.reject(new Error("boom")), {
      verifySync: () => true,
      onSettled: (_res, e) => { err = e; },
    });
    expect(r.code).toBe(0); // launch already happened (signal verified)
    await Promise.resolve(); await Promise.resolve();
    expect(err?.message).toBe("boom"); // captured by the detached handler, not thrown
  });
});

// ── CTL-1367 P1: backstopOnRejection — the swallowed-rejection backstop ───────
//
// The three async-dispatch entry points (scheduler, monitor triage, recovery revive)
// thread this onSettled handler into settleDispatchSync. A REJECTED async dispatch
// (e.g. buildSdkEnv/buildQueryOptions throwing AFTER the synchronous prelaunch wrote
// a runnable "dispatched" signal) must NOT be silently swallowed: the handler logs
// the rejection and emits the failed-terminal backstop so the ticket can't strand at
// "dispatched" with no bg_job_id/liveness probe.
describe("backstopOnRejection (CTL-1367 P1)", () => {
  const fakeLog = () => {
    const warns = [];
    return { warns, warn: (...a) => warns.push(a) };
  };

  test("on a REJECTION → logs + emits the failed backstop with the composed signalFile", () => {
    const calls = [];
    const logger = fakeLog();
    const handler = backstopOnRejection(
      { orchDir: "/ec", ticket: "CTL-7", phase: "implement", log: logger },
      { emitBackstop: (a) => calls.push(a) },
    );
    handler(null, new Error("buildSdkEnv exploded"));
    expect(logger.warns).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      phase: "implement",
      ticket: "CTL-7",
      status: "failed",
      orchDir: "/ec",
      signalFile: "/ec/workers/CTL-7/phase-implement.json",
    });
    expect(calls[0].reason).toMatch(/buildSdkEnv exploded/);
  });

  test("on a clean RESOLUTION → NO log, NO backstop (the worker/skill owns its terminal event)", () => {
    const calls = [];
    const logger = fakeLog();
    const handler = backstopOnRejection(
      { orchDir: "/ec", ticket: "CTL-8", phase: "triage", log: logger },
      { emitBackstop: (a) => calls.push(a) },
    );
    handler({ code: 0 }, null);
    expect(calls).toHaveLength(0);
    expect(logger.warns).toHaveLength(0);
  });

  test("a throwing emitBackstop never escapes (best-effort)", () => {
    const logger = fakeLog();
    const handler = backstopOnRejection(
      { orchDir: "/ec", ticket: "CTL-9", phase: "verify", log: logger },
      { emitBackstop: () => { throw new Error("emit boom"); } },
    );
    expect(() => handler(null, new Error("rejected"))).not.toThrow();
  });

  test("wired through settleDispatchSync: a rejecting Promise drives the backstop", async () => {
    const calls = [];
    const logger = fakeLog();
    const r = settleDispatchSync(Promise.reject(new Error("non-array spec.env")), {
      verifySync: () => true, // prelaunch signal was runnable → launch already happened
      onSettled: backstopOnRejection(
        { orchDir: "/ec", ticket: "CTL-10", phase: "implement", log: logger },
        { emitBackstop: (a) => calls.push(a) },
      ),
    });
    expect(r).toEqual({ code: 0, async: true }); // provisional success off the prelaunch signal
    await Promise.resolve(); await Promise.resolve(); // let the detached handler run
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ticket: "CTL-10", phase: "implement", status: "failed" });
    expect(calls[0].reason).toMatch(/non-array spec.env/);
  });
});

// ── CTL-1367 P1 end-to-end: sdkDispatch result settles via the prelaunch signal ─

describe("sdkDispatch + settleDispatchSync end-to-end (CTL-1367 P1)", () => {
  test("an async sdk dispatch is settled synchronously off the signal it wrote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-e2e-"));
    const wd = join(dir, "workers", "CTL-5");
    mkdirSync(wd, { recursive: true });
    const signalFile = join(wd, "phase-implement.json");
    // Fake runPhaseAgent that mimics sdkRunPhaseAgent: writes the dispatched signal
    // SYNCHRONOUSLY (the prelaunch), then returns a Promise (the detached query).
    const runPhaseAgent = () => {
      writeFileSync(signalFile, JSON.stringify({ status: "dispatched", bg_job_id: null }));
      return Promise.resolve({ code: 0, stdout: "", stderr: "", signal: null });
    };
    const dispatch = (args) =>
      defaultDispatch(args, {
        resolveProject: () => ({ team: "CTL", repoRoot: "/repo" }),
        createWorktree: () => ({ code: 0, worktreePath: wd }),
        runPhaseAgent,
      });
    const raw = dispatch({ orchDir: dir, ticket: "CTL-5", phase: "implement" });
    expect(isThenable(raw)).toBe(true); // the dispatch is async (sdk shape)
    const settled = settleDispatchSync(raw, { verifySync: () => sdkSignalRunnable(dir, "CTL-5", "implement") });
    expect(settled.code).toBe(0); // verified off the synchronously-written signal
    expect(settled.async).toBe(true);
    await raw; // detached query resolves cleanly
    rmSync(dir, { recursive: true, force: true });
  });
});
