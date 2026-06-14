// stall-janitor.test.mjs — CTL-1004 unit tests.
//
// The stall-janitor collapses already-terminal, unambiguous leftovers:
//   J1 — orphaned worktrees (teardown=done + .terminal-done.applied, worktree on
//        disk, no live session, clean tree, CTL-791 evidence) → TARGETED
//        orphans.reap-requested. The janitor REMOVES NOTHING; the reaper owns it.
//   J2 — ghost sessions (terminal signal >=600s + an idle background session for
//        the same subject) → a kill-INTENT via intent.mjs. NEVER `claude stop`.
//
// Two pure classifiers (no IO, all evidence injected) + one action driver
// (runStallJanitorPass) whose every side-effect seam is injected. Mirrors the
// CTL-729 watchdog split (hung-detector.mjs decision + watchdog-action.mjs effects).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOrphanWorktree,
  classifyGhostSession,
  classifyStallClear,
  runStallJanitorPass,
  defaultCollectOrphanCandidates,
  defaultCollectGhostCandidates,
  defaultCollectStallClearCandidates,
  defaultTicketFromCwd,
} from "./stall-janitor.mjs";

// ---------------------------------------------------------------------------
// J1 classifier — classifyOrphanWorktree
// ---------------------------------------------------------------------------
describe("classifyOrphanWorktree (CTL-1004 J1)", () => {
  const base = {
    ticket: "CTL-100",
    teardownDone: true,
    terminalDoneApplied: true,
    worktreePath: "/wt/CTL-100",
    worktreeOnDisk: true,
    liveSessionInWorktree: false,
    treeClean: true,
    evidenceOk: true,
    alreadyReaped: false,
    inFlight: false,
  };

  test("terminal + on-disk + no-session + clean + evidence → reap-orphan", () => {
    expect(classifyOrphanWorktree(base).action).toBe("reap-orphan");
  });

  test("worktree NOT on disk → skip (nothing to reap)", () => {
    expect(classifyOrphanWorktree({ ...base, worktreeOnDisk: false }).action).toBe("skip");
  });

  test("already reaped (.terminal-reap-teardown present) → skip", () => {
    const d = classifyOrphanWorktree({ ...base, alreadyReaped: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/already-reaped/);
  });

  test("not teardown=done → skip (not terminal)", () => {
    expect(classifyOrphanWorktree({ ...base, teardownDone: false }).action).toBe("skip");
  });

  test("missing .terminal-done.applied → skip (no positive done evidence)", () => {
    expect(classifyOrphanWorktree({ ...base, terminalDoneApplied: false }).action).toBe("skip");
  });

  test("live session with cwd inside worktree → skip (never touch live)", () => {
    const d = classifyOrphanWorktree({ ...base, liveSessionInWorktree: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/live-session/);
  });

  test("ticket still in-flight (running signal) → skip (never touch live)", () => {
    const d = classifyOrphanWorktree({ ...base, inFlight: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/in-flight/);
  });

  test("dirty tree → defer (reason=dirty), NOT reap", () => {
    const d = classifyOrphanWorktree({ ...base, treeClean: false });
    expect(d.action).toBe("defer");
    expect(d.reason).toBe("dirty");
  });

  test("CTL-791 evidence gate fails → skip (never force)", () => {
    const d = classifyOrphanWorktree({ ...base, evidenceOk: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/evidence/);
  });
});

// ---------------------------------------------------------------------------
// J2 classifier — classifyGhostSession
// ---------------------------------------------------------------------------
describe("classifyGhostSession (CTL-1004 J2)", () => {
  const base = {
    ticket: "CTL-200",
    phase: "monitor-deploy",
    bgJobId: "ghost123",
    terminalForMs: 700_000, // >= 600s
    sessionKind: "background",
    sessionStatus: "idle",
    terminalIdleMs: 600_000,
  };

  test("terminal >=600s + idle background session → kill-intent", () => {
    expect(classifyGhostSession(base).action).toBe("kill-intent");
  });

  test("terminal present <600s → skip (not yet a ghost)", () => {
    expect(classifyGhostSession({ ...base, terminalForMs: 300_000 }).action).toBe("skip");
  });

  test("interactive session → skip (never touch human sessions)", () => {
    const d = classifyGhostSession({ ...base, sessionKind: "interactive" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/interactive/);
  });

  test("unknown/null kind → skip (ambiguous, never auto-kill)", () => {
    expect(classifyGhostSession({ ...base, sessionKind: null }).action).toBe("skip");
  });

  test("busy (non-idle) background session → skip (not idle = could be live)", () => {
    const d = classifyGhostSession({ ...base, sessionStatus: "busy" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/not-idle/);
  });

  test("no bgJobId to pin → skip", () => {
    expect(classifyGhostSession({ ...base, bgJobId: null }).action).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// runStallJanitorPass — the action driver (all seams injected)
// ---------------------------------------------------------------------------

// One terminal-Done ticket with an on-disk, clean, session-free worktree, plus
// one idle background ghost session whose terminal signal is old.
function makeWorld(overrides = {}) {
  return {
    // J1 census: one orphan candidate.
    orphanCandidates: [
      {
        ticket: "CTL-100",
        teardownDone: true,
        terminalDoneApplied: true,
        worktreePath: "/wt/CTL-100",
        worktreeOnDisk: true,
        liveSessionInWorktree: false,
        treeClean: true,
        evidenceOk: true,
        alreadyReaped: false,
        inFlight: false,
        bgJobId: "wt100job",
        branch: "CTL-100",
      },
    ],
    // J2 census: one ghost session.
    ghostCandidates: [
      {
        ticket: "CTL-200",
        phase: "monitor-deploy",
        bgJobId: "ghost123",
        terminalForMs: 700_000,
        sessionKind: "background",
        sessionStatus: "idle",
      },
    ],
    ...overrides,
  };
}

function makeOpts(world, { mode, events = [], intents = [] } = {}) {
  return {
    mode,
    terminalIdleMs: 600_000,
    collectOrphanCandidates: () => world.orphanCandidates,
    collectGhostCandidates: () => world.ghostCandidates,
    emit: (type, fields) => {
      events.push({ type, ...fields });
      return Promise.resolve(true);
    },
    recordKillIntent: (intent) => {
      intents.push(intent);
      return true;
    },
  };
}

describe("runStallJanitorPass — enforce mode (CTL-1004)", () => {
  test("J1: emits a TARGETED orphans.reap-requested naming the worktree (NOT a blanket sweep)", async () => {
    const events = [];
    const world = makeWorld();
    const res = await runStallJanitorPass(makeOpts(world, { mode: "enforce", events }));
    const reap = events.find((e) => e.type === "orphans.reap-requested");
    expect(reap).toBeDefined();
    // Targeted: names the specific ticket + worktree_path + bg_job_id (not {}).
    expect(reap.ticket).toBe("CTL-100");
    expect(reap.worktreePath ?? reap.worktree_path).toBe("/wt/CTL-100");
    expect(reap.bgJobId ?? reap.bg_job_id).toBe("wt100job");
    expect(res.reaped).toEqual([{ ticket: "CTL-100", worktreePath: "/wt/CTL-100" }]);
  });

  test("J1: the janitor itself removes nothing (no remove seam invoked)", async () => {
    const world = makeWorld();
    let removed = false;
    const opts = makeOpts(world, { mode: "enforce" });
    opts.removeWorktree = () => {
      removed = true;
      return true;
    };
    await runStallJanitorPass(opts);
    expect(removed).toBe(false);
  });

  test("J2: records a kill-intent pinned to the bgJobId via intent seam (no claude stop)", async () => {
    const intents = [];
    const world = makeWorld();
    const res = await runStallJanitorPass(makeOpts(world, { mode: "enforce", intents }));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      subject: "CTL-200/monitor-deploy",
      bgJobId: "ghost123",
    });
    expect(res.killIntents).toEqual([
      { ticket: "CTL-200", phase: "monitor-deploy", bgJobId: "ghost123" },
    ]);
  });

  test("J1: dirty worktree → janitor.worktree.deferred{reason:dirty}, no reap, no remove", async () => {
    const events = [];
    const world = makeWorld({
      orphanCandidates: [
        { ...makeWorld().orphanCandidates[0], treeClean: false },
      ],
    });
    const res = await runStallJanitorPass(makeOpts(world, { mode: "enforce", events }));
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
    const deferred = events.find((e) => e.type === "janitor.worktree.deferred");
    expect(deferred).toBeDefined();
    expect(deferred.reason).toBe("dirty");
    expect(res.reaped).toEqual([]);
    expect(res.deferred).toEqual([{ ticket: "CTL-100", reason: "dirty" }]);
  });

  test("J1: already-reaped worktree absent on disk → NOT re-queued", async () => {
    const events = [];
    const world = makeWorld({
      orphanCandidates: [
        {
          ...makeWorld().orphanCandidates[0],
          alreadyReaped: true,
          worktreeOnDisk: false,
        },
      ],
    });
    await runStallJanitorPass(makeOpts(world, { mode: "enforce", events }));
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
  });

  test("never targets a live worker — in-flight ticket is skipped", async () => {
    const events = [];
    const intents = [];
    const world = makeWorld({
      orphanCandidates: [{ ...makeWorld().orphanCandidates[0], inFlight: true }],
      ghostCandidates: [
        { ...makeWorld().ghostCandidates[0], sessionStatus: "busy" },
      ],
    });
    const res = await runStallJanitorPass(makeOpts(world, { mode: "enforce", events, intents }));
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
    expect(intents).toHaveLength(0);
    expect(res.reaped).toEqual([]);
    expect(res.killIntents).toEqual([]);
  });
});

describe("runStallJanitorPass — shadow mode (CTL-1004)", () => {
  test("emits ONLY janitor.would.* events; no real reap, no intents", async () => {
    const events = [];
    const intents = [];
    const world = makeWorld();
    const res = await runStallJanitorPass(makeOpts(world, { mode: "shadow", events, intents }));
    // No real mutating events.
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
    expect(intents).toHaveLength(0);
    // Shadow events present and named.
    const wReap = events.find((e) => e.type === "janitor.would.reap-request");
    const wKill = events.find((e) => e.type === "janitor.would.kill-intent");
    expect(wReap).toBeDefined();
    expect(wReap.ticket).toBe("CTL-100");
    expect(wReap.worktreePath ?? wReap.worktree_path).toBe("/wt/CTL-100");
    expect(wKill).toBeDefined();
    expect(wKill.bgJobId ?? wKill.bg_job_id).toBe("ghost123");
    // Result reports WOULD arrays, not real ones.
    expect(res.reaped).toEqual([]);
    expect(res.killIntents).toEqual([]);
    expect(res.wouldReap).toEqual([{ ticket: "CTL-100", worktreePath: "/wt/CTL-100" }]);
    expect(res.wouldKill).toEqual([
      { ticket: "CTL-200", phase: "monitor-deploy", bgJobId: "ghost123" },
    ]);
  });

  test("shadow defers a dirty worktree as janitor.would.* too — never mutates", async () => {
    const events = [];
    const world = makeWorld({
      orphanCandidates: [{ ...makeWorld().orphanCandidates[0], treeClean: false }],
    });
    await runStallJanitorPass(makeOpts(world, { mode: "shadow", events }));
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
    expect(events.filter((e) => e.type === "janitor.worktree.deferred")).toHaveLength(0);
    // The dirty defer surfaces only as a would-event in shadow.
    expect(events.some((e) => e.type === "janitor.would.defer")).toBe(true);
  });
});

describe("runStallJanitorPass — off mode (CTL-1004)", () => {
  test("mode:off → pass is entirely skipped (no census, no events)", async () => {
    const events = [];
    const intents = [];
    let collected = false;
    const world = makeWorld();
    const opts = makeOpts(world, { mode: "off", events, intents });
    opts.collectOrphanCandidates = () => {
      collected = true;
      return world.orphanCandidates;
    };
    const res = await runStallJanitorPass(opts);
    expect(collected).toBe(false);
    expect(events).toHaveLength(0);
    expect(intents).toHaveLength(0);
    expect(res.reaped).toEqual([]);
    expect(res.wouldReap).toEqual([]);
    expect(res.killIntents).toEqual([]);
    expect(res.wouldKill).toEqual([]);
  });
});

// ===========================================================================
// CTL-1005 J3 — auto-clear a prior-artifact-retry-exhausted stall ONCE when the
// prior-phase artifact is present AND complete (non-truncated).
// ===========================================================================

// ---------------------------------------------------------------------------
// J3 classifier — classifyStallClear (PURE, all evidence injected)
// ---------------------------------------------------------------------------
describe("classifyStallClear (CTL-1005 J3)", () => {
  const base = {
    ticket: "CTL-854",
    phase: "plan",
    stalledReason: "prior-artifact-retry-exhausted",
    linearTerminal: false, // Linear state is non-terminal
    liveSessionInWorktree: false,
    artifactPresent: true,
    artifactComplete: true, // existence + non-truncation
    alreadyCleared: false, // no .janitor-cleared-<phase>.applied marker yet
    dispatchFailureCode: 2,       // CTL-1045 Bug 2: benign prior-artifact-missing exit code
    priorDoneSignalPresent: true, // CTL-1045 Bug 3: prior-phase done signal survives
  };

  test("retry-exhausted stall + complete artifact + non-terminal + no live session → clear", () => {
    expect(classifyStallClear(base).action).toBe("clear");
  });

  test("wrong stalledReason (e.g. dispatch-circuit-breaker) → skip (never clears a non-retry-exhausted stall)", () => {
    const d = classifyStallClear({ ...base, stalledReason: "dispatch-circuit-breaker" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/reason/);
  });

  test("artifact ABSENT → skip (stays frozen)", () => {
    const d = classifyStallClear({ ...base, artifactPresent: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/artifact/);
  });

  test("artifact present but TRUNCATED (incomplete) → skip (existence alone is not enough)", () => {
    const d = classifyStallClear({ ...base, artifactComplete: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/artifact/);
  });

  test("Linear state terminal/merged → skip (never unstick a terminal ticket)", () => {
    const d = classifyStallClear({ ...base, linearTerminal: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/terminal/);
  });

  test("a live session owns the worktree → skip (never touch live)", () => {
    const d = classifyStallClear({ ...base, liveSessionInWorktree: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/live/);
  });

  test("already cleared once (.janitor-cleared marker present) → skip (one clear per worker-dir lifetime)", () => {
    const d = classifyStallClear({ ...base, alreadyCleared: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/already-cleared/);
  });

  // CTL-1045 Bug 2: only exit code 2 (prior_artifact_missing) is clearable.
  test("CTL-1045 Bug 2: clear requires dispatchFailureCode === 2 (benign prior-artifact-missing)", () => {
    expect(classifyStallClear({ ...base, dispatchFailureCode: 2 }).action).toBe("clear");
    expect(classifyStallClear({ ...base, dispatchFailureCode: 0 }).action).toBe("skip");   // verify_failed
    expect(classifyStallClear({ ...base, dispatchFailureCode: 1 }).action).toBe("skip");   // crash
    expect(classifyStallClear({ ...base, dispatchFailureCode: null }).action).toBe("skip"); // legacy signal
  });

  // CTL-1045 Bug 3: never empty a worker dir — prior-phase done signal must survive.
  test("CTL-1045 Bug 3: clear declines when the prior-phase done signal is absent", () => {
    const d = classifyStallClear({ ...base, priorDoneSignalPresent: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("prior-done-signal-absent");
  });
});

// ---------------------------------------------------------------------------
// runStallJanitorPass — J3 driver (clear seam injected)
// ---------------------------------------------------------------------------
function makeStallWorld(overrides = {}) {
  return {
    orphanCandidates: [],
    ghostCandidates: [],
    stallCandidates: [
      {
        ticket: "CTL-854",
        phase: "plan",
        stalledReason: "prior-artifact-retry-exhausted",
        linearTerminal: false,
        liveSessionInWorktree: false,
        artifactPresent: true,
        artifactComplete: true,
        alreadyCleared: false,
        dispatchFailureCode: 2,       // CTL-1045 Bug 2
        priorDoneSignalPresent: true, // CTL-1045 Bug 3
      },
    ],
    ...overrides,
  };
}

function makeStallOpts(world, { mode, events = [], cleared = [] } = {}) {
  return {
    mode,
    collectOrphanCandidates: () => world.orphanCandidates,
    collectGhostCandidates: () => world.ghostCandidates,
    collectStallClearCandidates: () => world.stallCandidates,
    emit: (type, fields) => {
      events.push({ type, ...fields });
      return Promise.resolve(true);
    },
    // The clear seam: records the (ticket, phase) it was asked to clear.
    clearStall: ({ ticket, phase }) => {
      cleared.push({ ticket, phase });
      return true;
    },
  };
}

describe("runStallJanitorPass — J3 enforce (CTL-1005)", () => {
  test("clears a complete-artifact retry-exhausted stall: calls clearStall + emits janitor.stall.cleared{artifact_verified:true}", async () => {
    const events = [];
    const cleared = [];
    const world = makeStallWorld();
    const res = await runStallJanitorPass(makeStallOpts(world, { mode: "enforce", events, cleared }));
    expect(cleared).toEqual([{ ticket: "CTL-854", phase: "plan" }]);
    const ev = events.find((e) => e.type === "janitor.stall.cleared");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe("CTL-854");
    expect(ev.phase).toBe("plan");
    expect(ev.artifact_verified ?? ev.artifactVerified).toBe(true);
    expect(res.stallsCleared).toEqual([{ ticket: "CTL-854", phase: "plan" }]);
  });

  test("absent/truncated artifact stays frozen — no clear, no event", async () => {
    const events = [];
    const cleared = [];
    const world = makeStallWorld({
      stallCandidates: [{ ...makeStallWorld().stallCandidates[0], artifactComplete: false }],
    });
    const res = await runStallJanitorPass(makeStallOpts(world, { mode: "enforce", events, cleared }));
    expect(cleared).toEqual([]);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(res.stallsCleared).toEqual([]);
  });

  test("terminal Linear ticket is never unstuck", async () => {
    const cleared = [];
    const world = makeStallWorld({
      stallCandidates: [{ ...makeStallWorld().stallCandidates[0], linearTerminal: true }],
    });
    await runStallJanitorPass(makeStallOpts(world, { mode: "enforce", cleared }));
    expect(cleared).toEqual([]);
  });

  test("already-cleared (re-stall after one clear) is not re-cleared", async () => {
    const cleared = [];
    const world = makeStallWorld({
      stallCandidates: [{ ...makeStallWorld().stallCandidates[0], alreadyCleared: true }],
    });
    await runStallJanitorPass(makeStallOpts(world, { mode: "enforce", cleared }));
    expect(cleared).toEqual([]);
  });

  test("never clears a non-retry-exhausted stall (different stalledReason)", async () => {
    const cleared = [];
    const world = makeStallWorld({
      stallCandidates: [{ ...makeStallWorld().stallCandidates[0], stalledReason: "dispatch-circuit-breaker" }],
    });
    await runStallJanitorPass(makeStallOpts(world, { mode: "enforce", cleared }));
    expect(cleared).toEqual([]);
  });
});

describe("runStallJanitorPass — J3 shadow (CTL-1005)", () => {
  test("shadow emits janitor.would.clear{artifact_verified:true}; never calls clearStall", async () => {
    const events = [];
    const cleared = [];
    const world = makeStallWorld();
    const res = await runStallJanitorPass(makeStallOpts(world, { mode: "shadow", events, cleared }));
    expect(cleared).toEqual([]);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    const would = events.find((e) => e.type === "janitor.would.clear");
    expect(would).toBeDefined();
    expect(would.ticket).toBe("CTL-854");
    expect(would.artifact_verified ?? would.artifactVerified).toBe(true);
    expect(res.wouldClear).toEqual([{ ticket: "CTL-854", phase: "plan" }]);
    expect(res.stallsCleared).toEqual([]);
  });
});

describe("runStallJanitorPass — J3 off (CTL-1005)", () => {
  test("mode:off → J3 census never collected, no clears", async () => {
    let collected = false;
    const cleared = [];
    const world = makeStallWorld();
    const opts = makeStallOpts(world, { mode: "off", cleared });
    opts.collectStallClearCandidates = () => {
      collected = true;
      return world.stallCandidates;
    };
    const res = await runStallJanitorPass(opts);
    expect(collected).toBe(false);
    expect(cleared).toEqual([]);
    expect(res.stallsCleared).toEqual([]);
    expect(res.wouldClear).toEqual([]);
  });
});

describe("runStallJanitorPass — isolation (CTL-1004)", () => {
  test("a throwing classifier/seam on one candidate does not abort the whole pass", async () => {
    const events = [];
    const world = makeWorld({
      orphanCandidates: [
        // first candidate's emit throws
        { ...makeWorld().orphanCandidates[0], ticket: "CTL-BOOM", worktreePath: "/wt/CTL-BOOM" },
        makeWorld().orphanCandidates[0],
      ],
    });
    const opts = makeOpts(world, { mode: "enforce", events });
    let first = true;
    opts.emit = (type, fields) => {
      if (first && fields.ticket === "CTL-BOOM") {
        first = false;
        throw new Error("injected emit failure");
      }
      events.push({ type, ...fields });
      return Promise.resolve(true);
    };
    // Must not throw; the second candidate still gets processed.
    const res = await runStallJanitorPass(opts);
    expect(res.reaped.some((r) => r.ticket === "CTL-100")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Production census builders (read-only, fail-safe)
// ---------------------------------------------------------------------------
describe("defaultTicketFromCwd (CTL-1004)", () => {
  test("extracts CTL-100 from a worktree cwd", () => {
    expect(defaultTicketFromCwd("/Users/x/catalyst/wt/CTL/CTL-100")).toBe("CTL-100");
  });
  test("trailing slash tolerated", () => {
    expect(defaultTicketFromCwd("/wt/CTL/CTL-100/")).toBe("CTL-100");
  });
  test("non-ticket path → null", () => {
    expect(defaultTicketFromCwd("/tmp/scratch")).toBeNull();
    expect(defaultTicketFromCwd(null)).toBeNull();
  });
});

describe("defaultCollectOrphanCandidates (CTL-1004)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1004-cen-"));
  });
  afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

  function mkWorker(ticket, { terminalDone = true, reaped = false, bgJobId } = {}) {
    const d = join(orchDir, "workers", ticket);
    mkdirSync(d, { recursive: true });
    if (terminalDone) writeFileSync(join(d, ".terminal-done.applied"), "");
    if (reaped) writeFileSync(join(d, ".terminal-reap-teardown"), "");
    if (bgJobId) {
      writeFileSync(
        join(d, "phase-monitor-deploy.json"),
        JSON.stringify({ ticket, phase: "monitor-deploy", status: "done", bg_job_id: bgJobId }),
      );
    }
    return d;
  }

  test("only terminal-Done tickets are censused; non-terminal is skipped", () => {
    mkWorker("CTL-100", { terminalDone: true, bgJobId: "job100" });
    mkWorker("CTL-200", { terminalDone: false }); // no marker → skipped
    // git worktree list returns a worktree bound to CTL-100; status clean.
    const runGit = (args) => {
      if (args.includes("list")) {
        return { status: 0, stdout: "worktree /wt/CTL-100\nbranch refs/heads/CTL-100\n" };
      }
      if (args.includes("status")) return { status: 0, stdout: "" }; // clean
      return { status: 1, stdout: "" };
    };
    const out = defaultCollectOrphanCandidates({
      orchDir,
      projects: [{ team: "CTL", repoRoot: "/repo/CTL" }],
      agents: [],
      inFlightTickets: new Set(),
      runGit,
    });
    const ctl100 = out.find((c) => c.ticket === "CTL-100");
    expect(out.map((c) => c.ticket)).toEqual(["CTL-100"]);
    expect(ctl100.teardownDone).toBe(true);
    expect(ctl100.bgJobId).toBe("job100");
    expect(ctl100.alreadyReaped).toBe(false);
  });

  test("already-reaped marker sets alreadyReaped (classifier then skips)", () => {
    mkWorker("CTL-100", { reaped: true });
    const runGit = () => ({ status: 1, stdout: "" }); // no worktree
    const out = defaultCollectOrphanCandidates({
      orchDir,
      projects: [{ team: "CTL", repoRoot: "/repo/CTL" }],
      runGit,
    });
    expect(out[0].alreadyReaped).toBe(true);
    expect(out[0].worktreeOnDisk).toBe(false);
  });

  test("a live session inside the worktree sets liveSessionInWorktree (never-touch-live)", () => {
    mkWorker("CTL-100");
    const runGit = (args) => {
      if (args.includes("list")) {
        // Use the real orchDir as the worktree path so existsSync passes.
        return { status: 0, stdout: `worktree ${orchDir}\nbranch refs/heads/CTL-100\n` };
      }
      if (args.includes("status")) return { status: 0, stdout: "" };
      return { status: 1, stdout: "" };
    };
    const out = defaultCollectOrphanCandidates({
      orchDir,
      projects: [{ team: "CTL", repoRoot: "/repo/CTL" }],
      agents: [{ sessionId: "s1", cwd: orchDir, status: "idle", kind: "background" }],
      runGit,
    });
    expect(out[0].liveSessionInWorktree).toBe(true);
  });
});

describe("defaultCollectGhostCandidates (CTL-1004)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1004-ghost-"));
  });
  afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

  test("idle background session over a terminal signal → ghost candidate with age", () => {
    const d = join(orchDir, "workers", "CTL-200");
    mkdirSync(d, { recursive: true });
    const sig = join(d, "phase-monitor-deploy.json");
    writeFileSync(sig, JSON.stringify({ ticket: "CTL-200", phase: "monitor-deploy", status: "done" }));
    const NOW = 2_000_000;
    const out = defaultCollectGhostCandidates({
      orchDir,
      agents: [{ sessionId: "ghost1", cwd: "/wt/CTL/CTL-200", status: "idle", kind: "background" }],
      now: () => NOW,
      statSignalMtimeMs: () => NOW - 700_000, // 700s old
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ticket: "CTL-200",
      phase: "monitor-deploy",
      bgJobId: "ghost1",
      sessionKind: "background",
      sessionStatus: "idle",
    });
    expect(out[0].terminalForMs).toBe(700_000);
  });

  test("a busy / interactive session is pre-filtered out of the census", () => {
    const d = join(orchDir, "workers", "CTL-200");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "phase-monitor-deploy.json"), JSON.stringify({ status: "done" }));
    const out = defaultCollectGhostCandidates({
      orchDir,
      agents: [
        { sessionId: "busy1", cwd: "/wt/CTL/CTL-200", status: "busy", kind: "background" },
        { sessionId: "human1", cwd: "/wt/CTL/CTL-200", status: "idle", kind: "interactive" },
      ],
    });
    expect(out).toHaveLength(0);
  });

  test("no terminal signal for the ticket → no ghost candidate", () => {
    const d = join(orchDir, "workers", "CTL-200");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "phase-implement.json"), JSON.stringify({ status: "running" }));
    const out = defaultCollectGhostCandidates({
      orchDir,
      agents: [{ sessionId: "g", cwd: "/wt/CTL/CTL-200", status: "idle", kind: "background" }],
    });
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// J3 census builder — defaultCollectStallClearCandidates (CTL-1005)
// ---------------------------------------------------------------------------
describe("defaultCollectStallClearCandidates (CTL-1005 J3)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1005-cen-"));
  });
  afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

  // Write a stalled phase signal with the J3-relevant reason.
  function mkStalled(ticket, phase, { reason = "prior-artifact-retry-exhausted", cleared = false } = {}) {
    const d = join(orchDir, "workers", ticket);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "stalled", stalledReason: reason, dispatchFailureCode: 2 }),
    );
    if (cleared) writeFileSync(join(d, `.janitor-cleared-${phase}.applied`), "");
    return d;
  }

  // A `plan`-phase stall needs its prior research artifact under
  // thoughts/shared/research/. The artifact-completeness probe is injected so the
  // census doesn't shell out / read the real worktree.
  test("plan stall + COMPLETE prior research artifact + non-terminal + no session → one candidate (artifactComplete:true)", () => {
    mkStalled("CTL-854", "plan");
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-854",
      agents: [],
      artifactComplete: () => true, // injected completeness probe (present + non-truncated)
      artifactPresent: () => true,
    });
    const c = out.find((x) => x.ticket === "CTL-854");
    expect(c).toBeDefined();
    expect(c.phase).toBe("plan");
    expect(c.stalledReason).toBe("prior-artifact-retry-exhausted");
    expect(c.artifactPresent).toBe(true);
    expect(c.artifactComplete).toBe(true);
    expect(c.linearTerminal).toBe(false);
    expect(c.liveSessionInWorktree).toBe(false);
    expect(c.alreadyCleared).toBe(false);
  });

  test("MISSING prior artifact → candidate carries artifactPresent:false (classifier then skips)", () => {
    mkStalled("CTL-854", "plan");
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-854",
      artifactPresent: () => false,
      artifactComplete: () => false,
    });
    expect(out[0].artifactPresent).toBe(false);
    expect(out[0].artifactComplete).toBe(false);
  });

  test("TRUNCATED prior artifact → candidate carries artifactComplete:false (present but incomplete)", () => {
    mkStalled("CTL-854", "plan");
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-854",
      artifactPresent: () => true,
      artifactComplete: () => false, // present on disk but truncated
    });
    expect(out[0].artifactPresent).toBe(true);
    expect(out[0].artifactComplete).toBe(false);
  });

  test("a non-retry-exhausted stall (dispatch-circuit-breaker) is NOT censused for J3", () => {
    mkStalled("CTL-854", "plan", { reason: "dispatch-circuit-breaker" });
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-854",
      artifactPresent: () => true,
      artifactComplete: () => true,
    });
    expect(out.map((c) => c.ticket)).toEqual([]);
  });

  test("a non-stalled signal (running/done) is NOT censused", () => {
    const d = join(orchDir, "workers", "CTL-900");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "phase-plan.json"), JSON.stringify({ status: "running" }));
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-900",
      artifactPresent: () => true,
      artifactComplete: () => true,
    });
    expect(out.map((c) => c.ticket)).toEqual([]);
  });

  test(".janitor-cleared-<phase>.applied marker present → alreadyCleared:true", () => {
    mkStalled("CTL-854", "plan", { cleared: true });
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => "/wt/CTL-854",
      artifactPresent: () => true,
      artifactComplete: () => true,
    });
    expect(out[0].alreadyCleared).toBe(true);
  });

  // CTL-1045 Bug 5: doctrine guard — once-marker is file-backed and survives
  // across daemon restarts (per worker-dir lifetime, NOT per daemon lifetime).
  test("CTL-1045 Bug 5: once-marker survives across a simulated daemon restart (per worker-dir lifetime)", () => {
    const d = mkStalled("CTL-854", "plan", { cleared: true });
    // Simulate a daemon restart by constructing a fresh census call (new call stack,
    // no module-level state persisted across the call).
    const out = defaultCollectStallClearCandidates({
      orchDir,
      isLinearTerminal: () => false,
      resolveWorktreePath: () => d,
      artifactPresent: () => true,
      artifactComplete: () => true,
    });
    // The marker file survives the restart — alreadyCleared reads true from disk.
    expect(out[0].alreadyCleared).toBe(true);
  });
});
