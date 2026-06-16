// orphan-reaper-timer.test.mjs — Phase 9 of CTL-649. The periodic timer that
// emits `orphans.reap-requested` on a config-driven cadence, plus the config
// reader that threads .catalyst/config.json into it.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";

// A controllable clock: records the single registered interval and fires its
// callback once per elapsed interval when advance() is called.
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

describe("startOrphanReaperTimer", () => {
  it("emits orphans + reconcile + procOrphans reap-requested every interval (CTL-661 / CTL-1165 D2)", () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({ intervalSeconds: 600, emit: (e) => emitted.push(e), clock });
    clock.advance(600_000);
    // CTL-661: each tick drives the orphan sweep AND the per-ticket reconcile
    // sweep. CTL-1165 D2: it also fires the orphan child-process reaper trigger.
    expect(emitted).toEqual([
      "orphans.reap-requested",
      "phase.reconcile.reap-requested",
      "procOrphans.reap-requested",
    ]);
    clock.advance(600_000);
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(2);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(2);
    expect(emitted.filter((e) => e === "procOrphans.reap-requested").length).toBe(2);
  });

  it("honors a config-overridden interval", () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({ intervalSeconds: 60, emit: (e) => emitted.push(e), clock });
    clock.advance(60_000);
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
  });

  it("is a no-op when disabled", () => {
    const emitted = [];
    const clock = fakeClock();
    const handle = startOrphanReaperTimer({
      enabled: false,
      intervalSeconds: 60,
      emit: (e) => emitted.push(e),
      clock,
    });
    clock.advance(600_000);
    expect(emitted.length).toBe(0);
    expect(clock.registered()).toBeNull();
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() clears the interval", () => {
    const emitted = [];
    const clock = fakeClock();
    const handle = startOrphanReaperTimer({
      intervalSeconds: 60,
      emit: (e) => emitted.push(e),
      clock,
    });
    handle.stop();
    clock.advance(600_000);
    expect(emitted.length).toBe(0);
  });

  // CTL-1165 D3: the job-dir GC runs on the same 600s cadence, sharing the
  // tick's try/catch with the two reap emits.
  it("runs jobGc on the same tick as the two reap emits (CTL-1165 D3)", async () => {
    const emitted = [];
    let jobGcCalls = 0;
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      jobGc: async () => {
        jobGcCalls++;
      },
      clock,
    });
    clock.advance(600_000);
    // flush the async tick body
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
    expect(jobGcCalls).toBe(1);
  });

  // CTL-1165 D3: a rejecting jobGc must NOT suppress the two reap emits —
  // they share the tick's try/catch, so the emits run first (synchronously,
  // before any await) and a jobGc rejection is swallowed by the same catch.
  it("a rejecting jobGc does not suppress the two reap emits (CTL-1165 D3)", async () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      jobGc: async () => {
        throw new Error("job-gc boom");
      },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
  });

  // CTL-1205: workerGc seam is invoked each tick alongside emits + jobGc.
  it("calls workerGc on the same tick as the reap emits (CTL-1205)", async () => {
    const emitted = [];
    let workerGcCalls = 0;
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      workerGc: async () => { workerGcCalls++; },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
    expect(workerGcCalls).toBe(1);
  });

  // CTL-1205: a rejecting workerGc must NOT suppress the reap emits.
  it("a rejecting workerGc does not suppress the reap emits (CTL-1205)", async () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      workerGc: async () => { throw new Error("worker-gc boom"); },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
  });

  // CTL-1205: workerGc fires twice when two intervals elapse.
  it("calls workerGc on every tick, not just the first (CTL-1205)", async () => {
    let workerGcCalls = 0;
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async () => {},
      workerGc: async () => { workerGcCalls++; },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(workerGcCalls).toBe(2);
  });

  // CTL-1218: the wt-cleanup-queue drain runs on the same 600s cadence, sharing
  // the tick's try/catch with the reap emits + the other GCs.
  it("invokes the injected wtCleanupDrain seam each tick inside Promise.all (CTL-1218)", async () => {
    const emitted = [];
    let drainCalls = 0;
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      wtCleanupDrain: async () => { drainCalls++; },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(drainCalls).toBe(1);
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(drainCalls).toBe(2);
  });

  // CTL-1218: a rejecting wtCleanupDrain must NOT suppress the reap emits.
  it("a rejecting wtCleanupDrain does not suppress the reap emits (CTL-1218)", async () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({
      intervalSeconds: 600,
      emit: async (e) => emitted.push(e),
      wtCleanupDrain: async () => { throw new Error("drain boom"); },
      clock,
    });
    clock.advance(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.filter((e) => e === "orphans.reap-requested").length).toBe(1);
    expect(emitted.filter((e) => e === "phase.reconcile.reap-requested").length).toBe(1);
  });
});

describe("readOrphanReaperConfig", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const writeConfig = (obj) => {
    dir = mkdtempSync(join(tmpdir(), "ctl649-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it("reads catalyst.orchestration.orphanReaper", () => {
    const path = writeConfig({
      catalyst: { orchestration: { orphanReaper: { enabled: false, intervalSeconds: 120 } } },
    });
    expect(readOrphanReaperConfig(path)).toEqual({ enabled: false, intervalSeconds: 120 });
  });

  it("returns an empty object when the key is absent", () => {
    const path = writeConfig({ catalyst: { orchestration: {} } });
    expect(readOrphanReaperConfig(path)).toEqual({});
  });

  it("returns an empty object for a missing file", () => {
    expect(readOrphanReaperConfig("/no/such/config.json")).toEqual({});
  });

  it("returns an empty object for malformed JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "ctl649-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(readOrphanReaperConfig(path)).toEqual({});
  });

  it("returns {} for a null/empty path", () => {
    expect(readOrphanReaperConfig(null)).toEqual({});
    expect(readOrphanReaperConfig("")).toEqual({});
  });
});
