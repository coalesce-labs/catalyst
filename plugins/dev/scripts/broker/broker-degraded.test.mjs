// broker-degraded.test.mjs — CTL-1523. The PURE core of the broker-degraded
// detector: the trip classifier (with its fleet-activity discriminator), the
// clear-side verdict, the sustained-tick debounce, and the edge state machine —
// table-driven; no disk, no clock, no event log — PLUS direct coverage of the
// `checkBrokerDegraded` driver (emit-then-advance retry semantics + hydrateLatch
// tolerance) with an injected emit stub and a CATALYST_DIR-isolated marker.
// The runWatchdogTick wiring is covered in broker-degraded-wiring.test.mjs.
// Idiom model: execution-core/fleet-health-probe.test.mjs.
//
// Run: cd plugins/dev/scripts/broker && bun test broker-degraded.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyBrokerDegraded,
  classifyBrokerDegradedClear,
  nextBrokerDegradedSustained,
  nextBrokerDegradedLatch,
  checkBrokerDegraded,
  getBrokerDegradedLatchPath,
  __resetBrokerDegradedLatchForTest,
  __getBrokerDegradedLatchForTest,
  BROKER_DEGRADED_EVENT,
  BROKER_RECOVERED_EVENT,
} from "./broker-degraded.mjs";

const GRACE = 300_000;

describe("classifyBrokerDegraded — the trip classifier (CTL-1523)", () => {
  const cases = [
    // [name, readings, expectedAnomalous]
    [
      "THE REGRESSION: empty interests + past grace but IDLE fleet → not anomalous",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: false },
      false,
    ],
    [
      "empty interests + past grace + ACTIVE fleet → anomalous",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: true },
      true,
    ],
    [
      "inside the startup grace → not anomalous even with an active fleet",
      { interestCount: 0, uptimeMs: 60_000, fleetActive: true },
      false,
    ],
    [
      "boundary: uptime EXACTLY at the grace does not trip (strict >)",
      { interestCount: 0, uptimeMs: GRACE, fleetActive: true },
      false,
    ],
    [
      "boundary: one ms past the grace trips",
      { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true },
      true,
    ],
    [
      "interests present → not anomalous however active/old",
      { interestCount: 3, uptimeMs: GRACE + 600_000, fleetActive: true },
      false,
    ],
    [
      "fleetActive undefined (reader unavailable) → NOT anomalous (fail closed)",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: undefined },
      false,
    ],
    [
      "fleetActive truthy-but-not-true is not accepted (strict === true)",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: 1 },
      false,
    ],
    [
      "non-finite uptime → not anomalous",
      { interestCount: 0, uptimeMs: NaN, fleetActive: true },
      false,
    ],
  ];

  for (const [name, readings, expected] of cases) {
    test(name, () => {
      expect(classifyBrokerDegraded(readings, { graceMs: GRACE }).anomalous).toBe(expected);
    });
  }

  test("reports the three component predicates for forensics", () => {
    const v = classifyBrokerDegraded(
      { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true },
      { graceMs: GRACE },
    );
    expect(v).toEqual({
      anomalous: true,
      emptyInterests: true,
      pastGrace: true,
      fleetActive: true,
    });
  });

  test("no-arg call is safe (never throws) and does not trip", () => {
    expect(classifyBrokerDegraded().anomalous).toBe(false);
  });
});

describe("classifyBrokerDegradedClear — the clear-side verdict (CTL-1523)", () => {
  const cases = [
    [
      "interests came back → clear, reason 'interests registered'",
      { interestCount: 2, fleetActive: true },
      { clear: true, reason: "interests registered" },
    ],
    [
      "fleet went idle → clear, reason 'fleet idle' (an idle fleet CLOSES an episode)",
      { interestCount: 0, fleetActive: false },
      { clear: true, reason: "fleet idle" },
    ],
    [
      "both conditions → 'interests registered' wins (affirmative proof of life)",
      { interestCount: 5, fleetActive: false },
      { clear: true, reason: "interests registered" },
    ],
    [
      "still empty AND still active → NOT clear (hold the episode)",
      { interestCount: 0, fleetActive: true },
      { clear: false, reason: null },
    ],
    [
      "unknown activity with empty interests → clear (fail closed, same as trip side)",
      { interestCount: 0, fleetActive: undefined },
      { clear: true, reason: "fleet idle" },
    ],
  ];

  for (const [name, readings, expected] of cases) {
    test(name, () => {
      expect(classifyBrokerDegradedClear(readings)).toEqual(expected);
    });
  }

  test("trip and clear are mutually exclusive across the whole input grid", () => {
    for (const interestCount of [0, 1]) {
      for (const fleetActive of [true, false]) {
        for (const uptimeMs of [0, GRACE + 1]) {
          const { anomalous } = classifyBrokerDegraded(
            { interestCount, uptimeMs, fleetActive },
            { graceMs: GRACE },
          );
          const { clear } = classifyBrokerDegradedClear({ interestCount, fleetActive });
          expect(anomalous && clear).toBe(false);
        }
      }
    }
  });
});

describe("nextBrokerDegradedSustained — the debounce counter (CTL-1523)", () => {
  test("counts consecutive anomalous ticks", () => {
    let n = 0;
    for (const expected of [1, 2, 3]) {
      n = nextBrokerDegradedSustained(n, true);
      expect(n).toBe(expected);
    }
  });

  test("any non-anomalous tick resets the run to 0 (must be contiguous)", () => {
    let n = nextBrokerDegradedSustained(nextBrokerDegradedSustained(0, true), true);
    expect(n).toBe(2);
    n = nextBrokerDegradedSustained(n, false);
    expect(n).toBe(0);
    expect(nextBrokerDegradedSustained(n, true)).toBe(1);
  });

  test("a non-finite prior is treated as 0", () => {
    expect(nextBrokerDegradedSustained(undefined, true)).toBe(1);
    expect(nextBrokerDegradedSustained(NaN, false)).toBe(0);
  });
});

describe("nextBrokerDegradedLatch — the edge state machine (CTL-1523)", () => {
  const cases = [
    ["unlatched + trip → degraded edge", false, { trip: true, clear: false }, { latched: true, emit: "degraded" }],
    ["unlatched + nothing → no emit", false, { trip: false, clear: false }, { latched: false, emit: null }],
    ["unlatched + clear → no emit (nothing to recover)", false, { trip: false, clear: true }, { latched: false, emit: null }],
    ["latched + still tripping → NO re-emit", true, { trip: true, clear: false }, { latched: true, emit: null }],
    ["latched + clear → recovered edge", true, { trip: false, clear: true }, { latched: false, emit: "recovered" }],
    ["latched + neither → hold", true, { trip: false, clear: false }, { latched: true, emit: null }],
  ];

  for (const [name, prev, verdict, expected] of cases) {
    test(name, () => {
      expect(nextBrokerDegradedLatch(prev, verdict)).toEqual(expected);
    });
  }

  test("a full episode emits exactly one degraded and one recovered", () => {
    const emitted = [];
    let latched = false;
    // trip, hold ×3, then clear, then stay clear ×2
    for (const v of [
      { trip: true, clear: false },
      { trip: true, clear: false },
      { trip: true, clear: false },
      { trip: false, clear: true },
      { trip: false, clear: true },
      { trip: false, clear: true },
    ]) {
      const r = nextBrokerDegradedLatch(latched, v);
      latched = r.latched;
      if (r.emit) emitted.push(r.emit);
    }
    expect(emitted).toEqual(["degraded", "recovered"]);
  });

  test("no-verdict call is safe and holds", () => {
    expect(nextBrokerDegradedLatch(true)).toEqual({ latched: true, emit: null });
  });
});

// ─── checkBrokerDegraded — the driver (CTL-1523) ─────────────────────────────
// Direct coverage of the parts the pure-fn tables cannot reach: the EMIT-THEN-ADVANCE
// contract (a failed or throwing append must NOT advance the latch, so the edge
// retries next tick), the `if (!ok) return null` guard, and hydrateLatch()'s
// tolerance of an absent/corrupt marker. No DB, no router, no event log — the emit
// side effect is an injected stub and CATALYST_DIR points at an mkdtemp so the
// durable marker is isolated. Idiom model: execution-core/fleet-health-probe.test.mjs
// ("a failed emit (append returns false) does NOT advance the latch").
describe("checkBrokerDegraded — the driver's failure semantics (CTL-1523)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;

  // Readings that trip the gate (empty interests, past grace, fleet working) and the
  // readings that clear it (fleet went idle).
  const ANOMALOUS = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true };
  const IDLE = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: false };
  // Every call pins the two knobs so the run does not depend on the deployed defaults.
  const run = (readings, emit, { sustainedTicks = 1 } = {}) =>
    checkBrokerDegraded({ ...readings, graceMs: GRACE, sustainedTicks, emit });

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-driver-"));
    process.env.CATALYST_DIR = dir;
    // The detector is OPT-IN and dormant by default — arm it for these cases.
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    __resetBrokerDegradedLatchForTest();
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
  });

  test("dormant by default: with the env UNSET the driver evaluates nothing", () => {
    delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    const calls = [];
    expect(run(ANOMALOUS, (a) => (calls.push(a), true))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
  });

  test("(1) a degraded edge whose emit RETURNS FALSE does not advance the latch — it retries", () => {
    let ok = false;
    const calls = [];
    const emit = (payload) => {
      calls.push(payload);
      return ok;
    };
    // sustainedTicks=2 so the retry tick has a LIVE counter of 3 while the run that
    // actually crossed the gate was 2 — the honest-`sustainedTicks` regression.
    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBeNull(); // tick 1: below threshold
    expect(calls).toHaveLength(0);

    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBeNull(); // tick 2: edge, append FAILS
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false); // latch did NOT advance
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false); // and nothing persisted

    ok = true;
    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBe("degraded"); // tick 3: retried
    expect(calls).toHaveLength(2);
    expect(calls[1].action).toBe("degraded");
    // The reported run length is the one that CROSSED the gate, not the live counter
    // (which is 3 by now) — a retry must not inflate the forensic detail.
    expect(calls[1].detail.sustainedTicks).toBe(2);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(true);
  });

  test("(2) a degraded edge whose emit THROWS is swallowed — null, latch unchanged, retries", () => {
    const calls = [];
    const throwing = (payload) => {
      calls.push(payload);
      throw new Error("ENOSPC: event log append failed");
    };
    expect(() => run(ANOMALOUS, throwing)).not.toThrow();
    expect(run(ANOMALOUS, throwing)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2); // attempted on every tick

    const good = [];
    expect(run(ANOMALOUS, (p) => (good.push(p), true))).toBe("degraded");
    expect(good).toHaveLength(1);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
  });

  test("(3) the CLEAR edge retries too: a throwing recovered leaves the episode LATCHED", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    const thrown = [];
    const throwing = (payload) => {
      thrown.push(payload);
      throw new Error("append failed");
    };
    expect(() => run(IDLE, throwing)).not.toThrow();
    expect(run(IDLE, throwing)).toBeNull();
    expect(thrown[0].action).toBe("recovered");
    // Still latched → the recovered is owed and will be re-attempted next tick.
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    const good = [];
    expect(run(IDLE, (p) => (good.push(p), true))).toBe("recovered");
    expect(good[0].detail.reason).toBe("fleet idle");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    // …and it does not emit a second time.
    expect(run(IDLE, () => true)).toBeNull();
  });

  test("(4a) an ABSENT marker hydrates as unlatched and produces no orphan recovered", () => {
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
    const calls = [];
    // Clear-side readings on a fresh process: nothing was latched, so nothing recovers.
    expect(run(IDLE, (p) => (calls.push(p), true))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
  });

  test("(4b) a CORRUPT marker is tolerated: unlatched, never throws, no orphan recovered", () => {
    for (const garbage of ["{not json", "", "null", '{"latched":"yes"}', "[1,2,3]"]) {
      __resetBrokerDegradedLatchForTest();
      const path = getBrokerDegradedLatchPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, garbage);

      const calls = [];
      let result;
      expect(() => {
        result = run(IDLE, (p) => (calls.push(p), true));
      }).not.toThrow();
      expect(result, `garbage: ${garbage}`).toBeNull();
      expect(calls, `garbage: ${garbage}`).toHaveLength(0); // NO orphan "recovered"
      expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    }
  });

  test("(4c) a VALID latched marker hydrates the open episode — the recovered still fires", () => {
    writeFileSync(
      getBrokerDegradedLatchPath(),
      JSON.stringify({ latched: true, latchedAtMs: Date.now() - 60_000, ts: Date.now() }),
    );
    const calls = [];
    expect(run(IDLE, (p) => (calls.push(p), true))).toBe("recovered");
    expect(calls[0].detail.reason).toBe("fleet idle");
    expect(typeof calls[0].detail.degradedForMs).toBe("number");
  });
});

describe("event names (CTL-1523)", () => {
  test("both live in the broker.daemon protected space", () => {
    expect(BROKER_DEGRADED_EVENT).toBe("broker.daemon.degraded");
    expect(BROKER_RECOVERED_EVENT).toBe("broker.daemon.recovered");
    for (const n of [BROKER_DEGRADED_EVENT, BROKER_RECOVERED_EVENT]) {
      expect(n.startsWith("broker.daemon")).toBe(true);
    }
  });
});
