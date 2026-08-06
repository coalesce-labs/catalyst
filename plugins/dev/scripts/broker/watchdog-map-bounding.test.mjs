// watchdog-map-bounding.test.mjs — CTL-1516. Proves the two previously-unbounded
// broker maps are now bounded: _emittedWakeCache is swept of expired entries every
// watchdog tick, and lastHeartbeat / workerToOrchestrator rows are evicted once a
// session is confirmed done. These guards go RED on the pre-fix code (nothing was
// ever deleted) and GREEN after.
//
// Harness mirrors index.test.mjs: redirect CATALYST_DIR + HOME to a temp dir so the
// tick's heartbeat log / any appendEvent never touches the production event log,
// and clear all shared module state between tests.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWatchdogTick,
  getLastHeartbeat,
  getWorkerToOrchestrator,
  clearInterests,
  clearLastHeartbeat,
  clearWaitingSessionsMap,
  __clearEmittedWakeCacheForTest,
} from "./index.mjs";
// New CTL-1516 seams live on router.mjs (deliberately not added to the index.mjs
// barrel, so barrel-exports.test.mjs's fixed export count stays green).
import {
  sweepEmittedWakeCache,
  __seedEmittedWakeForTest,
  __emittedWakeCacheSizeForTest,
} from "./router.mjs";

let tmpDir;
let savedHome;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-mapbound-"));
  process.env.CATALYST_DIR = tmpDir;
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  clearInterests();
  clearLastHeartbeat();
  clearWaitingSessionsMap();
  __clearEmittedWakeCacheForTest();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.CATALYST_DIR;
  clearLastHeartbeat();
  __clearEmittedWakeCacheForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("CTL-1516 — _emittedWakeCache expiry sweep", () => {
  test("sweeps expired keys, keeps live ones (bounded, not N)", () => {
    const now = 1_000_000;
    // 100 already-expired entries (the pre-fix leak: per-event-unique keys that
    // are never overwritten and were never deleted) + 5 still-live entries.
    for (let i = 0; i < 100; i++) __seedEmittedWakeForTest(`evt-${i}:int`, now - 1);
    for (let i = 0; i < 5; i++) __seedEmittedWakeForTest(`live-${i}:int`, now + 60_000);
    expect(__emittedWakeCacheSizeForTest()).toBe(105);

    sweepEmittedWakeCache(now);

    // Only the 5 live entries survive — the map is bounded to live wakes, not 105.
    expect(__emittedWakeCacheSizeForTest()).toBe(5);
  });

  test("an entry expiring exactly at now is swept (expiry <= now)", () => {
    __seedEmittedWakeForTest("boundary:int", 500);
    sweepEmittedWakeCache(500);
    expect(__emittedWakeCacheSizeForTest()).toBe(0);
  });

  test("runWatchdogTick performs the sweep as part of a normal tick", () => {
    __seedEmittedWakeForTest("stale:int", Date.now() - 1); // already expired
    __seedEmittedWakeForTest("fresh:int", Date.now() + 60_000);
    runWatchdogTick({ liveness: () => "alive" });
    expect(__emittedWakeCacheSizeForTest()).toBe(1); // only the fresh entry remains
  });
});

describe("CTL-1516 — runWatchdogTick evicts finished-session map rows", () => {
  test("a dead session's heartbeat + orchestrator rows are deleted", () => {
    const hb = getLastHeartbeat();
    const w2o = getWorkerToOrchestrator();
    hb.set("sess-dead", { ts: Date.now(), notified: false });
    w2o.set("sess-dead", "orch-x");
    expect(hb.has("sess-dead")).toBe(true);

    // No registered interest matches it, so pre-fix it lingered forever; the
    // backstop eviction drops it because `claude agents` reports it dead.
    runWatchdogTick({ liveness: () => "dead" });

    expect(hb.has("sess-dead")).toBe(false);
    expect(w2o.has("sess-dead")).toBe(false);
  });

  test("an alive session's rows are preserved", () => {
    const hb = getLastHeartbeat();
    const w2o = getWorkerToOrchestrator();
    hb.set("sess-alive", { ts: Date.now(), notified: false });
    w2o.set("sess-alive", "orch-y");

    runWatchdogTick({ liveness: () => "alive" });

    expect(hb.has("sess-alive")).toBe(true);
    expect(w2o.has("sess-alive")).toBe(true);
  });

  test("an unknown-liveness session that is not yet stale is NOT evicted (eviction requires staleness)", () => {
    const hb = getLastHeartbeat();
    const w2o = getWorkerToOrchestrator();
    // Fresh heartbeat + liveness "unknown" → not stale → the age-based backstop
    // must not drop its heartbeat row before it becomes stale (Codex P2 on #2728:
    // guards against evicting before the configured stale threshold is reached).
    hb.set("sess-unknown-fresh", { ts: Date.now(), notified: false });
    w2o.set("sess-unknown-fresh", "orch-z");

    runWatchdogTick({ liveness: () => "unknown" });

    expect(hb.has("sess-unknown-fresh")).toBe(true);
    expect(w2o.has("sess-unknown-fresh")).toBe(true);
  });

  test("maps stay bounded across many per-tick-unique dead sessions", () => {
    const hb = getLastHeartbeat();
    const w2o = getWorkerToOrchestrator();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 20; i++) {
        const id = `sess-${round}-${i}`;
        hb.set(id, { ts: Date.now(), notified: false });
        w2o.set(id, "orch-x");
      }
      runWatchdogTick({ liveness: () => "dead" });
    }
    // Every round's 20 unique dead sessions were evicted that tick — the maps
    // never accumulate 100 rows the way the pre-fix code did.
    expect(hb.size).toBe(0);
    expect(w2o.size).toBe(0);
  });
});
