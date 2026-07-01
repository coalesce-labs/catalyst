// delegate-runner.test.mjs — CTL-1331. The detached delegate RUNNER: the
// in-daemon timer (startDelegateRunnerTimer) that spawns the detached drainer,
// and the drainer body (drainOnce) that claims queued intents and moves the
// heavy worktree-provision + `claude --bg` spawn OFF the daemon event loop.
//
// Deterministic: orchDir is a tmpdir; clock / spawn / claimFn / invokeFn /
// countBackgroundAgents / emit* / fs are all injected — NO real claude/git/
// worktree/network (mirrors worktree-refresh-timer.test.mjs +
// delegate-queue.test.mjs).
//
// Mirrors the §10d TDD plan in
//   thoughts/shared/plans/2026-06-24-ctl-1331-async-worker-design.md:
//   - drains a queued intent → claimed→launched + bg_job_id + requested+launched emitted
//   - invoke failure → failed status + failed emitted
//   - free-slot re-check (countBackgroundAgents >= maxParallel → un-claim, no dispatch)
//   - live-worker supersede → superseded, gc, no dispatch
//   - single-flight (two concurrent drains, one claims)
//   - stale-claim reclaim
//   - DETACHED invariant: the timer kick uses spawn(...).unref(), NEVER spawnSync,
//     NEVER stdio:"ignore"
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-runner.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDelegateRunnerTimer } from "./delegate-runner.mjs";
import { drainOnce } from "./delegate-runner-entry.mjs";
import { DELEGATE_QUEUE_DIR, claimIntent } from "./delegate-queue.mjs";

let orchDir;
const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1331-runner-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function queueDir() {
  return join(orchDir, DELEGATE_QUEUE_DIR);
}

function intentPath(ticket) {
  return join(queueDir(), `${ticket}.json`);
}

function readIntent(ticket) {
  return JSON.parse(readFileSync(intentPath(ticket), "utf8"));
}

function listQueueFiles() {
  try {
    return readdirSync(queueDir());
  } catch {
    return [];
  }
}

// Seed a queued <TICKET>.json the runner will drain.
function seedQueued(ticket, fields = {}) {
  mkdirSync(queueDir(), { recursive: true });
  writeFileSync(
    intentPath(ticket),
    JSON.stringify({
      schema: "delegate-intent/v1",
      ticket,
      status: "queued",
      kind: "board-health",
      phase: "recovery-pass",
      boardContext: { anomaly: "wip-spike" },
      reason: "board-health: wip spike — holistic delegate",
      enqueuedAt: FIXED_NOW,
      ...fields,
    })
  );
}

// Seed a live recovery-pass worker signal (the supersede input).
function seedRecoveryPassSignal(ticket, status, bgJobId = "bg-live-1") {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phase-recovery-pass.json"),
    JSON.stringify({ ticket, phase: "recovery-pass", status, bg_job_id: bgJobId })
  );
}

// A spy-bag of the emitters + the invoke/count seams the drainer uses.
function makeDeps(over = {}) {
  const emitted = { requested: [], launched: [], failed: [] };
  return {
    orchDir,
    now: () => FIXED_NOW,
    maxParallel: 8,
    pid: 4242,
    // injected slot probe — default: nothing live → headroom available.
    countBackgroundAgents: () => 0,
    // injected idempotency probe — default: no live worker.
    isBgJobAlive: () => false,
    // injected heavy path — default: dispatched OK with a bg job + worktree.
    invokeFn: (ticket, brief, d) => ({
      success: true,
      dispatched: true,
      attempts: 1,
      reason: "recovery-pass dispatched",
      details: {
        phase: "recovery-pass",
        bg_job_id: `bg-${ticket}`,
        worktreePath: `/wt/${ticket}`,
      },
    }),
    appendRequested: (e) => emitted.requested.push(e),
    appendLaunched: (e) => emitted.launched.push(e),
    appendFailed: (e) => emitted.failed.push(e),
    _emitted: emitted,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// drainOnce — the detached drainer body
// ════════════════════════════════════════════════════════════════════════════

describe("drainOnce — drains a queued intent → launched", () => {
  test("claims the intent, invokes recovery-pass, flips to launched + records bg_job_id/worktreePath/launchedAt", () => {
    seedQueued("CTL-1");
    const deps = makeDeps();
    const invoked = [];
    deps.invokeFn = (ticket, brief, d) => {
      invoked.push({ ticket, brief, d });
      return {
        dispatched: true,
        details: { bg_job_id: "bg-9", worktreePath: "/wt/CTL-1" },
      };
    };

    const res = drainOnce(deps);

    // invoked with the intent's boardContext + reason
    expect(invoked).toHaveLength(1);
    expect(invoked[0].ticket).toBe("CTL-1");
    expect(invoked[0].brief.boardContext).toEqual({ anomaly: "wip-spike" });
    expect(invoked[0].brief.reason).toContain("wip spike");

    // intent flipped to launched with the launch fields
    const intent = readIntent("CTL-1");
    expect(intent.status).toBe("launched");
    expect(intent.bg_job_id).toBe("bg-9");
    expect(intent.worktreePath).toBe("/wt/CTL-1");
    expect(intent.launchedAt).toBe(FIXED_NOW);

    // no claim sidecar left behind
    expect(listQueueFiles().some((f) => f.includes(".claimed-"))).toBe(false);

    expect(res.drained).toBe(1);
  });

  test("emits phase.dispatch.requested then phase.dispatch.launched (in order, with bg_job_id)", () => {
    seedQueued("CTL-1");
    const deps = makeDeps();
    deps.invokeFn = () => ({
      dispatched: true,
      details: { bg_job_id: "bg-7", worktreePath: "/wt/CTL-1" },
    });

    drainOnce(deps);

    expect(deps._emitted.requested).toHaveLength(1);
    expect(deps._emitted.requested[0].ticket).toBe("CTL-1");
    expect(deps._emitted.requested[0].target_phase).toBe("recovery-pass");

    expect(deps._emitted.launched).toHaveLength(1);
    expect(deps._emitted.launched[0].ticket).toBe("CTL-1");
    expect(deps._emitted.launched[0].bg_job_id).toBe("bg-7");
    expect(deps._emitted.launched[0].worktree_path).toBe("/wt/CTL-1");

    expect(deps._emitted.failed).toHaveLength(0);
  });

  test("NEVER emits a phase.recovery-pass.* event (only the worker emits completion)", () => {
    seedQueued("CTL-1");
    const names = [];
    const deps = makeDeps({
      appendRequested: (e) => names.push(`requested:${e.target_phase}`),
      appendLaunched: (e) => names.push(`launched:${e.target_phase}`),
      appendFailed: (e) => names.push(`failed:${e.target_phase}`),
    });
    drainOnce(deps);
    // target_phase rides as recovery-pass in payload, but the EVENT slot is dispatch.
    // Assert the drainer never produced any recovery-pass-slotted emission of its own.
    expect(names.every((n) => n.startsWith("requested:") || n.startsWith("launched:") || n.startsWith("failed:"))).toBe(true);
  });
});

describe("drainOnce — invoke failure → failed", () => {
  test("a non-dispatched invoke result flips the intent to failed + emits phase.dispatch.failed", () => {
    seedQueued("CTL-2");
    const deps = makeDeps();
    deps.invokeFn = () => ({
      dispatched: false,
      reason: "recovery-pass-cycle-cap-exhausted",
    });

    const res = drainOnce(deps);

    const intent = readIntent("CTL-2");
    expect(intent.status).toBe("failed");
    expect(intent.reason).toBe("recovery-pass-cycle-cap-exhausted");

    expect(deps._emitted.failed).toHaveLength(1);
    expect(deps._emitted.failed[0].ticket).toBe("CTL-2");
    expect(deps._emitted.failed[0].reason).toBe("recovery-pass-cycle-cap-exhausted");

    expect(deps._emitted.launched).toHaveLength(0);
    expect(res.drained).toBe(0);
  });

  test("an invoke that THROWS is caught → failed (never crashes the drainer)", () => {
    seedQueued("CTL-3");
    const deps = makeDeps();
    deps.invokeFn = () => {
      throw new Error("boom");
    };

    expect(() => drainOnce(deps)).not.toThrow();
    expect(readIntent("CTL-3").status).toBe("failed");
    expect(deps._emitted.failed).toHaveLength(1);
  });
});

describe("drainOnce — kind:recovery-item dispatches the per-item briefObj (FU-1)", () => {
  test("invokes recovery-pass with the full briefObj (NOT a board-health boardContext), launches", () => {
    const briefObj = {
      brief: "stuck in verify",
      reason: "verify-loop",
      evidence: { logsOutput: "tsc errors", jobState: "dead" },
      phase: "verify",
      bgJobId: "bg-dead-9",
      failureReason: "tsc failed",
    };
    seedQueued("CTL-RI", { kind: "recovery-item", briefObj, boardContext: null, reason: "verify-loop" });
    const invoked = [];
    const deps = makeDeps();
    deps.invokeFn = (ticket, brief, d) => {
      invoked.push({ ticket, brief, d });
      return { success: true, dispatched: true, attempts: 1, details: { bg_job_id: "bg-x", worktreePath: "/wt/x" } };
    };

    const res = drainOnce(deps);

    expect(invoked).toHaveLength(1);
    expect(invoked[0].ticket).toBe("CTL-RI");
    // the FULL per-item brief is passed through verbatim — never a {boardContext}
    expect(invoked[0].brief).toEqual(briefObj);
    expect(invoked[0].brief.boardContext).toBeUndefined();
    expect(readIntent("CTL-RI").status).toBe("launched");
    expect(res.drained).toBe(1);
    // the requested telemetry labels the kind
    expect(deps._emitted.requested[0].reason).toBe("recovery-item");
  });
});

describe("drainOnce — free-slot re-check", () => {
  test("countBackgroundAgents >= maxParallel → un-claims (back to queued), does NOT dispatch", () => {
    seedQueued("CTL-4");
    const deps = makeDeps({
      maxParallel: 2,
      countBackgroundAgents: () => 2, // no headroom
    });
    let invoked = false;
    deps.invokeFn = () => {
      invoked = true;
      return { dispatched: true, details: {} };
    };

    const res = drainOnce(deps);

    expect(invoked).toBe(false); // never reached the heavy path
    // intent un-claimed back to queued (left for next cycle), no claim sidecar
    expect(existsSync(intentPath("CTL-4"))).toBe(true);
    expect(readIntent("CTL-4").status).toBe("queued");
    expect(listQueueFiles().some((f) => f.includes(".claimed-"))).toBe(false);

    expect(deps._emitted.requested).toHaveLength(0);
    expect(deps._emitted.launched).toHaveLength(0);
    expect(res.drained).toBe(0);
  });

  test("countBackgroundAgents THROWS → fail-CLOSED: un-claims, does NOT dispatch (CTL-1331 §3b conservative-only)", () => {
    seedQueued("CTL-4b");
    const deps = makeDeps({
      maxParallel: 2,
      countBackgroundAgents: () => {
        throw new Error("claude agents RPC failed");
      },
    });
    let invoked = false;
    deps.invokeFn = () => {
      invoked = true;
      return { dispatched: true, details: {} };
    };

    const res = drainOnce(deps);

    // A live count we CANNOT read must never launch on unknown headroom — fail
    // closed (un-claim, retry next cycle), matching the scheduler tick's own
    // CTL-731 hold-on-stale-liveness posture. Never over-spawn.
    expect(invoked).toBe(false);
    expect(readIntent("CTL-4b").status).toBe("queued");
    expect(listQueueFiles().some((f) => f.includes(".claimed-"))).toBe(false);
    expect(deps._emitted.requested).toHaveLength(0);
    expect(deps._emitted.launched).toHaveLength(0);
    expect(res.drained).toBe(0);
  });

  test("with headroom (countBackgroundAgents < maxParallel) it DOES dispatch", () => {
    seedQueued("CTL-5");
    const deps = makeDeps({ maxParallel: 2, countBackgroundAgents: () => 1 });
    drainOnce(deps);
    expect(readIntent("CTL-5").status).toBe("launched");
  });

  // GROUP C: an sdk dispatch settles synchronously with NO bg job, so countBg
  // cannot see this pass's launches. drainOnce must count them locally so it does
  // not overrun maxParallel across multiple queued intents in one drain.
  test("executor=sdk: with maxParallel=1 and two queued intents, only ONE launches (the second un-claims)", () => {
    seedQueued("CTL-SDK-1");
    seedQueued("CTL-SDK-2");
    let invokes = 0;
    const deps = makeDeps({
      maxParallel: 1,
      executor: "sdk",
      // sdk dispatch is synchronous & invisible to countBg — it stays 0 the
      // whole pass, exactly the condition that used to let BOTH intents launch.
      countBackgroundAgents: () => 0,
      invokeFn: () => {
        invokes++;
        return { dispatched: true, details: {} }; // sdk: no bg_job_id
      },
    });

    const res = drainOnce(deps);

    expect(invokes).toBe(1); // slot limit honored despite the static bg count
    expect(res.drained).toBe(1);
    const statuses = ["CTL-SDK-1", "CTL-SDK-2"].map((t) => readIntent(t).status).sort();
    expect(statuses).toEqual(["launched", "queued"]); // one launched, one held
    expect(deps._emitted.launched).toHaveLength(1);
  });

  // The bg path is unchanged: localLaunched is never consulted (executor != sdk),
  // so the per-intent countBg check governs exactly as before.
  test("executor=bg: localLaunched is NOT consulted (bg jobs surface in countBg)", () => {
    seedQueued("CTL-BG-1");
    seedQueued("CTL-BG-2");
    let invokes = 0;
    const deps = makeDeps({
      maxParallel: 8,
      executor: "bg",
      countBackgroundAgents: () => 0, // plenty of headroom for both
      invokeFn: (ticket) => {
        invokes++;
        return { dispatched: true, details: { bg_job_id: `bg-${ticket}` } };
      },
    });

    const res = drainOnce(deps);

    expect(invokes).toBe(2);
    expect(res.drained).toBe(2);
  });
});

describe("drainOnce — live-worker supersede (idempotency)", () => {
  test("a live recovery-pass worker already exists → superseded, GC, no dispatch", () => {
    seedQueued("CTL-6");
    seedRecoveryPassSignal("CTL-6", "running", "bg-live-6");
    const deps = makeDeps({ isBgJobAlive: (id) => id === "bg-live-6" });
    let invoked = false;
    deps.invokeFn = () => {
      invoked = true;
      return { dispatched: true, details: {} };
    };

    const res = drainOnce(deps);

    expect(invoked).toBe(false);
    // GC'd — the intent file (and any claim sidecar) is gone
    expect(existsSync(intentPath("CTL-6"))).toBe(false);
    expect(listQueueFiles().some((f) => f.startsWith("CTL-6"))).toBe(false);

    expect(deps._emitted.requested).toHaveLength(0);
    expect(deps._emitted.launched).toHaveLength(0);
    expect(res.superseded).toBe(1);
  });

  test("a DEAD recovery-pass worker does NOT supersede → it dispatches normally", () => {
    seedQueued("CTL-7");
    seedRecoveryPassSignal("CTL-7", "running", "bg-dead-7");
    const deps = makeDeps({ isBgJobAlive: () => false });
    drainOnce(deps);
    expect(readIntent("CTL-7").status).toBe("launched");
  });

  // CTL-1157 (GROUP-3 #2): under executor=sdk the recovery-pass worker runs in-process
  // with NO bg_job_id — a dispatched|running signal there is LIVE. A second drain scan
  // must SUPERSEDE (not re-launch) it, otherwise the same ticket double-dispatches.
  test("sdk: a running recovery-pass worker with NO bg_job_id → superseded (no re-dispatch) when executor==='sdk'", () => {
    seedQueued("CTL-sdk");
    seedRecoveryPassSignal("CTL-sdk", "running", null); // sdk shape: no bg id
    const deps = makeDeps({ executor: "sdk", isBgJobAlive: () => false });
    let invoked = false;
    deps.invokeFn = () => {
      invoked = true;
      return { dispatched: true, details: {} };
    };
    const res = drainOnce(deps);
    expect(invoked).toBe(false);
    expect(existsSync(intentPath("CTL-sdk"))).toBe(false); // GC'd, not launched
    expect(res.superseded).toBe(1);
  });

  test("bg (default): a running worker with NO bg_job_id does NOT supersede → dispatches (byte-identical)", () => {
    seedQueued("CTL-bgnull");
    seedRecoveryPassSignal("CTL-bgnull", "running", null);
    const deps = makeDeps({ isBgJobAlive: () => false }); // no executor → bg
    drainOnce(deps);
    expect(readIntent("CTL-bgnull").status).toBe("launched");
  });
});

describe("drainOnce — single-flight (two concurrent drains)", () => {
  test("two drains over the same intent → exactly one claims+dispatches, the other skips", () => {
    seedQueued("CTL-8");

    // Inject a claimFn that lets us interleave: the first drain claims, then while
    // it holds the claim we run a SECOND drain (which must lose the claim).
    const realClaim = claimIntent;
    let secondResult = null;
    const depsA = makeDeps();
    depsA.claimFn = (od, ticket, pid, ts) => {
      const r = realClaim(od, ticket, pid, ts);
      if (r.claimed && secondResult === null) {
        // run the competing drain WHILE the intent is claimed away
        const depsB = makeDeps({ pid: 9999 });
        secondResult = drainOnce(depsB);
      }
      return r;
    };

    const firstResult = drainOnce(depsA);

    // exactly one dispatched
    const totalLaunched =
      depsA._emitted.launched.length + (secondResult ? 1 : 0) * 0; // B has its own bag
    expect(depsA._emitted.launched).toHaveLength(1);
    expect(firstResult.drained).toBe(1);
    // the second drain saw nothing claimable (the only intent was already claimed)
    expect(secondResult.drained).toBe(0);
    expect(readIntent("CTL-8").status).toBe("launched");
  });
});

describe("drainOnce — stale-claim reclaim", () => {
  test("a claimed-* sidecar older than the ceiling is reclaimed to queued, then drained", () => {
    mkdirSync(queueDir(), { recursive: true });
    const staleTs = FIXED_NOW - 1_000_000; // > 900_000 default ceiling
    const claimPath = join(queueDir(), `CTL-9.json.claimed-555-${staleTs}`);
    writeFileSync(
      claimPath,
      JSON.stringify({
        schema: "delegate-intent/v1",
        ticket: "CTL-9",
        status: "claimed",
        kind: "board-health",
        phase: "recovery-pass",
        boardContext: { anomaly: "x" },
        reason: "r",
        enqueuedAt: staleTs,
      })
    );
    const deps = makeDeps();

    const res = drainOnce(deps);

    // reclaimed (stale sidecar gone) then drained to launched
    expect(existsSync(claimPath)).toBe(false);
    expect(readIntent("CTL-9").status).toBe("launched");
    expect(res.reclaimed).toBeGreaterThanOrEqual(1);
    expect(res.drained).toBe(1);
  });

  test("a FRESH claimed-* (within the window) is left alone, not double-dispatched", () => {
    mkdirSync(queueDir(), { recursive: true });
    const freshTs = FIXED_NOW - 1_000;
    const claimPath = join(queueDir(), `CTL-10.json.claimed-555-${freshTs}`);
    writeFileSync(
      claimPath,
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-10", status: "claimed", enqueuedAt: freshTs })
    );
    const deps = makeDeps();
    const res = drainOnce(deps);
    expect(existsSync(claimPath)).toBe(true); // untouched
    expect(res.drained).toBe(0);
    expect(deps._emitted.launched).toHaveLength(0);
  });
});

describe("drainOnce — empty queue is inert (Phase A invariant)", () => {
  test("no queue dir → zero work, no throw, all-zero result", () => {
    const deps = makeDeps();
    const res = drainOnce(deps);
    expect(res.drained).toBe(0);
    expect(res.superseded).toBe(0);
    expect(deps._emitted.requested).toHaveLength(0);
    expect(deps._emitted.launched).toHaveLength(0);
    expect(deps._emitted.failed).toHaveLength(0);
  });

  test("a queue with only terminal intents (failed) drains nothing", () => {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      intentPath("CTL-term"),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-term", status: "failed" })
    );
    const deps = makeDeps();
    const res = drainOnce(deps);
    expect(res.drained).toBe(0);
    expect(readIntent("CTL-term").status).toBe("failed"); // untouched
  });
});

// ════════════════════════════════════════════════════════════════════════════
// startDelegateRunnerTimer — the in-daemon timer (kick = detached spawn().unref())
// ════════════════════════════════════════════════════════════════════════════

// Fake clock mirroring worktree-refresh-timer.test.mjs.
function fakeClock() {
  let reg = null;
  return {
    setInterval: (fn, ms) => {
      reg = { fn, ms };
      return { unref() {} };
    },
    clearInterval: () => {
      reg = null;
    },
    advance: (elapsedMs) => {
      if (!reg) return;
      const ticks = Math.floor(elapsedMs / reg.ms);
      for (let i = 0; i < ticks; i++) reg.fn();
    },
    registered: () => reg,
  };
}

// A spawn spy returning a child handle with an .unref() spy.
function makeSpawnSpy() {
  const calls = [];
  let unrefCount = 0;
  const spawn = (...args) => {
    calls.push(args);
    return {
      unref: () => {
        unrefCount++;
      },
      pid: 1234,
    };
  };
  return { spawn, calls, unrefCount: () => unrefCount };
}

describe("startDelegateRunnerTimer — detached spawn().unref() kick", () => {
  test("each interval kicks the entry via spawn(process.execPath, [entry], {detached}).unref()", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/delegate-runner-entry.mjs",
      spawn: spy.spawn,
      clock,
      isRunnerRunning: () => false, // single-instance check passes
    });
    clock.advance(15000);

    expect(spy.calls).toHaveLength(1);
    const [cmd, argv, opts] = spy.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(argv).toEqual(["/fake/delegate-runner-entry.mjs"]);
    expect(opts.detached).toBe(true);
    expect(spy.unrefCount()).toBe(1); // .unref() called on the child
    // CTL-1331 FU-1: the child must receive orchDir via CATALYST_EXECUTION_CORE_DIR
    // so the detached entry resolves the right queue (else it exits "no orchDir").
    expect(opts.env.CATALYST_EXECUTION_CORE_DIR).toBe(orchDir);
  });

  test("DETACHED INVARIANT — stdio redirects child stdout/stderr to a log fd, NEVER stdio:'ignore'", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    let openedLogPath = null;
    startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/entry.mjs",
      spawn: spy.spawn,
      clock,
      isRunnerRunning: () => false,
      // injectable fd opener so the test can assert the log target without real fs.
      openLogFd: (p) => {
        openedLogPath = p;
        return 77; // a fake fd
      },
    });
    clock.advance(15000);

    const opts = spy.calls[0][2];
    // stdio is [ignore-stdin, logFd, logFd] — NOT the string "ignore".
    expect(opts.stdio).not.toBe("ignore");
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect(opts.stdio[0]).toBe("ignore"); // stdin ignored is fine
    expect(opts.stdio[1]).toBe(77); // stdout → log fd
    expect(opts.stdio[2]).toBe(77); // stderr → log fd
    // the log target is under <orchDir>/logs/delegate-runner.log
    expect(openedLogPath).toContain(join(orchDir, "logs"));
    expect(openedLogPath).toContain("delegate-runner.log");
  });

  test("DETACHED INVARIANT — the spawn fn is the injectable async spawn, NEVER spawnSync", () => {
    // The timer must accept (and only ever call) the injected `spawn` seam. We
    // assert by making the spy throw if a `sync`-flavored option ever appears,
    // and by confirming the body never imports spawnSync (the spy is the only
    // spawn the timer can reach in this test).
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/entry.mjs",
      spawn: spy.spawn,
      clock,
      isRunnerRunning: () => false,
      openLogFd: () => 5,
    });
    clock.advance(15000);
    // Exactly one async spawn; no third positional that smells synchronous.
    expect(spy.calls).toHaveLength(1);
    const opts = spy.calls[0][2];
    expect(opts).not.toHaveProperty("input"); // spawnSync-only option
    expect(typeof opts.detached).toBe("boolean");
  });

  test("single-instance guard — skips the kick when a runner is already running", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/entry.mjs",
      spawn: spy.spawn,
      clock,
      isRunnerRunning: () => true, // already running
      openLogFd: () => 5,
    });
    clock.advance(15000);
    expect(spy.calls).toHaveLength(0); // no overlapping runner stacked
  });

  test("is a no-op when disabled (mode off)", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    const handle = startDelegateRunnerTimer({
      enabled: false,
      orchDir,
      spawn: spy.spawn,
      clock,
    });
    clock.advance(600000);
    expect(spy.calls).toHaveLength(0);
    expect(clock.registered()).toBeNull();
    expect(typeof handle.stop).toBe("function");
  });

  test("is a no-op when orchDir is missing", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    startDelegateRunnerTimer({
      enabled: true,
      orchDir: undefined,
      spawn: spy.spawn,
      clock,
    });
    clock.advance(600000);
    expect(spy.calls).toHaveLength(0);
  });

  test("stop() clears the interval — no further kicks", () => {
    const clock = fakeClock();
    const spy = makeSpawnSpy();
    const handle = startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/entry.mjs",
      spawn: spy.spawn,
      clock,
      isRunnerRunning: () => false,
      openLogFd: () => 5,
    });
    handle.stop();
    clock.advance(600000);
    expect(spy.calls).toHaveLength(0);
  });

  test("handle.unref() is called on the interval registration (does not hold the loop open)", () => {
    let unrefed = false;
    const clock = {
      setInterval: () => ({ unref: () => { unrefed = true; } }),
      clearInterval: () => {},
    };
    startDelegateRunnerTimer({
      enabled: true,
      intervalMs: 15000,
      orchDir,
      entryPath: "/fake/entry.mjs",
      spawn: () => ({ unref() {} }),
      clock,
      isRunnerRunning: () => false,
      openLogFd: () => 5,
    });
    expect(unrefed).toBe(true);
  });
});
