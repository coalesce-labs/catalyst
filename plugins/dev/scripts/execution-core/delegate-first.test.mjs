// delegate-first.test.mjs — CTL-1609 Phase 2: routeStuckTicketToDelegate seam
//                            CTL-1774 Phase 1: Layer-2 config ladder for readDelegateFirstMode
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readDelegateFirstMode, routeStuckTicketToDelegate } from "./delegate-first.mjs";

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

// ─── CTL-1774 Phase 1: Layer-2 config ladder for readDelegateFirstMode ───────
//
// These tests verify the env → Layer-2 → safe-default ladder, mirroring the
// readRecoveryPassConfig / readDeadDocWorkerConfig pattern.  Uses
// CATALYST_LAYER2_CONFIG_FILE to override the Layer-2 path in tests.

describe("readDelegateFirstMode — Layer-2 config ladder (CTL-1774)", () => {
  const DF_ENVS = ["CATALYST_DELEGATE_FIRST", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {},
    tmp;
  beforeEach(() => {
    for (const k of DF_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl1774-df-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of DF_ENVS) {
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  test("safe default: mode=off when env unset and no Layer-2 key", () => {
    expect(readDelegateFirstMode(process.env)).toBe("off");
  });

  test("Layer-2 used when env unset — THIS IS THE TEST THAT FAILS RED TODAY", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { delegateFirst: { mode: "shadow" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readDelegateFirstMode(process.env)).toBe("shadow");
  });

  test("env wins over Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { delegateFirst: { mode: "shadow" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_DELEGATE_FIRST = "enforce";
    expect(readDelegateFirstMode(process.env)).toBe("enforce");
  });

  test("kill-switch: CATALYST_DELEGATE_FIRST=0 maps to off even if Layer-2 says enforce", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { delegateFirst: { mode: "enforce" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_DELEGATE_FIRST = "0";
    expect(readDelegateFirstMode(process.env)).toBe("off");
  });

  test("invalid env falls through to Layer-2 (env not a hard override when unrecognised)", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { delegateFirst: { mode: "shadow" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_DELEGATE_FIRST = "garbage";
    expect(readDelegateFirstMode(process.env)).toBe("shadow");
  });

  test("safe default when env unset and Layer-2 file absent", () => {
    // CATALYST_LAYER2_CONFIG_FILE points at absent.json (set in beforeEach)
    expect(readDelegateFirstMode(process.env)).toBe("off");
  });

  test("injection contract preserved: explicit env bag still works", () => {
    expect(readDelegateFirstMode({ CATALYST_DELEGATE_FIRST: "shadow" })).toBe("shadow");
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

    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
    expect(result.routed).toBe(false);
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
      enqueueFn: () => {
        enqueueCalled = true;
        return { enqueued: true, reason: "enqueued" };
      },
      env: { CATALYST_DELEGATE_FIRST: "shadow" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-4", opts);

    expect(enqueueCalled).toBe(false);
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
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
      enqueueFn: () => {
        enqueueCalled = true;
        return { enqueued: true };
      },
      env: { CATALYST_DELEGATE_FIRST: "off" },
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-5", opts);

    expect(enqueueCalled).toBe(false);
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
    expect(result.routed).toBe(false);
  });

  test("off (default, no env var) → direct label, enqueue never called", () => {
    const labelCalls = [];
    let enqueueCalled = false;
    const opts = makeOpts({
      labelCalls,
      enqueueFn: () => {
        enqueueCalled = true;
        return { enqueued: true };
      },
      env: {},
    });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-5b", opts);

    expect(enqueueCalled).toBe(false);
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
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

    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
    expect(result.routed).toBe(false);
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

    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
    expect(result.routed).toBe(false);
  });
});

// ─── CTL-2061: an infra-class reason never labels, never enqueues ─────────────
//
// AC5 (mutation control): both axes are exercised — an infra-class reason
// ("sdk-overloaded-exhausted") and a genuine product-class one ("stalled", the
// default in makeOpts() and the value every pre-existing test above already
// uses) — so this suite can tell "infra-class routes differently" from "the
// function stopped labelling altogether".
describe("routeStuckTicketToDelegate — infra-class short-circuit (CTL-2061)", () => {
  for (const mode of ["off", "shadow", "enforce"]) {
    test(`${mode}: an infra-class reason never labels needs-human, never enqueues`, () => {
      const labelCalls = [];
      let enqueueCalls = 0;
      const opts = makeOpts({
        labelCalls,
        enqueueFn: () => {
          enqueueCalls++;
          return { enqueued: true, reason: "enqueued" };
        },
        env: { CATALYST_DELEGATE_FIRST: mode },
      });
      opts.reason = "sdk-overloaded-exhausted";
      opts.deps.postComment = () => ({ posted: true });

      const result = routeStuckTicketToDelegate(orchDir, "CTL-INFRA-1", opts);

      expect(labelCalls).toHaveLength(0);
      expect(enqueueCalls).toBe(0);
      expect(result.labelled).toBe(false);
    });
  }

  test("a genuine product-class reason ('stalled') does NOT take the infra short-circuit", () => {
    const labelCalls = [];
    const opts = makeOpts({ labelCalls, env: { CATALYST_DELEGATE_FIRST: "off" } });
    // makeOpts()'s default reason is "stalled" — deliberately not infra-class.

    const result = routeStuckTicketToDelegate(orchDir, "CTL-PRODUCT-1", opts);

    // ⚠️ RE-AIMED BY CTL-2156…CTL-2162, NOT WEAKENED. This case was written for CTL-2061 as
    // "still labels under off" and asserted `labelCalls` had length 1. That premise EXPIRED: this
    // epic deletes the `needs-human` label, so CTL-2159 makes every producer stop calling
    // applyLabel — `labelCalls` is now 0 for EVERY reason, infra-class or not. Left as it was, the
    // assertion pinned behaviour the epic exists to remove.
    //
    // The case still has to earn its place, because it is the CONTROL for the infra-class cases
    // above: without a product-class reason taking a visibly different path, those cases cannot
    // tell "the short-circuit routes correctly" from "the short-circuit swallows everything". So
    // it now asserts the discriminator that SURVIVES the epic — the shape of the return.
    //
    // infra-class  → applyInfraClassAction  → { action, count, until, reason }  (no stallClass)
    // product-class→ the classifier seam    → { routed, labelled, stallClass }  (no action)
    expect(result).not.toHaveProperty("action");
    expect(result).not.toHaveProperty("count");
    expect(result.routed).toBe(false);
    expect(result.stallClass).toBe("held"); // reached the classifier rather than being short-circuited

    // ⛔ NOBODY LABELS ANY MORE — the epic's whole point. Asserted explicitly so a producer that
    // starts calling applyLabel again fails HERE, not silently.
    expect(labelCalls).toHaveLength(0);

    // ⚠️ `labelled` stays true while applyLabel was never called: post-CTL-2159 that boolean is a
    // RETRY contract, not "a label was applied" (delegate-first.mjs documents this at labelDirect).
    // The naming is a real trap and the same shape Codex flagged on this PR for publishEscalation —
    // tracked as CTL-2178 AC2. Pinned here so the meaning cannot drift again unnoticed.
    expect(result.labelled).toBe(true);
  });

  test("the infra-class check runs first attempt returns the same shape enqueue-fallback does", () => {
    const opts = makeOpts({ env: { CATALYST_DELEGATE_FIRST: "enforce" } });
    opts.reason = "cluster_fence_stale"; // a different registered infra reason
    opts.deps.postComment = () => ({ posted: true });

    const result = routeStuckTicketToDelegate(orchDir, "CTL-INFRA-2", opts);

    expect(result).toHaveProperty("action");
    expect(result).toHaveProperty("count");
    expect(result.labelled).toBe(false);
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
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
    expect(result.routed).toBe(false);
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
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
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
    // ⛔ CTL-2159: was toHaveLength(1). This path used to write the Linear
    // `needs-human` label. It now publishes through the CTL-2158 classifier and
    // writes NO label at all — `result.labelled` is the surviving retry contract
    // (the six route sites read it as their STOP), so it is asserted alongside.
    expect(labelCalls).toHaveLength(0);
    expect(result.labelled).toBe(true);
  });
});
