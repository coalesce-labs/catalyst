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
    rmSync(dir, { recursive: true, force: true });
  });

  test("isPreemptionAbort recognizes the sentinel as reason string and as Error message", () => {
    expect(isPreemptionAbort(PREEMPTION_ABORT_REASON)).toBe(true);
    expect(isPreemptionAbort(new Error(PREEMPTION_ABORT_REASON))).toBe(true);
    expect(isPreemptionAbort("sdk-threw")).toBe(false);
    expect(isPreemptionAbort(undefined)).toBe(false);
  });
});
