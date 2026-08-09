import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePhaseAwareDispatchFn } from "./dispatch.mjs";
import { parkLane } from "./lane-cooldown.mjs";

test("daemon threads orchDir into the production phase-aware dispatch factory", () => {
  const daemonSource = readFileSync(new URL("./daemon.mjs", import.meta.url), "utf8");
  expect(daemonSource).toMatch(/makePhaseAwareDispatchFn\(\{[\s\S]*?\borchDir,\s*[\s\S]*?\}\);/);
});

test("a bg phase falls back to codex while bg is parked", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-fallback-"));
  try {
    const now = Date.parse("2026-08-08T20:00:00Z");
    parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
    const dispatched = [],
      events = [];
    const fn = makePhaseAwareDispatchFn({
      bootExecutor: "bg",
      codexBootEligible: true,
      orchDir: dir,
      now: () => now,
      resolveExecutorForPhase: () => ({ source: "executorByPhase", executor: "bg" }),
      dispatchForExecutor: (executor) => (args) => {
        dispatched.push(executor);
        return { code: 0, args };
      },
      emitEvent: (event) => events.push(event),
    });
    const result = fn({ ticket: "CAT-58", phase: "research" });
    expect(dispatched).toEqual(["codex-exec"]);
    expect(result.effectiveExecutor).toBe("codex-exec");
    expect(
      events.some((event) => event["event.name"] === "execution-core.executor.usage-limit-fallback")
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a parked bg phase is not dispatched when no healthy fallback exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-no-healthy-lane-"));
  try {
    const now = Date.parse("2026-08-08T20:00:00Z");
    parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
    const dispatched = [], events = [];
    const fn = makePhaseAwareDispatchFn({
      bootExecutor: "bg",
      codexBootEligible: false,
      orchDir: dir,
      now: () => now,
      resolveExecutorForPhase: () => ({ source: "executorByPhase", executor: "bg" }),
      dispatchForExecutor: (executor) => () => {
        dispatched.push(executor);
        return { code: 0 };
      },
      emitEvent: (event) => events.push(event),
    });
    expect(fn({ ticket: "CAT-58", phase: "research" })).toEqual({ code: 75, deferred: true, reason: "no-healthy-executor-lane" });
    expect(dispatched).toEqual([]);
    expect(events.some((event) => event["event.name"] === "execution-core.executor.no-healthy-lane")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
