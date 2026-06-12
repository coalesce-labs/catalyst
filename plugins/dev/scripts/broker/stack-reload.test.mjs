// Unit tests for stack-reload.mjs (CTL-1077).
//
// On a merge-to-main that advances the plugin-source checkout, the broker
// restarts the monitor and execution-core daemon automatically, records a
// deploy event with old/new SHAs, debounces under merge trains, and
// self-reloads with a gap-free tail-offset handoff when the broker's own
// code changed.
//
// All OS/process/timer/clock interactions are injected seams — no real
// processes, timers, or log files. Mirrors the plugin-refresh.mjs /
// gc-liveness.mjs seam-injection convention.
//
// Run: bun test plugins/dev/scripts/broker/stack-reload.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import {
  decideStackReload,
  handleStackReloadEvent,
  __clearReloadStateForTest,
  STACK_RELOAD_DEBOUNCE_MS,
} from "./stack-reload.mjs";

// ─── fake-timer helper ───────────────────────────────────────────────────────

function makeFakeTimers() {
  let now = 0;
  const pending = [];
  let nextId = 1;
  return {
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      pending.push({ id, fireAt: now + (delay || 0), fn, active: true });
      return id;
    },
    clearTimeoutFn: (id) => {
      const t = pending.find((p) => p.id === id);
      if (t) t.active = false;
    },
    advance: (ms) => {
      now += ms;
      // Fire in order of fireAt (earliest first).
      const toFire = pending
        .filter((t) => t.active && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of toFire) {
        t.active = false;
        t.fn();
      }
    },
  };
}

// Immediate-fire seam: replaces debounce with synchronous execution.
const immediate = {
  setTimeoutFn: (fn) => { fn(); return 0; },
  clearTimeoutFn: () => {},
};

// ─── decideStackReload ───────────────────────────────────────────────────────

describe("decideStackReload", () => {
  test("checkout changed → reload monitor + execution-core", () => {
    const d = decideStackReload({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: false }],
      loadedCommitRoot: "/co",
    });
    expect(d.shouldReload).toBe(true);
    expect(d.components.map((c) => c.name).sort()).toEqual(["execution-core", "monitor"]);
    expect(d.brokerSelfReload).toBe(false);
    expect(d.components.find((c) => c.name === "monitor").oldSha).toBe("a");
    expect(d.components.find((c) => c.name === "monitor").newSha).toBe("b");
  });

  test("no change → no reload", () => {
    const d = decideStackReload({
      results: [{ root: "/co", oldSha: "a", newSha: "a", changed: false, restartNeeded: false }],
      loadedCommitRoot: "/co",
    });
    expect(d.shouldReload).toBe(false);
    expect(d.components).toEqual([]);
  });

  test("throttled result is ignored", () => {
    const d = decideStackReload({
      results: [{ root: "/co", changed: false, throttled: true }],
      loadedCommitRoot: "/co",
    });
    expect(d.shouldReload).toBe(false);
  });

  test("failed result is ignored", () => {
    const d = decideStackReload({
      results: [{ root: "/co", changed: false, failed: true }],
      loadedCommitRoot: "/co",
    });
    expect(d.shouldReload).toBe(false);
  });

  test("restartNeeded for broker's own root → brokerSelfReload true", () => {
    const d = decideStackReload({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
    });
    expect(d.brokerSelfReload).toBe(true);
  });

  test("restartNeeded for a different root → brokerSelfReload false", () => {
    const d = decideStackReload({
      results: [{ root: "/other", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
    });
    expect(d.brokerSelfReload).toBe(false);
  });

  test("empty results → no reload", () => {
    const d = decideStackReload({ results: [], loadedCommitRoot: "/co" });
    expect(d.shouldReload).toBe(false);
    expect(d.components).toEqual([]);
    expect(d.brokerSelfReload).toBe(false);
  });

  test("null/undefined results → no reload (safe default)", () => {
    const d = decideStackReload({ results: undefined, loadedCommitRoot: "/co" });
    expect(d.shouldReload).toBe(false);
  });
});

// ─── handleStackReloadEvent (Phase 1: spawn + emit) ─────────────────────────

describe("handleStackReloadEvent — spawn + emit (Tier 1)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("spawns monitor + execution-core restart and emits deploy events", () => {
    const spawned = [];
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: false }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push(`${cmd} ${args.join(" ")}`),
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    expect(spawned.some((s) => s.includes("catalyst-monitor restart"))).toBe(true);
    expect(spawned.some((s) => s.includes("catalyst-execution-core restart"))).toBe(true);
    const names = emitted.map((e) => e.event);
    expect(names).toContain("stack.reload.started");
    expect(names).toContain("stack.reload.complete");
    const complete = emitted.find((e) => e.event === "stack.reload.complete");
    expect(complete.detail.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "monitor", old_sha: "a", new_sha: "b" }),
        expect.objectContaining({ name: "execution-core", old_sha: "a", new_sha: "b" }),
      ])
    );
  });

  test("no change → nothing spawned, nothing emitted", () => {
    const spawned = [];
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "a", changed: false }],
      loadedCommitRoot: "/co",
      spawnFn: (c, a) => spawned.push(`${c} ${a.join(" ")}`),
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    expect(spawned).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("spawnFn errors never throw out of the handler (best-effort)", () => {
    expect(() =>
      handleStackReloadEvent({
        results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
        loadedCommitRoot: "/co",
        spawnFn: () => { throw new Error("boom"); },
        emitFn: () => {},
        now: 1000,
        ...immediate,
      })
    ).not.toThrow();
  });

  test("null/undefined results → no spawn, no emit", () => {
    const spawned = [];
    handleStackReloadEvent({
      results: null,
      loadedCommitRoot: "/co",
      spawnFn: (c, a) => spawned.push(`${c} ${a.join(" ")}`),
      emitFn: () => {},
      now: 1000,
      ...immediate,
    });
    expect(spawned).toEqual([]);
  });
});

// ─── exec-core reload uses resume-safe restart, never kill (Phase 4) ────────

describe("non-disruption contract (Phase 4)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("exec-core reload uses the resume-safe restart command, never kill", () => {
    const spawned = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push(`${cmd} ${args.join(" ")}`),
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(spawned).toContain("catalyst-execution-core restart");
    expect(spawned.some((s) => /kill|pkill|SIGKILL|-9/.test(s))).toBe(false);
  });
});

// ─── trailing debounce (Phase 2) ────────────────────────────────────────────

describe("trailing debounce — merge trains (Tier 2)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("three changes within the window coalesce to one reload after the last", () => {
    const reloads = [];
    const timers = makeFakeTimers();
    const opts = (n) => ({
      results: [{ root: "/co", oldSha: "a", newSha: "b" + n, changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => reloads.push(cmd),
      emitFn: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    handleStackReloadEvent({ ...opts(1), now: 0 });
    timers.advance(10_000);
    handleStackReloadEvent({ ...opts(2), now: 10_000 });
    timers.advance(10_000);
    handleStackReloadEvent({ ...opts(3), now: 20_000 });
    expect(reloads).toEqual([]);
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(reloads.filter((c) => c === "catalyst-monitor").length).toBe(1);
    expect(reloads.filter((c) => c === "catalyst-execution-core").length).toBe(1);
  });

  test("a single change reloads after the debounce window", () => {
    const reloads = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (c) => reloads.push(c),
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(reloads).toEqual([]);
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(reloads.length).toBe(2);
  });

  test("the last change's newSha wins in the deploy event", () => {
    const emitted = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b1", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      emitFn: (e) => emitted.push(e),
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(5_000);
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b2", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      emitFn: (e) => emitted.push(e),
      now: 5_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    const complete = emitted.find((e) => e.event === "stack.reload.complete");
    expect(complete).toBeDefined();
    const mon = complete.detail.components.find((c) => c.name === "monitor");
    expect(mon.new_sha).toBe("b2");
  });
});

// ─── broker self-reload with gap-free tail handoff (Phase 3) ────────────────

describe("broker self-reload (Tier 2)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("restartNeeded for broker root → writes handoff and spawns catalyst-broker restart", () => {
    const spawned = [];
    const handoffs = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      writeHandoffFn: (h) => handoffs.push(h),
      currentByteOffset: 4096,
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(handoffs.length).toBe(1);
    expect(handoffs[0]).toMatchObject({ byteOffset: 4096 });
    expect(spawned.some((c) => c === "catalyst-broker")).toBe(true);
  });

  test("restartNeeded false → no broker restart, no handoff", () => {
    const spawned = [];
    const handoffs = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: false }],
      loadedCommitRoot: "/co",
      spawnFn: (c) => spawned.push(c),
      writeHandoffFn: (h) => handoffs.push(h),
      currentByteOffset: 10,
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(handoffs).toEqual([]);
    expect(spawned.some((c) => c === "catalyst-broker")).toBe(false);
  });

  test("writeHandoffFn errors do not throw out of the handler (best-effort)", () => {
    const timers = makeFakeTimers();
    expect(() => {
      handleStackReloadEvent({
        results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
        loadedCommitRoot: "/co",
        spawnFn: () => {},
        writeHandoffFn: () => { throw new Error("disk full"); },
        currentByteOffset: 0,
        emitFn: () => {},
        now: 0,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    }).not.toThrow();
  });
});

// ─── resolveBootByteOffset ───────────────────────────────────────────────────

describe("resolveBootByteOffset", () => {
  // Lazily imported from index.mjs to avoid circular dep in this module.
  let resolveBootByteOffset;
  beforeEach(async () => {
    ({ resolveBootByteOffset } = await import("./index.mjs"));
  });

  test("prefers a fresh handoff over EOF", () => {
    const eof = 9000;
    expect(
      resolveBootByteOffset({
        handoff: { logPath: "/ev.jsonl", byteOffset: 4096, ts: 1000 },
        logPath: "/ev.jsonl",
        eofSize: eof,
        now: 1500,
        maxAgeMs: 60_000,
      })
    ).toBe(4096);
  });

  test("stale handoff → falls back to EOF", () => {
    const eof = 9000;
    expect(
      resolveBootByteOffset({
        handoff: { logPath: "/ev.jsonl", byteOffset: 4096, ts: 1000 },
        logPath: "/ev.jsonl",
        eofSize: eof,
        now: 999_999,
        maxAgeMs: 60_000,
      })
    ).toBe(eof);
  });

  test("different logPath → falls back to EOF", () => {
    const eof = 9000;
    expect(
      resolveBootByteOffset({
        handoff: { logPath: "/other.jsonl", byteOffset: 4096, ts: 1000 },
        logPath: "/ev.jsonl",
        eofSize: eof,
        now: 1500,
        maxAgeMs: 60_000,
      })
    ).toBe(eof);
  });

  test("no handoff → falls back to EOF", () => {
    const eof = 9000;
    expect(
      resolveBootByteOffset({ handoff: null, logPath: "/ev.jsonl", eofSize: eof })
    ).toBe(eof);
  });
});
