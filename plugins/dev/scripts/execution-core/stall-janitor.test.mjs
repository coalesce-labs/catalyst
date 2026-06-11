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
  runStallJanitorPass,
  defaultCollectOrphanCandidates,
  defaultCollectGhostCandidates,
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
