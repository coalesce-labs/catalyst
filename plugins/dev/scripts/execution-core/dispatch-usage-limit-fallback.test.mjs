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
      // CAT-58 (Codex round 2, P1): the fallback now demands POSITIVE evidence. Inject the
      // verdict so the test does not silently depend on whether the machine running it
      // happens to have an authenticated codex CLI installed.
      verifyCodexLane: () => true,
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
    const result = fn({ ticket: "CAT-58", phase: "research" });
    expect(result).toMatchObject({ code: 75, deferred: true, reason: "no-healthy-executor-lane" });
    // CAT-58 (Codex round 2, P1): a parked lane with no fallback is a DEFERRAL, not a
    // dispatch failure — callers keyed off `laneDeferred` must not retain approval
    // sentinels and re-request dispatch on every tick for the whole cooldown.
    expect(result.laneDeferred).toBe(true);
    expect(result.lane).toBe("bg");
    expect(result.retryAfter).toBe(Date.parse("2026-08-10T18:00:00Z"));
    expect(dispatched).toEqual([]);
    expect(events.some((event) => event["event.name"] === "execution-core.executor.no-healthy-lane")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CAT-58 (Codex round 2, P1 "Verify Codex before using it as the fallback"): the keystone.
// resolveCodexBootEligibility returns the SAME { eligible: true } both when codex was probed
// and passed AND when nothing routes to codex so it probed nothing at all. On a normal bg-only
// node the latter is the live case, so reading the sentinel as a healthy lane would reroute
// every parked dispatch into an absent/unauthenticated codex — turning a clean deferral into
// real dispatch failures and breaker trips. The fallback must demand a positive probe.
test("the unverified codexBootEligible sentinel does NOT count as a healthy fallback lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-unverified-codex-"));
  try {
    const now = Date.parse("2026-08-08T20:00:00Z");
    parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
    const dispatched = [], events = [];
    const fn = makePhaseAwareDispatchFn({
      bootExecutor: "bg",
      // The no-op sentinel from a node with NO codex route — checked nothing.
      codexBootEligible: true,
      orchDir: dir,
      now: () => now,
      resolveExecutorForPhase: () => ({ source: "executorByPhase", executor: "bg" }),
      dispatchForExecutor: (executor) => () => {
        dispatched.push(executor);
        return { code: 0 };
      },
      // ...and the real probe says codex is not actually usable on this node.
      verifyCodexLane: () => false,
      emitEvent: (event) => events.push(event),
    });
    const result = fn({ ticket: "CAT-58", phase: "research" });
    expect(dispatched).toEqual([]); // never launched into the unverified lane
    expect(result).toMatchObject({ code: 75, deferred: true, laneDeferred: true });
    expect(events.some((e) => e["event.name"] === "execution-core.executor.no-healthy-lane")).toBe(true);
    expect(events.some((e) => e["event.name"] === "execution-core.executor.usage-limit-fallback")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The probe is memoized per factory: a park episode pays the auth + `codex --version` cost
// once, not once per dispatched phase.
test("the codex lane probe is memoized across dispatches in one park episode", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-codex-memo-"));
  try {
    const now = Date.parse("2026-08-08T20:00:00Z");
    parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
    let probes = 0;
    const fn = makePhaseAwareDispatchFn({
      bootExecutor: "bg",
      codexBootEligible: true,
      orchDir: dir,
      now: () => now,
      resolveExecutorForPhase: () => ({ source: "executorByPhase", executor: "bg" }),
      dispatchForExecutor: () => () => ({ code: 0 }),
      verifyCodexLane: () => {
        probes += 1;
        return true;
      },
      emitEvent: () => {},
    });
    fn({ ticket: "CAT-58", phase: "research" });
    fn({ ticket: "CAT-59", phase: "implement" });
    fn({ ticket: "CAT-60", phase: "verify" });
    expect(probes).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
