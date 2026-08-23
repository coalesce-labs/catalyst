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
  REAP_CONFIRM_GRACE_MS,
  REAP_CONFIRM_GRACE_CODEX_MS,
  REAP_CONFIRM_TOTAL_BUDGET_MS,
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
    // CTL-2192: the reap is now CONFIRMED, so the fake process table has to model
    // a child that actually dies — a constant-alive pid means "it ignored
    // SIGTERM", which is the reapFailed case covered separately below.
    const dead = new Set();
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333 && !dead.has(pid), // daemon 11111 DEAD, codex child 33333 ALIVE
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); dead.add(pid); return true; },
      confirmReap: (pid, { pidAlive }) => !pidAlive(pid), // defaultConfirmReap minus the sleep
      classifyChildIdentity: () => "ours", // CTL-2192 remediation: identity before signal
    });
    expect(killed).toEqual([33333]);
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    expect(res.reapFailed).toEqual([]);
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

// ---------------------------------------------------------------------------
// CTL-2192 Phase 2 — childPidResolved on the projection.
//
// The marker records THAT WE LOOKED for a child, which is what lets Phase 1's
// ladder tell "no child" (dead) from "never asked" (unknown). Without it a
// legacy projection and a semaphore-parked worker are byte-identical.
// ---------------------------------------------------------------------------

describe("childPidResolved (CTL-2192 Phase 2)", () => {
  test("a fresh registration projects childPidResolved: false — we have not looked yet", () => {
    const dir = freshDir();
    registerSdkWorker(entry(dir));
    const proj = readProjection(dir, "CTL-1");
    expect(proj.childPidResolved).toBe(false);
    expect(proj.childPid).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("setChildPid(pid) records the pid AND stamps childPidResolved: true", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    h.setChildPid(33333);
    const proj = readProjection(dir, "CTL-1");
    expect(proj.childPid).toBe(33333);
    expect(proj.childPidResolved).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("setChildPid(null) stamps childPidResolved: true with a null pid — 'we looked, there was none'", () => {
    // The semaphore-parked / two-generations-in-one-worktree cases. Recording
    // the LOOK is what makes the later verdict `dead` instead of `unknown`.
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    h.setChildPid(null);
    const proj = readProjection(dir, "CTL-1");
    expect(proj.childPid).toBe(null);
    expect(proj.childPidResolved).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a SUPERSEDED handle's setChildPid does not stamp the successor's projection", () => {
    const dir = freshDir();
    const hOld = registerSdkWorker(entry(dir, { generation: 1 }));
    registerSdkWorker(entry(dir, { generation: 2 })); // resume re-register
    hOld.setChildPid(33333);
    const proj = readProjection(dir, "CTL-1");
    expect(proj.generation).toBe(2);
    expect(proj.childPid).toBe(null);
    expect(proj.childPidResolved).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("end-to-end: a stamped projection with a dead daemon and no child classifies DEAD, not unknown", () => {
    const dir = freshDir();
    const h = registerSdkWorker(entry(dir));
    h.setChildPid(null);
    resetSdkWorkerRegistry(); // simulate the daemon bounce — in-memory is gone
    const v = classifySdkWorkerLiveness(dir, "CTL-1", { pidAlive: () => false, selfPid: process.pid + 1 });
    expect(v.state).toBe("dead");
    expect(v.reason).toBe("no-child-resolved");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// CTL-2192 Phase 4 — reap a surviving SDK orphan at boot, and CONFIRM the reap.
//
// reconcileSdkRegistryOnBoot already SIGTERMs a surviving orphaned child before
// deleting its projection — but the branch is gated on executor === "codex-exec".
// An SDK child can outlive its daemon too (measured: a 14-minute PID-1 orphan),
// and boot-resume then manufactures a fresh generation beside it. Ordering is
// load-bearing: reap first, CONFIRM the reap, and only then let the ticket be a
// resume candidate — a re-dispatch beside a still-running orphan is the harm.
// ---------------------------------------------------------------------------

describe("reconcileSdkRegistryOnBoot — sdk orphan reap (CTL-2192 Phase 4)", () => {
  test("an SDK projection with a live childPid is SIGTERM'd, not only a codex one", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333, // daemon dead, child alive
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
      confirmReap: () => true, // the child died
      classifyChildIdentity: () => "ours",
    });
    expect(killed).toEqual([33333]);
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    expect(res.reapFailed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ CONFIRMED REAP: a child still alive after the grace is reapFailed, the projection is KEPT", () => {
    // Fail CLOSED. Deleting the projection here would erase the only durable
    // pointer to a live orphan, and boot-resume would then dispatch a second
    // generation into the same worktree — two live generations, which is
    // precisely what this ticket exists to prevent.
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => true,
      confirmReap: () => false, // it ignored SIGTERM
      classifyChildIdentity: () => "ours",
    });
    expect(res.reapFailed).toEqual([{ ticket: "CTL-1", childPid: 33333, reason: "survived-sigterm" }]);
    expect(res.removed).not.toContain("CTL-1");
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a codex orphan is reaped and confirmed the same way (no behaviour split)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "codex-exec", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => true,
      confirmReap: () => false,
      classifyChildIdentity: () => "ours",
    });
    expect(res.reapFailed).toEqual([{ ticket: "CTL-1", childPid: 33333, reason: "survived-sigterm" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ the kill is NOT widened: a STALE sdk projection is reaped WITHOUT a signal (pid-reuse safety)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + WARM_HARVEST_MAX_AGE_MS + 1, // past the freshness window
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(killed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ a projection with NO childPid is never signalled — no freshness evidence, no kill", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: null, updatedAt: T0 }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: () => false,
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(killed).toEqual([]);
    expect(res.reapFailed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a WARM-HARVESTABLE sdk projection is harvested and never reaped (it has no live child)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: null,
        sessionId: "sess-uuid", phase: "implement", generation: 1, updatedAt: T0,
      }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: () => false,
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
    });
    expect(res.harvested.map((h) => h.ticket)).toEqual(["CTL-1"]);
    expect(killed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ a warm-harvestable projection whose orphan is STILL ALIVE is reaped first, not harvested", () => {
    // Warm-resuming a session whose process is still running would put two live
    // generations in one worktree — the reap decision has to come first.
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333,
        sessionId: "sess-uuid", phase: "implement", generation: 1, updatedAt: T0,
      }),
    );
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
      confirmReap: () => true,
      classifyChildIdentity: () => "ours", // CTL-2192 remediation: identity before signal
    });
    expect(killed).toEqual([33333]);
    expect(res.harvested.map((h) => h.ticket)).toEqual(["CTL-1"]); // warm AFTER a confirmed reap
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ a warm candidate whose reap FAILED is not harvested and not removed", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333,
        sessionId: "sess-uuid", phase: "implement", generation: 1, updatedAt: T0,
      }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => true,
      confirmReap: () => false,
      classifyChildIdentity: () => "ours",
    });
    expect(res.reapFailed.map((r) => r.ticket)).toEqual(["CTL-1"]);
    expect(res.harvested).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reapFailed is always an array, even on an empty/absent projection dir", () => {
    const dir = freshDir();
    expect(reconcileSdkRegistryOnBoot(dir).reapFailed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("defaultConfirmReap (CTL-2192 Phase 4)", () => {
  test("reports the reap CONFIRMED only when the pid is actually gone", () => {
    // Exercised through reconcileSdkRegistryOnBoot with no confirmReap injected,
    // so the real default (bounded sync grace + re-probe) runs. Short-graced by
    // the fake table flipping immediately; the assertion is the verdict, not the
    // wall-clock.
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const dead = new Set();
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333 && !dead.has(pid),
      now: () => T0 + 1000,
      killChild: (pid) => { dead.add(pid); return true; },
      classifyChildIdentity: () => "ours",
    });
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    expect(res.reapFailed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a killChild that could NOT deliver the signal is reapFailed, not a silent success", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, updatedAt: T0 }),
    );
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => false, // EPERM / already reaped by someone else
      classifyChildIdentity: () => "ours",
    });
    expect(res.killedChildren).toEqual([]);
    expect(res.reapFailed).toEqual([{ ticket: "CTL-1", childPid: 33333, reason: "signal-failed" }]);
    expect(res.removed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── CTL-2192 (remediation): identity before signal ─────────────────────────
//
// This ticket widened the population the boot reap SIGNALS from codex-only
// (~0 on a pure sdk/bg fleet — the file's own comment said so) to EVERY sdk
// projection, while the only guard on the target was `kill -0` plus the 48 h
// warm-harvest window. `kill -0` proves a pid ANSWERS, not that it is ours, and
// the same stale pid is re-probed on every boot for as long as the projection
// lives. The repo already holds this discipline for pid files: "matched by
// process identity, not just kill -0 ... a recycled pid is never a kill target."
describe("boot reap — identity before signal (CTL-2192 remediation)", () => {
  function writeProj(dir, over = {}) {
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333,
        worktreePath: "/wt/CTL-1", updatedAt: T0, ...over,
      }),
    );
  }

  test("⛔ a REUSED pid (cwd is not our worktree) is NEVER signalled", () => {
    const dir = freshDir();
    writeProj(dir);
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
      classifyChildIdentity: () => "foreign",
    });
    expect(killed).toEqual([]);
    // Our child is gone, so the projection takes the ordinary removal path —
    // the stranger is left alone AND the ticket is not stranded.
    expect(res.reapFailed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ an UNVERIFIABLE identity is neither signalled nor concluded — fail CLOSED", () => {
    // cwd unreadable (no usable lsof at boot). We cannot prove the pid is ours,
    // so we must not signal it; and we cannot prove our child is gone, so we
    // must not delete the only durable pointer to it either.
    const dir = freshDir();
    writeProj(dir);
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); return true; },
      classifyChildIdentity: () => "unverifiable",
    });
    expect(killed).toEqual([]);
    expect(res.reapFailed).toEqual([{ ticket: "CTL-1", childPid: 33333, reason: "identity-unverifiable" }]);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // ⛔ POSITIVE CONTROL: the two above must not be passing because the reap was
  // simply disabled.
  test("positive control — a CONFIRMED-OURS identity is still signalled and reaped", () => {
    const dir = freshDir();
    writeProj(dir);
    const killed = [];
    const dead = new Set();
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333 && !dead.has(pid),
      now: () => T0 + 1000,
      killChild: (pid) => { killed.push(pid); dead.add(pid); return true; },
      classifyChildIdentity: () => "ours",
    });
    expect(killed).toEqual([33333]);
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the identity probe is asked about THIS projection's pid and worktreePath", () => {
    const dir = freshDir();
    writeProj(dir, { worktreePath: "/wt/somewhere" });
    const asked = [];
    reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => true,
      confirmReap: () => true,
      classifyChildIdentity: (pid, wt) => { asked.push([pid, wt]); return "ours"; },
    });
    expect(asked).toEqual([[33333, "/wt/somewhere"]]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ the STALE-projection hole: a >48h projection whose child is ALIVE and OURS is kept, not deleted", () => {
    // `fresh` gates both the reap and the harvest, so the fall-through was
    // rmSync — deleting the only pointer to a running worker, after which the
    // oracle answers no-projection and boot-resume cold-dispatches a SECOND
    // generation into that worktree. No signal (the plan's rule is "no freshness
    // evidence, no kill"); the ticket is simply excluded until the child exits.
    const dir = freshDir();
    writeProj(dir);
    const killed = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + WARM_HARVEST_MAX_AGE_MS + 1,
      killChild: (pid) => { killed.push(pid); return true; },
      classifyChildIdentity: () => "ours",
    });
    expect(killed).toEqual([]);
    expect(res.reapFailed).toEqual([{ ticket: "CTL-1", childPid: 33333, reason: "stale-projection-child-alive" }]);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(dir, ".sdk-workers", "CTL-1.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("…but a stale projection whose pid is UNVERIFIABLE keeps the pre-existing deletion", () => {
    // At >48h the pid-reuse prior dominates, so an unattributable pid must not
    // strand the ticket. Deliberately narrower than the confirmed-ours branch.
    const dir = freshDir();
    writeProj(dir);
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + WARM_HARVEST_MAX_AGE_MS + 1,
      killChild: () => true,
      classifyChildIdentity: () => "unverifiable",
    });
    expect(res.reapFailed).toEqual([]);
    expect(res.removed).toEqual(["CTL-1"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("boot reap — the confirm has an AGGREGATE bound (CTL-2192 remediation)", () => {
  test("⛔ N surviving orphans share ONE deadline, they do not each pay the grace", () => {
    // defaultConfirmReap blocks the daemon's event loop synchronously, inside
    // startDaemon's boot block and AFTER the pid file is published — so every
    // liveness consumer reads the frozen process as healthy while it waits. A
    // host bounced with N saturated slots whose children all survive used to pay
    // N x grace with no aggregate cap at all.
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    for (const t of ["CTL-1", "CTL-2", "CTL-3", "CTL-4", "CTL-5", "CTL-6"]) {
      writeFileSync(
        join(dir, ".sdk-workers", `${t}.json`),
        JSON.stringify({ ticket: t, executor: "sdk", pid: 11111, childPid: 33333, worktreePath: `/wt/${t}`, updatedAt: T0 }),
      );
    }
    // A virtual clock: confirmReap "spends" exactly the grace it was handed.
    let clock = T0 + 1000;
    let totalSpent = 0;
    const grants = [];
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => clock,
      killChild: () => true,
      classifyChildIdentity: () => "ours",
      confirmTotalBudgetMs: 5_000,
      confirmGraceMs: 2_000,
      confirmGraceCodexMs: 2_000,
      confirmReap: (_pid, { graceMs }) => {
        grants.push(graceMs);
        clock += graceMs;
        totalSpent += graceMs;
        return false; // every child survives — the worst case
      },
    });
    expect(res.reapFailed).toHaveLength(6);
    expect(totalSpent).toBeLessThanOrEqual(5_000);
    // …and the tail is granted ZERO, which still probes (fail CLOSED), rather
    // than being skipped or granted the full grace.
    expect(grants.slice(0, 2)).toEqual([2_000, 2_000]);
    expect(grants[grants.length - 1]).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the CODEX grace is longer than the sdk one (the regressed path)", () => {
    // Pre-ticket a codex orphan was SIGTERM'd and removed with NO confirmation,
    // so a child that flushes and exits at t+3s newly read as reapFailed — one
    // boot of lost work for a child that died normally a second later. The
    // confirm POLLS, so the longer grace is only paid by a child that lingers.
    expect(REAP_CONFIRM_GRACE_CODEX_MS).toBeGreaterThan(REAP_CONFIRM_GRACE_MS);
    expect(REAP_CONFIRM_TOTAL_BUDGET_MS).toBeGreaterThanOrEqual(REAP_CONFIRM_GRACE_CODEX_MS);

    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "codex-exec", pid: 11111, childPid: 33333, worktreePath: "/wt/CTL-1", updatedAt: T0 }),
    );
    const grants = [];
    reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333,
      now: () => T0 + 1000,
      killChild: () => true,
      classifyChildIdentity: () => "ours",
      confirmReap: (_pid, { graceMs }) => { grants.push(graceMs); return true; },
    });
    expect(grants).toEqual([REAP_CONFIRM_GRACE_CODEX_MS]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the real defaultConfirmReap POLLS — a child that exits early returns well before the grace", () => {
    // Wall-clock assertion on the REAL default (no confirmReap injected). The
    // child is dead from the start, so a sleep-the-whole-grace implementation
    // would take >= REAP_CONFIRM_GRACE_MS; a polling one returns at once.
    const dir = freshDir();
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(dir, ".sdk-workers", "CTL-1.json"),
      JSON.stringify({ ticket: "CTL-1", executor: "sdk", pid: 11111, childPid: 33333, worktreePath: "/wt/CTL-1", updatedAt: T0 }),
    );
    const dead = new Set();
    const started = Date.now();
    const res = reconcileSdkRegistryOnBoot(dir, {
      pidAlive: (pid) => pid === 33333 && !dead.has(pid),
      now: () => T0 + 1000,
      killChild: (pid) => { dead.add(pid); return true; },
      classifyChildIdentity: () => "ours",
    });
    const elapsed = Date.now() - started;
    expect(res.killedChildren).toEqual([{ ticket: "CTL-1", childPid: 33333 }]);
    expect(elapsed).toBeLessThan(REAP_CONFIRM_GRACE_MS);
    rmSync(dir, { recursive: true, force: true });
  });
});
