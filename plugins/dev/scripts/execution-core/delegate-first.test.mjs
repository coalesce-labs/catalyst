// delegate-first.test.mjs — CTL-1609 Phase 2: routeStuckTicketToDelegate seam
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  readDelegateFirstMode,
  routeStuckTicketToDelegate,
} from "./delegate-first.mjs";

// ─── test helpers ────────────────────────────────────────────────────────────

function makeOpts({
  labelCalls = [],
  enqueueFn = () => ({ enqueued: true, reason: "enqueued" }),
  events = [],
  env = {},
  explanation = { call_to_action: "do something" },
  // CTL-1609 (Codex P1): enforce now REQUIRES a confirmed-enabled delegate runner
  // before it may suppress the needs-human label. Default "on" here so the
  // pre-existing enforce cases keep exercising the enqueue path; the fail-safe
  // gate itself is covered by its own describe block below.
  runnerMode = "on",
} = {}) {
  return {
    site: "test-site",
    kind: "board-health",
    reason: "stalled",
    boardContext: { ticket: "CTL-1" },
    explanation,
    deps: {
      enqueue: enqueueFn,
      readRunnerConfig: () => ({ mode: runnerMode }),
    },
    applyLabel: {
      applyLabel: (...args) => {
        labelCalls.push(args);
        return { applied: true };
      },
    },
    env,
    appendEvent: (e) => events.push(e),
    log: { info: () => {}, warn: () => {} },
  };
}

// ─── readDelegateFirstMode ────────────────────────────────────────────────────

describe("readDelegateFirstMode", () => {
  test("defaults to off when CATALYST_DELEGATE_FIRST unset", () => {
    expect(readDelegateFirstMode({})).toBe("off");
  });

  test("returns enforce when set to enforce", () => {
    expect(readDelegateFirstMode({ CATALYST_DELEGATE_FIRST: "enforce" })).toBe("enforce");
  });

  test("returns shadow when set to shadow", () => {
    expect(readDelegateFirstMode({ CATALYST_DELEGATE_FIRST: "shadow" })).toBe("shadow");
  });

  test("returns off for unrecognised values (fail-safe)", () => {
    expect(readDelegateFirstMode({ CATALYST_DELEGATE_FIRST: "bogus" })).toBe("off");
  });
});

// ─── routeStuckTicketToDelegate — Phase 2 + 3 tests ─────────────────────────

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "delegate-first-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

describe("routeStuckTicketToDelegate (CTL-1609)", () => {
  // Test 1: enforce + enqueue succeeds → no label, delegate.routed event
  test("enforce + enqueue succeeds → no label applied, delegate.routed emitted", () => {
    const labelCalls = [];
    const events = [];
    const opts = makeOpts({
      labelCalls,
      events,
      enqueueFn: () => ({ enqueued: true, reason: "enqueued" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-1", opts);

    expect(labelCalls).toHaveLength(0);
    expect(result.routed).toBe(true);
    const routedEvent = events.find((e) => e.name === "delegate.routed");
    expect(routedEvent).toBeDefined();
    expect(routedEvent.ticket).toBe("CTL-1");
    expect(routedEvent.site).toBe("test-site");
  });

  // Test 2: enforce + queue-full → label+explain fallback, delegate.route-fallback event
  test("enforce + queue-full → falls back to label+explanation, delegate.route-fallback emitted", () => {
    const labelCalls = [];
    const events = [];
    const opts = makeOpts({
      labelCalls,
      events,
      enqueueFn: () => ({ enqueued: false, reason: "queue-full" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-2", opts);

    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
    expect(result.labelled).toBe(true);
    const fallbackEvent = events.find((e) => e.name === "delegate.route-fallback");
    expect(fallbackEvent).toBeDefined();
    expect(fallbackEvent.reason).toBe("queue-full");
  });

  // Test 3: enforce + already-pending / worker-live → no label (idempotent in-flight)
  test("enforce + already-pending → no label, routed:true (idempotent)", () => {
    const labelCalls = [];
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => ({ enqueued: false, reason: "already-pending" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-3", opts);

    expect(labelCalls).toHaveLength(0);
    expect(result.routed).toBe(true);
    expect(result.reason).toBe("already-pending");
  });

  test("enforce + worker-live → no label, routed:true (idempotent)", () => {
    const labelCalls = [];
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => ({ enqueued: false, reason: "worker-live" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-3b", opts);

    expect(labelCalls).toHaveLength(0);
    expect(result.routed).toBe(true);
    expect(result.reason).toBe("worker-live");
  });

  // Test 4: shadow → delegate.would-route logged, enqueue NOT called, DOES label
  test("shadow → delegate.would-route logged, enqueue NOT called, label applied", () => {
    const labelCalls = [];
    const events = [];
    let enqueueCalled = false;
    const opts = makeOpts({
      labelCalls,
      events,
      enqueueFn: () => { enqueueCalled = true; return { enqueued: true, reason: "enqueued" }; },
      env: { CATALYST_DELEGATE_FIRST: "shadow" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-4", opts);

    expect(enqueueCalled).toBe(false);
    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
    expect(result.shadow).toBe(true);
    const wouldRoute = events.find((e) => e.name === "delegate.would-route");
    expect(wouldRoute).toBeDefined();
    expect(wouldRoute.ticket).toBe("CTL-4");
  });

  // Test 5: off → direct label+explanation, enqueue never referenced
  test("off → direct label, enqueue never called (byte-identical to Phase 1)", () => {
    const labelCalls = [];
    let enqueueCalled = false;
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => { enqueueCalled = true; return { enqueued: true }; },
      env: { CATALYST_DELEGATE_FIRST: "off" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-5", opts);

    expect(enqueueCalled).toBe(false);
    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
  });

  test("off (default, no env var) → direct label, enqueue never called", () => {
    const labelCalls = [];
    let enqueueCalled = false;
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => { enqueueCalled = true; return { enqueued: true }; },
      env: {},
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-5b", opts);

    expect(enqueueCalled).toBe(false);
    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
  });

  // Test 6: no-orch-dir / write-failed → fallback to label
  test("enforce + write-failed → label fallback, delegate.route-fallback emitted", () => {
    const labelCalls = [];
    const events = [];
    const opts = makeOpts({
      labelCalls,
      events,
      enqueueFn: () => ({ enqueued: false, reason: "write-failed" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-6", opts);

    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
    expect(result.labelled).toBe(true);
    const fallbackEvent = events.find((e) => e.name === "delegate.route-fallback");
    expect(fallbackEvent).toBeDefined();
    expect(fallbackEvent.reason).toBe("write-failed");
  });

  test("enforce + no-orch-dir → label fallback", () => {
    const labelCalls = [];
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => ({ enqueued: false, reason: "no-orch-dir" }),
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-6b", opts);

    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
  });
});

// ─── CTL-1609 (Codex P1): runner-disabled fail-safe gate ──────────────────────
//
// enforce may suppress the needs-human label ONLY when a runner is confirmed
// enabled to drain the queue. readDelegateRunnerConfig couples the runner's
// default to CATALYST_BOARD_HEALTH / CATALYST_RECOVERY_PASS — it knows nothing
// about CATALYST_DELEGATE_FIRST — so lighting only DELEGATE_FIRST would otherwise
// queue intents forever with no human ever told.
describe("routeStuckTicketToDelegate — runner-disabled fail-safe (CTL-1609)", () => {
  test("enforce + runner off → does NOT enqueue, DOES label, reason runner-disabled", () => {
    const labelCalls = [];
    const events = [];
    let enqueueCalls = 0;
    const result = routeStuckTicketToDelegate(
      orchDir,
      "CTL-RD1",
      makeOpts({
        labelCalls,
        events,
        runnerMode: "off",
        enqueueFn: () => {
          enqueueCalls += 1;
          return { enqueued: true, reason: "enqueued" };
        },
        env: { CATALYST_DELEGATE_FIRST: "enforce" },
      })
    );

    // The safety net fires: a human is told rather than the ticket going quiet.
    expect(enqueueCalls).toBe(0);
    expect(labelCalls).toHaveLength(1);
    expect(result.routed).toBe(false);
    expect(result.labelled).toBe(true);
    expect(result.reason).toBe("runner-disabled");
    const fallback = events.find((e) => e.name === "delegate.route-fallback");
    expect(fallback).toBeDefined();
    expect(fallback.reason).toBe("runner-disabled");
  });

  test("enforce + runner on → routes (gate does not block the enabled path)", () => {
    const labelCalls = [];
    let enqueueCalls = 0;
    const result = routeStuckTicketToDelegate(
      orchDir,
      "CTL-RD2",
      makeOpts({
        labelCalls,
        runnerMode: "on",
        enqueueFn: () => {
          enqueueCalls += 1;
          return { enqueued: true, reason: "enqueued" };
        },
        env: { CATALYST_DELEGATE_FIRST: "enforce" },
      })
    );

    expect(enqueueCalls).toBe(1);
    expect(labelCalls).toHaveLength(0);
    expect(result.routed).toBe(true);
  });

  test("the gate is enforce-only — shadow still labels and never consults the runner", () => {
    const labelCalls = [];
    let runnerReads = 0;
    const opts = makeOpts({
      labelCalls,
      env: { CATALYST_DELEGATE_FIRST: "shadow" },
    });
    opts.deps.readRunnerConfig = () => {
      runnerReads += 1;
      return { mode: "off" };
    };

    const result = routeStuckTicketToDelegate(orchDir, "CTL-RD3", opts);

    expect(runnerReads).toBe(0);
    expect(labelCalls).toHaveLength(1);
    expect(result.shadow).toBe(true);
  });

  test("real readDelegateRunnerConfig: DELEGATE_FIRST=enforce alone leaves the runner off", () => {
    // The exact operator mistake the gate exists for — asserted against the REAL
    // resolver, not a stub, so a future coupling change surfaces here.
    const labelCalls = [];
    const opts = makeOpts({
      labelCalls,
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
    });
    delete opts.deps.readRunnerConfig; // use the production resolver

    const result = routeStuckTicketToDelegate(orchDir, "CTL-RD4", opts);

    expect(result.reason).toBe("runner-disabled");
    expect(labelCalls).toHaveLength(1);
  });
});
