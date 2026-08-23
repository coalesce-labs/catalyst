// sdk-worker-registry.test.mjs — CTL-1410 Phase B. Fully OFFLINE: the registry
// is a leaf module (node:fs/node:path only); tests fake time via an injected
// now() and pid liveness via an injected pidAlive(). No network, no spawn.
//
// Run: cd plugins/dev/scripts/execution-core && bun test sdk-worker-registry.test.mjs

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SDK_WORKER_FRESH_MS,
  SDK_LIVENESS,
  WARM_HARVEST_MAX_AGE_MS,
  PREEMPTION_ABORT_REASON,
  isPreemptionAbort,
  registerSdkWorker,
  deregisterSdkWorker,
  isSdkWorkerLive,
  sdkWorkerForTicket,
  sdkWorkerForWorktree,
  countLiveSdkWorkers,
  abortSdkWorker,
  cancelSdkRun,
  isSdkWorkerLiveOnDisk,
  classifySdkWorkerLiveness,
  reconcileSdkRegistryOnBoot,
  resetSdkWorkerRegistry,
} from "./sdk-worker-registry.mjs";

const T0 = 1_700_000_000_000;

// Every test starts from a clean singleton; cleanup is inline (house style —
// no beforeEach/afterEach in the sdk-* suites).
function freshDir(prefix = "sdk-reg-") {
  resetSdkWorkerRegistry();
  return mkdtempSync(join(tmpdir(), prefix));
}

function entry(orchDir, over = {}) {
  return {
    ticket: "CTL-1",
    phase: "implement",
    worktreePath: "/wt/ctl-1",
    generation: 1,
    orchDir,
    ...over,
  };
}

function readProjection(orchDir, ticket) {
  return JSON.parse(readFileSync(join(orchDir, ".sdk-workers", `${ticket}.json`), "utf8"));
}

describe("register / deregister / lookups", () => {
  test("register makes the worker live; deregister makes it dead", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    expect(isSdkWorkerLive("CTL-1")).toBe(true);
    expect(countLiveSdkWorkers()).toBe(1);
    h.deregister();
    expect(isSdkWorkerLive("CTL-1")).toBe(false);
    expect(countLiveSdkWorkers()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sdkWorkerForTicket returns a copy without the abort controller", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir), { now: () => T0 });
    h.setAbortController(new AbortController());
    const got = sdkWorkerForTicket("CTL-1");
    expect(got.ticket).toBe("CTL-1");
    expect(got.phase).toBe("implement");
    expect(got.worktreePath).toBe("/wt/ctl-1");
    expect(got.generation).toBe(1);
    expect(got.startedAt).toBe(T0);
    expect(got.pid).toBe(process.pid);
    expect("abortController" in got).toBe(false);
    expect(sdkWorkerForTicket("CTL-404")).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sdkWorkerForWorktree reverse lookup finds the live worker", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir));
    expect(sdkWorkerForWorktree("/wt/ctl-1")?.ticket).toBe("CTL-1");
    expect(sdkWorkerForWorktree("/wt/other")).toBe(null);
    deregisterSdkWorker("CTL-1");
    expect(sdkWorkerForWorktree("/wt/ctl-1")).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-register for the same ticket updates in place (resume), including the worktree index", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir, { generation: 1, worktreePath: "/wt/a" }));
    registerSdkWorker(entry(dir, { generation: 2, worktreePath: "/wt/b" }));
    expect(countLiveSdkWorkers()).toBe(1);
    expect(sdkWorkerForTicket("CTL-1").generation).toBe(2);
    expect(sdkWorkerForWorktree("/wt/b")?.ticket).toBe("CTL-1");
    expect(sdkWorkerForWorktree("/wt/a")).toBe(null); // stale index entry cleaned
    rmSync(dir, { recursive: true, force: true });
  });

  test("compare-and-delete by token: a stale handle's deregister does not evict the resume registration", () => {
    const dir = freshDir();
    const hOld = registerSdkWorker(entry(dir, { generation: 1 }));
    const hNew = registerSdkWorker(entry(dir, { generation: 2 })); // resume re-register
    hOld.deregister(); // stale — must be a no-op
    expect(isSdkWorkerLive("CTL-1")).toBe(true);
    expect(sdkWorkerForTicket("CTL-1").generation).toBe(2);
    hNew.deregister();
    expect(isSdkWorkerLive("CTL-1")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("deregisterSdkWorker (registry-level) force-removes regardless of handle", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir));
    deregisterSdkWorker("CTL-1");
    expect(isSdkWorkerLive("CTL-1")).toBe(false);
    // unknown ticket never throws
    expect(() => deregisterSdkWorker("CTL-404")).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("disk projection", () => {
  test("register writes an atomic projection; deregister unlinks it", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir), { now: () => T0 });
    const proj = readProjection(dir, "CTL-1");
    expect(proj.ticket).toBe("CTL-1");
    expect(proj.phase).toBe("implement");
    expect(proj.worktreePath).toBe("/wt/ctl-1");
    expect(proj.generation).toBe(1);
    expect(proj.pid).toBe(process.pid);
    expect(proj.startedAt).toBe(T0);
    expect(proj.updatedAt).toBe(T0);
    // atomic tmp+rename — no .tmp debris
    expect(readdirSync(join(dir, ".sdk-workers")).filter((f) => f.includes(".tmp"))).toEqual([]);
    h.deregister();
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("touch refreshes updatedAt in memory and (throttled) on disk", () => {
    const dir = freshDir();
    let t = T0;
    const h = registerSdkWorker(entry(dir), { now: () => t });
    t = T0 + 60_000; // beyond any projection-write throttle
    h.touch();
    expect(readProjection(dir, "CTL-1").updatedAt).toBe(T0 + 60_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("touch within the throttle window skips the disk write but a later touch lands", () => {
    const dir = freshDir();
    let t = T0;
    const h = registerSdkWorker(entry(dir), { now: () => t });
    t = T0 + 1_000; // inside throttle
    h.touch();
    expect(readProjection(dir, "CTL-1").updatedAt).toBe(T0);
    t = T0 + 120_000;
    h.touch();
    expect(readProjection(dir, "CTL-1").updatedAt).toBe(T0 + 120_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable orchDir never throws — in-memory registration still works", () => {
    resetSdkWorkerRegistry();
    const h = registerSdkWorker(entry("/nonexistent-root-path/definitely/not/writable"));
    expect(isSdkWorkerLive("CTL-1")).toBe(true);
    expect(() => h.touch()).not.toThrow();
    expect(() => h.deregister()).not.toThrow();
    expect(isSdkWorkerLive("CTL-1")).toBe(false);
  });
});

describe("isSdkWorkerLiveOnDisk (pidAlive primary, freshness secondary)", () => {
  test("true iff projection present AND pid alive AND fresh", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir), { now: () => T0 });
    const alive = () => true;
    const dead = () => false;
    expect(isSdkWorkerLiveOnDisk(dir, "CTL-1", { pidAlive: alive, now: () => T0 + 1000 })).toBe(true);
    expect(isSdkWorkerLiveOnDisk(dir, "CTL-1", { pidAlive: dead, now: () => T0 + 1000 })).toBe(false);
    expect(
      isSdkWorkerLiveOnDisk(dir, "CTL-1", { pidAlive: alive, now: () => T0 + SDK_WORKER_FRESH_MS + 1 }),
    ).toBe(false); // stale
    expect(isSdkWorkerLiveOnDisk(dir, "CTL-404", { pidAlive: alive })).toBe(false); // missing
    rmSync(dir, { recursive: true, force: true });
  });

  test("freshMs is overridable", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir), { now: () => T0 });
    expect(
      isSdkWorkerLiveOnDisk(dir, "CTL-1", { pidAlive: () => true, now: () => T0 + 5_000, freshMs: 1_000 }),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a corrupt projection file reads as not-live, never throws", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(join(dir, ".sdk-workers", "CTL-9.json"), "{not json");
    expect(isSdkWorkerLiveOnDisk(dir, "CTL-9", { pidAlive: () => true })).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reconcileSdkRegistryOnBoot", () => {
  test("deletes dead-pid projections, keeps live-pid ones", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", pid: 11111, updatedAt: T0 }),
    );
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-2.json"),
      JSON.stringify({ ticket: "CTL-2", pid: 22222, updatedAt: T0 }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, { pidAlive: (pid) => pid === 22222 });
    expect(res.removed).toEqual(["CTL-1"]);
    expect(res.kept).toEqual(["CTL-2"]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(false);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-2.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no projection dir → clean empty result, never throws", () => {
    const dir = freshDir();
    const res = reconcileSdkRegistryOnBoot(dir);
    expect(res.removed).toEqual([]);
    expect(res.kept).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("corrupt projection is removed (unreadable = not recoverable)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(join(dir, ".sdk-workers", "CTL-9.json"), "{not json");
    const res = reconcileSdkRegistryOnBoot(dir, { pidAlive: () => true });
    expect(res.removed).toEqual(["CTL-9"]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-9.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("abort / cancel", () => {
  test("abortSdkWorker aborts the stored controller with the given reason", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    const ac = new AbortController();
    h.setAbortController(ac);
    const res = abortSdkWorker("CTL-1", "watchdog-timeout");
    expect(res).toEqual({ found: true, aborted: true });
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("watchdog-timeout");
    rmSync(dir, { recursive: true, force: true });
  });

  test("unknown ticket → {found:false}, never throws", () => {
    freshDir();
    expect(abortSdkWorker("CTL-404", "x")).toEqual({ found: false, aborted: false });
    expect(cancelSdkRun({ ticket: "CTL-404" })).toEqual({ found: false, stale: false, aborted: false });
  });

  test("abort before setAbortController: a later setAbortController aborts immediately", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    const res = abortSdkWorker("CTL-1", PREEMPTION_ABORT_REASON);
    expect(res).toEqual({ found: true, aborted: false }); // no controller yet — pending
    const ac = new AbortController();
    h.setAbortController(ac);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe(PREEMPTION_ABORT_REASON);
    rmSync(dir, { recursive: true, force: true });
  });

  test("per-retry controller swap: abort hits only the latest controller", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    h.setAbortController(ac1);
    h.setAbortController(ac2);
    abortSdkWorker("CTL-1", "x");
    expect(ac1.signal.aborted).toBe(false);
    expect(ac2.signal.aborted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancelSdkRun uses the preemption sentinel by default and marks the entry aborted", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir, { generation: 3 }));
    const ac = new AbortController();
    h.setAbortController(ac);
    const res = cancelSdkRun({ ticket: "CTL-1", generation: 3 });
    expect(res).toEqual({ found: true, stale: false, aborted: true });
    expect(ac.signal.aborted).toBe(true);
    expect(isPreemptionAbort(ac.signal.reason)).toBe(true);
    expect(h.aborted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("generation fence: a stale cancel returns {stale:true} and does NOT abort", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir, { generation: 5 }));
    const ac = new AbortController();
    h.setAbortController(ac);
    const res = cancelSdkRun({ ticket: "CTL-1", generation: 4 }); // older than the live gen
    expect(res).toEqual({ found: true, stale: true, aborted: false });
    expect(ac.signal.aborted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("generation fence fails open on non-numeric generations (parity with the signal flip)", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir, { generation: undefined }));
    const ac = new AbortController();
    h.setAbortController(ac);
    const res = cancelSdkRun({ ticket: "CTL-1", generation: 1 });
    expect(res.aborted).toBe(true); // fail-open: cancel proceeds
    h.deregister(); // don't leak module state into later files in this bun process
    rmSync(dir, { recursive: true, force: true });
  });

  // Phase B review catches — the abort must be sticky on the REGISTRATION:
  test("an abort landing between retry attempts re-arms onto the next controller (backoff-window loss)", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    const ac1 = new AbortController(); // attempt 0's controller — query already settled
    h.setAbortController(ac1);
    const res = abortSdkWorker("CTL-1", "watchdog-timeout");
    expect(res).toEqual({ found: true, aborted: true });
    // attempt 1 (post-backoff) installs a fresh controller — must abort on install
    const ac2 = new AbortController();
    h.setAbortController(ac2);
    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog-timeout");
    expect(h.aborted).toBe(true);
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a queued abort with NO reason still fires on controller install (nullish-reason drop)", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    const res = abortSdkWorker("CTL-1"); // reason undefined, no controller yet
    expect(res).toEqual({ found: true, aborted: false });
    const ac = new AbortController();
    h.setAbortController(ac);
    expect(ac.signal.aborted).toBe(true);
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a superseded handle's touch never clobbers or resurrects the projection (token fence)", () => {
    const dir = freshDir();
    let t = T0;
    const hOld = registerSdkWorker(entry(dir, { generation: 1 }), { now: () => t });
    const hNew = registerSdkWorker(entry(dir, { generation: 2 }), { now: () => t });
    t = T0 + 120_000; // far past the projection throttle
    hOld.touch(); // superseded — must NOT overwrite gen-2's projection
    expect(readProjection(dir, "CTL-1").generation).toBe(2);
    hNew.deregister(); // unlinks the projection
    hOld.touch(); // must NOT resurrect the file as a ghost
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("isPreemptionAbort recognizes the sentinel as reason string and as Error message", () => {
    expect(isPreemptionAbort(PREEMPTION_ABORT_REASON)).toBe(true);
    expect(isPreemptionAbort(new Error(PREEMPTION_ABORT_REASON))).toBe(true);
    expect(isPreemptionAbort("sdk-threw")).toBe(false);
    expect(isPreemptionAbort(undefined)).toBe(false);
  });
});

describe("session capture (CTL-1422)", () => {
  test("setSessionId records the id, exposes it, and writes the projection immediately (bypasses throttle)", () => {
    const dir = freshDir();
    let t = T0;
    const h = registerSdkWorker(entry(dir), { now: () => t });
    t = T0 + 1_000; // INSIDE the touch throttle — the session write must not wait
    h.setSessionId("sess-abc");
    expect(sdkWorkerForTicket("CTL-1").sessionId).toBe("sess-abc");
    expect(readProjection(dir, "CTL-1").sessionId).toBe("sess-abc");
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a superseded handle's setSessionId does not clobber the successor (token fence)", () => {
    const dir = freshDir();
    const hOld = registerSdkWorker(entry(dir, { generation: 1 }));
    const hNew = registerSdkWorker(entry(dir, { generation: 2 }));
    hNew.setSessionId("sess-new");
    hOld.setSessionId("sess-stale"); // superseded — must be a no-op
    expect(sdkWorkerForTicket("CTL-1").sessionId).toBe("sess-new");
    expect(readProjection(dir, "CTL-1").sessionId).toBe("sess-new");
    hNew.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reconcileSdkRegistryOnBoot harvests dead-pid projections that carry a sessionId", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", phase: "implement", sessionId: "sess-1", generation: 3, worktreePath: "/wt/a", pid: 11111, updatedAt: T0 }),
    );
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-2.json"),
      JSON.stringify({ ticket: "CTL-2", pid: 11111, updatedAt: T0 }), // dead, no session — removed, not harvested
    );
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-3.json"),
      JSON.stringify({ ticket: "CTL-3", sessionId: "sess-3", pid: 22222, updatedAt: T0 }), // pid ALIVE — kept
    );
    const res = reconcileSdkRegistryOnBoot(dir, { pidAlive: (pid) => pid === 22222, now: () => T0 + 1000 });
    expect(res.removed).toEqual(["CTL-2"]); // unharvestable only
    expect(res.kept).toEqual(["CTL-3"]);
    expect(res.harvested).toEqual([
      { ticket: "CTL-1", sessionId: "sess-1", phase: "implement", generation: 3, worktreePath: "/wt/a" },
    ]);
    // Review fix (B): the harvested projection is KEPT — it is the only durable
    // copy of the UUID until the resumed run re-registers.
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(true);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-2.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stale harvested projection (past the 48h lookback) is removed, not harvested", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-9.json"),
      JSON.stringify({ ticket: "CTL-9", sessionId: "sess-old", pid: 11111, updatedAt: T0 }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: () => false,
      now: () => T0 + WARM_HARVEST_MAX_AGE_MS + 1,
    });
    expect(res.harvested).toEqual([]);
    expect(res.removed).toEqual(["CTL-9"]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-9.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("register seeds the projection with a known resumeSession UUID (crash-before-init safety)", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir, { sessionId: "sess-warm" }), { now: () => T0 });
    expect(readProjection(dir, "CTL-1").sessionId).toBe("sess-warm");
    expect(sdkWorkerForTicket("CTL-1").sessionId).toBe("sess-warm");
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("executor attribution (CTL-1457)", () => {
  test("registerSdkWorker({executor:'codex-exec'}) carries it into the entry, projection, and publicView", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir, { executor: "codex-exec" }), { now: () => T0 });
    // publicView (sdkWorkerForTicket) exposes it for liveness/reconcile readers.
    expect(sdkWorkerForTicket("CTL-1").executor).toBe("codex-exec");
    // The disk projection carries it for cross-process readers (doctor, boot reconcile).
    expect(readProjection(dir, "CTL-1").executor).toBe("codex-exec");
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("omitted executor defaults to null (additive — pre-CTL-1457 callers unchanged)", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir), { now: () => T0 });
    expect(sdkWorkerForTicket("CTL-1").executor).toBe(null);
    expect(readProjection(dir, "CTL-1").executor).toBe(null);
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("codex child pid + orphan reap (CTL-1457 N2)", () => {
  test("setChildPid records the child pid, exposes it, and writes the projection immediately", () => {
    const dir = freshDir();
    let t = T0;
    const h = registerSdkWorker(entry(dir, { executor: "codex-exec" }), { now: () => t });
    // childPid is unknown at register time → null.
    expect(readProjection(dir, "CTL-1").childPid).toBe(null);
    t = T0 + 500; // INSIDE the touch throttle — the child-pid write must not wait
    h.setChildPid(44444);
    expect(sdkWorkerForTicket("CTL-1").childPid).toBe(44444);
    expect(readProjection(dir, "CTL-1").childPid).toBe(44444);
    // A non-integer clears it to null.
    h.setChildPid(undefined);
    expect(readProjection(dir, "CTL-1").childPid).toBe(null);
    h.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a superseded handle's setChildPid does not clobber the successor (token fence)", () => {
    const dir = freshDir();
    const hOld = registerSdkWorker(entry(dir, { generation: 1, executor: "codex-exec" }));
    const hNew = registerSdkWorker(entry(dir, { generation: 2, executor: "codex-exec" }));
    hNew.setChildPid(55555);
    hOld.setChildPid(99999); // superseded — must be a no-op
    expect(readProjection(dir, "CTL-1").childPid).toBe(55555);
    hNew.deregister();
    rmSync(dir, { recursive: true, force: true });
  });

  test("boot reconcile SIGTERMs a live orphaned codex child and reaps its projection (never warm-resumed despite a sessionId)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1", phase: "triage", sessionId: "thread-1", generation: 1,
        worktreePath: "/wt/a", pid: 11111, childPid: 33333, executor: "codex-exec", updatedAt: T0,
      }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333, // daemon 11111 DEAD, codex child 33333 ALIVE
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(killed).toEqual([33333]);
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    // A codex projection is NEVER a warm-resume candidate even with a sessionId.
    expect(res.harvested).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("boot reconcile reaps a codex projection whose child is already DEAD without a kill", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", childPid: 33333, executor: "codex-exec", pid: 11111, updatedAt: T0 }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: () => false, // both daemon + child dead
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(killed).toEqual([]);
    expect(res.killedChildren).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a STALE codex projection (past the 48h window) is reaped WITHOUT a kill (pid-reuse safety)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", childPid: 33333, executor: "codex-exec", pid: 11111, updatedAt: T0 }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      // daemon pid 11111 DEAD (so we reach the reap); child pid 33333 "alive" — but the
      // projection is stale (past 48h), so the kill is skipped for pid-reuse safety.
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + WARM_HARVEST_MAX_AGE_MS + 1,
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(killed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// CTL-2192 Phase 1 — the three-valued SDK liveness oracle.
//
// Two failure modes have shipped from a TWO-valued answer: collapsing `unknown`
// into "alive" strands a genuinely dead worker (AC2), collapsing it into "dead"
// re-claims a live one (AC1). Every branch below pins one rung of the ladder AND
// its `reason`, so a verdict stays diagnosable instead of degrading to a boolean.
// ---------------------------------------------------------------------------

function writeProj(dir, ticket, proj) {
  mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
  writeFileSync(join(dir, ".sdk-workers", `${ticket}.json`), JSON.stringify(proj));
}

describe("classifySdkWorkerLiveness (CTL-2192 Phase 1)", () => {
  test("SDK_LIVENESS is a frozen three-valued enum", () => {
    expect(SDK_LIVENESS.LIVE).toBe("live");
    expect(SDK_LIVENESS.DEAD).toBe("dead");
    expect(SDK_LIVENESS.UNKNOWN).toBe("unknown");
    expect(Object.isFrozen(SDK_LIVENESS)).toBe(true);
  });

  test("in-memory _live wins even when the projection is MISSING", () => {
    const dir = freshDir();
    // Register with no orchDir → no projection is ever written. Same-daemon
    // authority must not need a disk read at all.
    registerSdkWorker({ ticket: "CTL-1", phase: "implement", worktreePath: "/wt/ctl-1", generation: 1 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1");
    expect(v.state).toBe("live");
    expect(v.reason).toBe("in-memory");
    rmSync(dir, { recursive: true, force: true });
  });

  test("in-memory _live wins even when the projection is STALE and corrupt", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(join(dir, ".sdk-workers", "CTL-1.json"), "{ not json");
    registerSdkWorker({ ticket: "CTL-1", phase: "implement", worktreePath: "/wt/ctl-1", generation: 1 });
    expect(classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false }).state).toBe("live");
    rmSync(dir, { recursive: true, force: true });
  });

  test("ABSENT projection → unknown / no-projection (never dead)", () => {
    const dir = freshDir();
    const v = classifySdkWorkerLiveness(dir, "CTL-404", { pidAlive: () => false });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("no-projection");
    expect(v.childPid).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("CORRUPT projection → unknown / corrupt-projection (a DISTINCT reason from absent)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(join(dir, ".sdk-workers", "CTL-1.json"), "{{{ not json at all");
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("corrupt-projection");
    rmSync(dir, { recursive: true, force: true });
  });

  test("projection pid ALIVE and === selfPid but ticket NOT in _live → unknown / self-daemon-not-registered", () => {
    // A deregistered-but-not-yet-removed file. Do NOT infer death from it.
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 4242, childPid: null, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: (p) => p === 4242, selfPid: 4242 });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("self-daemon-not-registered");
    rmSync(dir, { recursive: true, force: true });
  });

  test("projection pid ALIVE but !== selfPid → unknown / foreign-daemon (never live, never dead)", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 9999, childPid: null, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: (p) => p === 9999, selfPid: 4242 });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("foreign-daemon");
    rmSync(dir, { recursive: true, force: true });
  });

  test("daemon pid DEAD but childPid ALIVE → live / orphan-child-alive (the PID-1 orphan case)", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: 33333, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: (p) => p === 33333, selfPid: 4242 });
    expect(v.state).toBe("live");
    expect(v.reason).toBe("orphan-child-alive");
    expect(v.childPid).toBe(33333);
    rmSync(dir, { recursive: true, force: true });
  });

  test("daemon pid DEAD and childPid DEAD → dead / orphan-child-dead", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: 33333, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false, selfPid: 4242 });
    expect(v.state).toBe("dead");
    expect(v.reason).toBe("orphan-child-dead");
    expect(v.childPid).toBe(33333);
    rmSync(dir, { recursive: true, force: true });
  });

  test("daemon pid DEAD, childPid null, childPidResolved TRUE → dead / no-child-resolved (we looked)", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: null, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false, selfPid: 4242 });
    expect(v.state).toBe("dead");
    expect(v.reason).toBe("no-child-resolved");
    rmSync(dir, { recursive: true, force: true });
  });

  test("LEGACY projection (dead daemon, childPid null, NO childPidResolved) → unknown, NOT dead", () => {
    // The rollout population: every projection written before Phase 2. Reading
    // it as `dead` would re-claim a live worker on the first boot after deploy.
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: null, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false, selfPid: 4242 });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("legacy-projection-no-child-record");
    rmSync(dir, { recursive: true, force: true });
  });

  test("childPidResolved present but FALSY is still legacy-shaped → unknown", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: null, childPidResolved: false, updatedAt: T0 });
    expect(classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false, selfPid: 4242 }).state).toBe("unknown");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a non-positive / non-integer childPid is NOT treated as a pid", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: 0, childPidResolved: true, updatedAt: T0 });
    // Daemon pid 11111 DEAD; EVERY other pid reads alive. childPid 0 must still
    // not be probed as a pid — otherwise a `0` would read as a live worker.
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: (p) => p !== 11111, selfPid: 4242 });
    expect(v.state).toBe("dead");
    expect(v.reason).toBe("no-child-resolved");
    expect(v.childPid).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("NEVER throws: a throwing pidAlive degrades to unknown / threw", () => {
    const dir = freshDir();
    writeProj(dir, "CTL-1", { ticket: "CTL-1", pid: 11111, childPid: 33333, childPidResolved: true, updatedAt: T0 });
    const v = classifySdkWorkerLiveness(dir, "CTL-1", {
      pidAlive: () => { throw new Error("boom"); },
      selfPid: 4242,
    });
    expect(v.state).toBe("unknown");
    expect(v.reason).toBe("threw");
    rmSync(dir, { recursive: true, force: true });
  });

  test("every branch returns a {state, reason, childPid} shape — never a bare boolean", () => {
    const dir = freshDir();
    const seen = new Set();
    const cases = [
      // absent
      () => classifySdkWorkerLiveness(dir, "CTL-ABSENT", { pidAlive: () => false, selfPid: 1 }),
      // corrupt
      () => {
        writeProj(dir, "CTL-CORRUPT", {});
        writeFileSync(join(dir, ".sdk-workers", "CTL-CORRUPT.json"), "nope");
        return classifySdkWorkerLiveness(dir, "CTL-CORRUPT", { pidAlive: () => false, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-SELF", { pid: 1, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-SELF", { pidAlive: (p) => p === 1, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-FOREIGN", { pid: 2, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-FOREIGN", { pidAlive: (p) => p === 2, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-ORPHAN-LIVE", { pid: 2, childPid: 3, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-ORPHAN-LIVE", { pidAlive: (p) => p === 3, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-ORPHAN-DEAD", { pid: 2, childPid: 3, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-ORPHAN-DEAD", { pidAlive: () => false, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-NOCHILD", { pid: 2, childPid: null, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-NOCHILD", { pidAlive: () => false, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-LEGACY", { pid: 2, childPid: null });
        return classifySdkWorkerLiveness(dir, "CTL-LEGACY", { pidAlive: () => false, selfPid: 1 });
      },
      () => {
        writeProj(dir, "CTL-THREW", { pid: 2, childPid: 3, childPidResolved: true });
        return classifySdkWorkerLiveness(dir, "CTL-THREW", { pidAlive: () => { throw new Error("x"); }, selfPid: 1 });
      },
    ];
    for (const c of cases) {
      const v = c();
      expect(typeof v).toBe("object");
      expect(["live", "dead", "unknown"]).toContain(v.state);
      expect(typeof v.reason).toBe("string");
      expect(v.reason.length).toBeGreaterThan(0);
      expect("childPid" in v).toBe(true);
      seen.add(v.reason);
    }
    // in-memory is the 10th reason, exercised above.
    registerSdkWorker({ ticket: "CTL-MEM" });
    seen.add(classifySdkWorkerLiveness(dir, "CTL-MEM").reason);
    expect([...seen].sort()).toEqual([
      "corrupt-projection",
      "foreign-daemon",
      "in-memory",
      "legacy-projection-no-child-record",
      "no-child-resolved",
      "no-projection",
      "orphan-child-alive",
      "orphan-child-dead",
      "self-daemon-not-registered",
      "threw",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
