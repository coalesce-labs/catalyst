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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  decideStackReload,
  handleStackReloadEvent,
  __clearReloadStateForTest,
  STACK_RELOAD_DEBOUNCE_MS,
  STACK_RELOAD_CONFIRM_POLL_MS,
  pidFilePathForComponent,
  defaultIsRunningFn,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      isRunningFn: () => true,
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
        confirmFn: () => true,
        isRunningFn: () => true,
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
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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

// ─── restart confirmation gating (CTL-1077 remediate) ───────────────────────
//
// The original code emitted stack.reload.complete UNCONDITIONALLY right after a
// fire-and-forget detached restart. A restart that raced its own stop hit
// EADDRINUSE and left the component DOWN (~90 s observed) while the event log
// falsely reported success. performReload now confirms each restart came back
// (confirmFn), retries once, and emits stack.reload.degraded — not complete —
// when a component cannot be confirmed.
describe("restart confirmation gating (CTL-1077 remediate)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("an unconfirmable component → degraded event (not complete) + retry once", () => {
    const emitted = [];
    const spawned = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push(`${cmd} ${args.join(" ")}`),
      confirmFn: (c) => c.name !== "monitor", // monitor never rebinds its port
      isRunningFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    const names = emitted.map((e) => e.event);
    expect(names).toContain("stack.reload.started");
    expect(names).toContain("stack.reload.degraded");
    expect(names).not.toContain("stack.reload.complete");
    const degraded = emitted.find((e) => e.event === "stack.reload.degraded");
    expect(degraded.detail.reason).toBe("restart_not_confirmed");
    expect(degraded.detail.unconfirmed.map((c) => c.name)).toContain("monitor");
    expect(degraded.detail.confirmed).toContain("execution-core");
    // monitor was retried once before being declared degraded; exec-core, confirmed
    // on the first probe, was spawned exactly once.
    expect(spawned.filter((s) => s === "catalyst-monitor restart").length).toBe(2);
    expect(spawned.filter((s) => s === "catalyst-execution-core restart").length).toBe(1);
  });

  test("retry-once recovers a slow restart → complete, restart spawned twice", () => {
    const emitted = [];
    const spawned = [];
    const calls = {};
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push(`${cmd} ${args.join(" ")}`),
      // monitor: first confirm fails, second (after the retry) succeeds.
      confirmFn: (c) => {
        calls[c.name] = (calls[c.name] || 0) + 1;
        return c.name !== "monitor" || calls[c.name] >= 2;
      },
      isRunningFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    const names = emitted.map((e) => e.event);
    expect(names).toContain("stack.reload.complete");
    expect(names).not.toContain("stack.reload.degraded");
    expect(spawned.filter((s) => s === "catalyst-monitor restart").length).toBe(2);
  });

  test("all components confirmed → complete (the happy path)", () => {
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      confirmFn: () => true,
      isRunningFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    const names = emitted.map((e) => e.event);
    expect(names).toContain("stack.reload.complete");
    expect(names).not.toContain("stack.reload.degraded");
  });

  test("a throwing confirmFn is treated as unconfirmed (best-effort, no throw)", () => {
    const emitted = [];
    expect(() =>
      handleStackReloadEvent({
        results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
        loadedCommitRoot: "/co",
        spawnFn: () => {},
        confirmFn: () => { throw new Error("lsof boom"); },
        isRunningFn: () => true,
        emitFn: (e) => emitted.push(e),
        now: 1000,
        ...immediate,
      })
    ).not.toThrow();
    expect(emitted.map((e) => e.event)).toContain("stack.reload.degraded");
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
      confirmFn: () => true,
      isRunningFn: () => true,
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
        confirmFn: () => true,
        isRunningFn: () => true,
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

  // CTL-1077 remediate (M4): the default freshness budget is widened to 5 min so a
  // self-restart that lands >60 s after the handoff write (the ~90 s EADDRINUSE
  // race the confirm path documents) still resumes from the saved offset instead
  // of reseeding to EOF and dropping the restart-gap events.
  test("default maxAgeMs accepts a handoff ~90 s old (was rejected at the old 60 s budget)", () => {
    const eof = 9000;
    // No maxAgeMs passed → exercises the production default.
    expect(
      resolveBootByteOffset({
        handoff: { logPath: "/ev.jsonl", byteOffset: 4096, ts: 0 },
        logPath: "/ev.jsonl",
        eofSize: eof,
        now: 90_000, // 90 s after the handoff write
      })
    ).toBe(4096);
  });

  test("default maxAgeMs still rejects a genuinely stale handoff (>5 min)", () => {
    const eof = 9000;
    expect(
      resolveBootByteOffset({
        handoff: { logPath: "/ev.jsonl", byteOffset: 4096, ts: 0 },
        logPath: "/ev.jsonl",
        eofSize: eof,
        now: 6 * 60_000, // 6 min after the handoff write
      })
    ).toBe(eof);
  });
});

// ─── parseBootHandoff (CTL-1077 remediate #8) ────────────────────────────────
//
// Extracted from main()'s inline boot block into a seam-injected helper so the
// corrupt-warn branch and the ENOENT-is-silent branch have direct coverage (the
// verify coverage finding: only the pure resolveBootByteOffset was tested before;
// the fs-touching boot parse had no seam).
describe("parseBootHandoff", () => {
  let parseBootHandoff;
  beforeEach(async () => {
    ({ parseBootHandoff } = await import("./index.mjs"));
  });

  test("valid handoff → parsed object", () => {
    const handoff = { logPath: "/ev.jsonl", byteOffset: 4096, ts: 1000 };
    const result = parseBootHandoff({
      handoffPath: "/h.json",
      readFileFn: () => JSON.stringify(handoff),
      log: { warn: () => {} },
    });
    expect(result).toEqual(handoff);
  });

  test("missing handoff (ENOENT) → null, NO warn (normal no-reload case)", () => {
    const warns = [];
    const result = parseBootHandoff({
      handoffPath: "/h.json",
      readFileFn: () => {
        const err = new Error("ENOENT: no such file");
        err.code = "ENOENT";
        throw err;
      },
      log: { warn: (...a) => warns.push(a) },
    });
    expect(result).toBeNull();
    expect(warns.length).toBe(0);
  });

  test("corrupt handoff → null AND warns (gap-drop must be observable)", () => {
    const warns = [];
    const result = parseBootHandoff({
      handoffPath: "/h.json",
      readFileFn: () => "{not valid json",
      log: { warn: (...a) => warns.push(a) },
    });
    expect(result).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("non-ENOENT read error (e.g. EACCES) → null AND warns", () => {
    const warns = [];
    const result = parseBootHandoff({
      handoffPath: "/h.json",
      readFileFn: () => {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      },
      log: { warn: (...a) => warns.push(a) },
    });
    expect(result).toBeNull();
    expect(warns.length).toBe(1);
  });
});

// ─── self-reload handoff round-trip (CTL-1077 remediate) ─────────────────────
//
// Guards the wiring the unit seams could not: the handoff written by
// handleStackReloadEvent must carry the real logPath so the successor's
// resolveBootByteOffset resumes the saved byteOffset instead of reseeding to
// EOF. Verify caught that router.mjs omitted logPath at the call site, so the
// handoff recorded logPath:"" and the boot-time guard `handoff.logPath !== logPath`
// was ALWAYS true → silent fallback to EOF → events appended during the restart
// gap dropped. This exercises write → boot end-to-end so that omission cannot
// regress silently again.
describe("self-reload handoff round-trip (write → resolveBootByteOffset)", () => {
  let resolveBootByteOffset;
  beforeEach(async () => {
    __clearReloadStateForTest();
    ({ resolveBootByteOffset } = await import("./index.mjs"));
  });

  function captureHandoff({ logPath, nowFn }) {
    const handoffs = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      confirmFn: () => true,
      writeHandoffFn: (h) => handoffs.push(h),
      currentByteOffset: 4096,
      emitFn: () => {},
      now: 1000,
      ...(nowFn ? { nowFn } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    return handoffs[0];
  }

  test("real logPath threaded through → successor resumes the saved byteOffset (not EOF)", () => {
    const realLogPath = "/Users/x/catalyst/events/2026-06.jsonl";
    const handoff = captureHandoff({ logPath: realLogPath, nowFn: () => 5000 });
    expect(handoff).toMatchObject({ logPath: realLogPath, byteOffset: 4096 });
    // Boot resolves against the SAME logPath the broker is tailing.
    expect(
      resolveBootByteOffset({
        handoff,
        logPath: realLogPath,
        eofSize: 9000,
        now: 6000,
        maxAgeMs: 60_000,
      })
    ).toBe(4096);
  });

  test("omitting logPath (the verify-caught bug) → handoff logPath:'' → boot reseeds to EOF", () => {
    // Reproduce the original defect: caller does not pass logPath at all.
    const handoff = captureHandoff({ nowFn: () => 5000 });
    expect(handoff.logPath).toBe("");
    // The successor tails the real month file; the empty logPath never matches,
    // so it silently falls back to EOF and drops the gap events.
    expect(
      resolveBootByteOffset({
        handoff,
        logPath: "/Users/x/catalyst/events/2026-06.jsonl",
        eofSize: 9000,
        now: 6000,
        maxAgeMs: 60_000,
      })
    ).toBe(9000);
  });

  test("handoff ts is stamped at write time, not event-capture time (staleness budget)", () => {
    // now (event capture) = 1000, but the handoff is written after the debounce;
    // nowFn() models the write-time clock. The staleness ts must reflect write time
    // so the debounce window does not eat the maxAgeMs budget.
    const writeTime = 1000 + STACK_RELOAD_DEBOUNCE_MS + 500;
    const handoff = captureHandoff({
      logPath: "/ev.jsonl",
      nowFn: () => writeTime,
    });
    expect(handoff.ts).toBe(writeTime);
    expect(handoff.ts).not.toBe(1000);
    // Fresh relative to a boot that happens shortly after the write.
    expect(
      resolveBootByteOffset({
        handoff,
        logPath: "/ev.jsonl",
        eofSize: 9000,
        now: writeTime + 2000,
        maxAgeMs: 60_000,
      })
    ).toBe(4096);
  });
});

// ─── running-state probe (CTL-1089) ─────────────────────────────────────────
//
// Hot-reload must never start a daemon the operator deliberately left stopped.
// The isRunningFn seam partitions reload candidates into running (restarted)
// and stopped (skipped) at performReload time — after the debounce — so the
// probe reflects live state. Unknown liveness (throwing probe) resolves
// to not-running (fail-safe direction).
describe("running-state probe (CTL-1089)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("stopped execution-core is skipped, never restarted", () => {
    const spawned = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push([cmd, args]),
      isRunningFn: (c) => c.name === "monitor",
      confirmFn: () => true,
      emitFn: () => {},
      now: 0,
      ...immediate,
    });
    expect(spawned.some(([cmd]) => cmd === "catalyst-monitor")).toBe(true);
    expect(spawned.some(([cmd]) => cmd === "catalyst-execution-core")).toBe(false);
  });

  test("stopped execution-core appears in the skipped partition of events", () => {
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      isRunningFn: (c) => c.name === "monitor",
      confirmFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 0,
      ...immediate,
    });
    const started = emitted.find((e) => e.event === "stack.reload.started");
    expect(started.detail.components).toEqual(["monitor"]);
    expect(started.detail.skipped).toEqual(["execution-core"]);
    const complete = emitted.find((e) => e.event === "stack.reload.complete");
    expect(complete.detail.components.map((c) => c.name)).toEqual(["monitor"]);
    expect(complete.detail.skipped).toEqual([{ name: "execution-core", reason: "not_running" }]);
  });

  test("both running → both restarted, empty skipped (no regression)", () => {
    const spawned = [];
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      isRunningFn: () => true,
      confirmFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 0,
      ...immediate,
    });
    expect(spawned).toContain("catalyst-monitor");
    expect(spawned).toContain("catalyst-execution-core");
    const started = emitted.find((e) => e.event === "stack.reload.started");
    expect(started.detail.skipped).toEqual([]);
  });

  test("all components stopped → nothing restarted, all skipped, still completes", () => {
    const spawned = [];
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd, args) => spawned.push([cmd, args]),
      isRunningFn: () => false,
      confirmFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 0,
      ...immediate,
    });
    expect(spawned.some(([cmd]) => cmd === "catalyst-monitor")).toBe(false);
    expect(spawned.some(([cmd]) => cmd === "catalyst-execution-core")).toBe(false);
    const complete = emitted.find((e) => e.event === "stack.reload.complete");
    expect(complete).toBeDefined();
    expect(complete.detail.components).toEqual([]);
    expect(complete.detail.skipped.map((s) => s.name).sort()).toEqual(["execution-core", "monitor"]);
  });

  test("all stopped but broker code changed → broker still self-reloads", () => {
    const spawned = [];
    const handoffs = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      isRunningFn: () => false,
      confirmFn: () => true,
      writeHandoffFn: (h) => handoffs.push(h),
      emitFn: () => {},
      now: 0,
      ...immediate,
    });
    expect(spawned.some((cmd) => cmd === "catalyst-monitor")).toBe(false);
    expect(spawned.some((cmd) => cmd === "catalyst-execution-core")).toBe(false);
    expect(spawned.some((cmd) => cmd === "catalyst-broker")).toBe(true);
    expect(handoffs.length).toBe(1);
  });

  test("skipped component is NOT counted as unconfirmed/degraded", () => {
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      isRunningFn: (c) => c.name === "monitor",
      confirmFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 0,
      ...immediate,
    });
    const events = emitted.map((e) => e.event);
    expect(events).toContain("stack.reload.complete");
    expect(events).not.toContain("stack.reload.degraded");
  });

  test("a throwing isRunningFn is treated as not-running (fail-safe, no throw)", () => {
    const spawned = [];
    expect(() =>
      handleStackReloadEvent({
        results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
        loadedCommitRoot: "/co",
        spawnFn: (cmd) => spawned.push(cmd),
        isRunningFn: () => { throw new Error("probe boom"); },
        confirmFn: () => true,
        emitFn: () => {},
        now: 0,
        ...immediate,
      })
    ).not.toThrow();
    expect(spawned.some((cmd) => cmd === "catalyst-monitor")).toBe(false);
    expect(spawned.some((cmd) => cmd === "catalyst-execution-core")).toBe(false);
  });
});

// ─── remediate hardening (CTL-1077 remediate cycle) ──────────────────────────
//
// New behaviors added by the verify⇄remediate cycle:
//  M1 a synchronous restart-spawn failure partitions the component unconfirmed
//     (→ degraded), so a failed exec-core restart is no longer reported complete.
//  M2 a failed broker self-reload spawn emits stack.reload.degraded(broker_restart_failed)
//     instead of being double-swallowed and leaving the broker on stale code.
//  M3 confirmation polling waits OFF the event loop via the injected setTimeoutFn,
//     not a synchronous sleep loop.
//  M5 the byte offset is read at handoff-write time via getByteOffsetFn, not captured
//     ~30 s earlier at processEvent time.
//  #6 brokerSelfReload is latched (OR-ed) across coalesced debounce decisions.
describe("remediate hardening (CTL-1077 remediate cycle)", () => {
  beforeEach(() => __clearReloadStateForTest());

  test("M1: a synchronous spawn failure for exec-core → degraded (not complete)", () => {
    const emitted = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      // exec-core restart cannot even launch; monitor spawns fine.
      spawnFn: (cmd) => { if (cmd === "catalyst-execution-core") throw new Error("ENOENT"); },
      confirmFn: () => true,
      isRunningFn: () => true,
      emitFn: (e) => emitted.push(e),
      now: 1000,
      ...immediate,
    });
    const names = emitted.map((e) => e.event);
    expect(names).toContain("stack.reload.degraded");
    expect(names).not.toContain("stack.reload.complete");
    const degraded = emitted.find((e) => e.event === "stack.reload.degraded" && e.detail.reason === "restart_not_confirmed");
    expect(degraded.detail.unconfirmed.map((c) => c.name)).toContain("execution-core");
    expect(degraded.detail.confirmed).toContain("monitor");
  });

  test("M2: a failed broker self-reload spawn → degraded(broker_restart_failed)", () => {
    const emitted = [];
    const timers = makeFakeTimers();
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      // monitor + exec-core restart fine; only the broker self-reload spawn fails.
      spawnFn: (cmd) => { if (cmd === "catalyst-broker") throw new Error("ENOENT"); },
      confirmFn: () => true,
      isRunningFn: () => true,
      writeHandoffFn: () => {},
      emitFn: (e) => emitted.push(e),
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    const brokerDegraded = emitted.find(
      (e) => e.event === "stack.reload.degraded" && e.detail.reason === "broker_restart_failed"
    );
    expect(brokerDegraded).toBeDefined();
    expect(brokerDegraded.detail.component).toBe("broker");
  });

  test("M3: confirmation polling for an unconfirmed component waits via setTimeoutFn (non-blocking)", () => {
    const scheduled = [];
    let confirmCalls = 0;
    const fakeSetTimeout = (fn, ms) => { scheduled.push(ms); fn(); return 0; };
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      // monitor confirms only on the 3rd probe → forces poll waits via setTimeoutFn.
      confirmFn: (c) => {
        if (c.name !== "monitor") return true;
        confirmCalls++;
        return confirmCalls >= 3;
      },
      isRunningFn: () => true,
      emitFn: () => {},
      now: 0,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: () => {},
    });
    // The debounce uses STACK_RELOAD_DEBOUNCE_MS; the inter-probe waits use the
    // non-blocking confirm poll cadence — proving the wait is off the event loop.
    expect(scheduled).toContain(STACK_RELOAD_CONFIRM_POLL_MS);
  });

  test("M5: byte offset is read at handoff-write time via getByteOffsetFn", () => {
    const handoffs = [];
    const timers = makeFakeTimers();
    let liveOffset = 100;
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      spawnFn: () => {},
      confirmFn: () => true,
      isRunningFn: () => true,
      writeHandoffFn: (h) => handoffs.push(h),
      getByteOffsetFn: () => liveOffset, // accessor read lazily at write time
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    // Offset advances between processEvent and the debounced handoff write.
    liveOffset = 8192;
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    expect(handoffs.length).toBe(1);
    expect(handoffs[0].byteOffset).toBe(8192); // live value, not the processEvent-time 100
  });

  test("#6: brokerSelfReload latches across coalesced decisions (earlier true survives a later false)", () => {
    const spawned = [];
    const handoffs = [];
    const timers = makeFakeTimers();
    // First decision in the window demands a broker self-reload (its root).
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b1", changed: true, restartNeeded: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      confirmFn: () => true,
      isRunningFn: () => true,
      writeHandoffFn: (h) => handoffs.push(h),
      currentByteOffset: 1,
      emitFn: () => {},
      now: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    // Second decision (different root) coalesces but does NOT need a broker reload.
    handleStackReloadEvent({
      results: [{ root: "/other", oldSha: "a", newSha: "b2", changed: true, restartNeeded: false }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      confirmFn: () => true,
      isRunningFn: () => true,
      writeHandoffFn: (h) => handoffs.push(h),
      currentByteOffset: 1,
      emitFn: () => {},
      now: 5_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.advance(STACK_RELOAD_DEBOUNCE_MS);
    // The broker self-reload from the first decision must NOT be dropped.
    expect(handoffs.length).toBe(1);
    expect(spawned).toContain("catalyst-broker");
  });
});

// ─── defaultIsRunningFn / pidFilePathForComponent (CTL-1089) ────────────────
//
// Unit tests for the production liveness probe. Uses a temp file + env override
// so no real daemon processes are needed — the test runner's own PID is
// guaranteed alive; a synthetic dead PID is used for the not-running case.
describe("defaultIsRunningFn / pidFilePathForComponent (CTL-1089)", () => {
  let origMonitorPidFile, origExecCorePidFile, origCatalystDir, tmpFile;

  beforeEach(() => {
    origMonitorPidFile = process.env.MONITOR_PID_FILE;
    origExecCorePidFile = process.env.EXECUTION_CORE_PID_FILE;
    origCatalystDir = process.env.CATALYST_DIR;
    tmpFile = `${tmpdir()}/ctl1089-pid-test-${process.pid}.tmp`;
  });

  afterEach(() => {
    if (origMonitorPidFile !== undefined) process.env.MONITOR_PID_FILE = origMonitorPidFile;
    else delete process.env.MONITOR_PID_FILE;
    if (origExecCorePidFile !== undefined) process.env.EXECUTION_CORE_PID_FILE = origExecCorePidFile;
    else delete process.env.EXECUTION_CORE_PID_FILE;
    if (origCatalystDir !== undefined) process.env.CATALYST_DIR = origCatalystDir;
    else delete process.env.CATALYST_DIR;
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  });

  test("monitor → ends with catalyst/monitor.pid; honors MONITOR_PID_FILE override", () => {
    const defaultPath = pidFilePathForComponent("monitor");
    expect(defaultPath).toMatch(/catalyst[/\\]monitor\.pid$/);
    process.env.MONITOR_PID_FILE = "/custom/monitor.pid";
    expect(pidFilePathForComponent("monitor")).toBe("/custom/monitor.pid");
  });

  test("execution-core → ends with daemon.pid; honors EXECUTION_CORE_PID_FILE override", () => {
    const defaultPath = pidFilePathForComponent("execution-core");
    expect(defaultPath).toMatch(/catalyst[/\\]execution-core[/\\]daemon\.pid$/);
    process.env.EXECUTION_CORE_PID_FILE = "/custom/exec-core.pid";
    expect(pidFilePathForComponent("execution-core")).toBe("/custom/exec-core.pid");
  });

  test("unknown name (e.g. broker) → null", () => {
    expect(pidFilePathForComponent("broker")).toBeNull();
    expect(pidFilePathForComponent("nope")).toBeNull();
    expect(pidFilePathForComponent(undefined)).toBeNull();
  });

  // CATALYST_DIR is the standard relocation override, honored by the bash wrappers
  // (catalyst-monitor.sh:36, catalyst-execution-core:24) and sibling .mjs probes.
  // The JS probe must resolve its default pidfile through it too, else a relocated
  // running daemon is wrongly probed as not-running and silently skipped. (CTL-1089)
  test("default pidfile follows CATALYST_DIR when no *_PID_FILE override is set", () => {
    delete process.env.MONITOR_PID_FILE;
    delete process.env.EXECUTION_CORE_PID_FILE;
    process.env.CATALYST_DIR = "/relocated/catalyst";
    expect(pidFilePathForComponent("monitor")).toBe("/relocated/catalyst/monitor.pid");
    expect(pidFilePathForComponent("execution-core")).toBe(
      "/relocated/catalyst/execution-core/daemon.pid",
    );
  });

  test("*_PID_FILE override still wins over CATALYST_DIR", () => {
    process.env.CATALYST_DIR = "/relocated/catalyst";
    process.env.MONITOR_PID_FILE = "/custom/monitor.pid";
    expect(pidFilePathForComponent("monitor")).toBe("/custom/monitor.pid");
  });

  test("live pid → true", () => {
    writeFileSync(tmpFile, String(process.pid));
    process.env.EXECUTION_CORE_PID_FILE = tmpFile;
    expect(defaultIsRunningFn({ name: "execution-core" })).toBe(true);
  });

  test("dead pid → false", () => {
    writeFileSync(tmpFile, "2147483646");
    process.env.EXECUTION_CORE_PID_FILE = tmpFile;
    expect(defaultIsRunningFn({ name: "execution-core" })).toBe(false);
  });

  test("missing pid file → false", () => {
    process.env.EXECUTION_CORE_PID_FILE = `${tmpdir()}/ctl1089-nonexistent-${process.pid}.pid`;
    expect(defaultIsRunningFn({ name: "execution-core" })).toBe(false);
  });

  test("garbage pid file → false", () => {
    writeFileSync(tmpFile, "not-a-number");
    process.env.EXECUTION_CORE_PID_FILE = tmpFile;
    expect(defaultIsRunningFn({ name: "execution-core" })).toBe(false);
  });

  test("unknown component → false", () => {
    expect(defaultIsRunningFn({ name: "broker" })).toBe(false);
    expect(defaultIsRunningFn({ name: "nope" })).toBe(false);
  });

  test("default is wired — omitting isRunningFn uses real probe; stopped components are skipped", () => {
    // Point both overrides at non-existent paths → real probe returns false → skipped
    process.env.MONITOR_PID_FILE = `${tmpdir()}/ctl1089-no-monitor-${process.pid}.pid`;
    process.env.EXECUTION_CORE_PID_FILE = `${tmpdir()}/ctl1089-no-execcore-${process.pid}.pid`;
    const spawned = [];
    handleStackReloadEvent({
      results: [{ root: "/co", oldSha: "a", newSha: "b", changed: true }],
      loadedCommitRoot: "/co",
      spawnFn: (cmd) => spawned.push(cmd),
      confirmFn: () => true,
      emitFn: () => {},
      now: 0,
      ...immediate,
      // No isRunningFn — exercises the production default
    });
    expect(spawned.some((cmd) => cmd === "catalyst-monitor")).toBe(false);
    expect(spawned.some((cmd) => cmd === "catalyst-execution-core")).toBe(false);
  });
});
