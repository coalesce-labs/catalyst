// broker-degraded-wiring.test.mjs — CTL-1523. The runWatchdogTick wiring of the
// broker-degraded detector: the fleet-activity discriminator that fixes the
// idle-fleet false alarm, the sustained-tick debounce, the paired
// broker.daemon.recovered, the DURABLE latch across a simulated restart, and the
// opt-in gate. The pure machine and the checkBrokerDegraded driver's failure
// semantics are covered in broker-degraded.test.mjs.
//
// NOTE (CTL-1523): the detector is OPT-IN — dormant unless
// FILTER_BROKER_DEGRADED_ENABLED=1 — so the shared beforeEach arms it and the
// "opt-in gate" block asserts the dormant default.
//
// Harness copied from alert-emit-wiring.test.mjs (mkdtempSync → CATALYST_DIR,
// close/openBrokerStateDb, clearInterests, clearLastHeartbeat,
// __resetBrokerStartedAtForTest) plus the new __resetBrokerDegradedLatchForTest
// seam (mirrors __resetFleetHealthLatch).
//
// Run: cd plugins/dev/scripts/broker && bun test broker-degraded-wiring.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventLogPath, BROKER_DEGRADED_SUSTAINED_TICKS } from "./config.mjs";
import {
  runWatchdogTick,
  handleRegister,
  handleDeregister,
  __clearIngestionRecencyForTest,
} from "./router.mjs";
import {
  __resetBrokerDegradedLatchForTest,
  getBrokerDegradedLatchPath,
  BROKER_DEGRADED_EVENT,
  BROKER_RECOVERED_EVENT,
} from "./broker-degraded.mjs";
import { openBrokerStateDb, closeBrokerStateDb, upsertWorkerState } from "./broker-state.mjs";
import {
  getInterests,
  clearInterests,
  clearLastHeartbeat,
  __resetBrokerStartedAtForTest,
  __setBrokerStartedAtForTest,
} from "./state.mjs";

const SUSTAINED = BROKER_DEGRADED_SUSTAINED_TICKS;

// Read the JSONL and keep only this detector's two events (mirrors
// alert-emit-wiring.test.mjs's readAlertEvents).
function readDegradedEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) =>
      [BROKER_DEGRADED_EVENT, BROKER_RECOVERED_EVENT].includes(e?.attributes?.["event.name"]),
    );
}
const byName = (evs, name) => evs.filter((e) => e.attributes["event.name"] === name);
const degradedEvents = () => byName(readDegradedEvents(getEventLogPath()), BROKER_DEGRADED_EVENT);
const recoveredEvents = () => byName(readDegradedEvents(getEventLogPath()), BROKER_RECOVERED_EVENT);

// Backdate the broker start so every tick is past the 5-minute startup grace.
function pastGrace() {
  __setBrokerStartedAtForTest(new Date(Date.now() - 6 * 60 * 1000).toISOString());
}
// Open the activity gate: one fresh, non-terminal worker row → hasActiveWorkers().
function openActivityGate(ticket = "CTL-1523") {
  upsertWorkerState({
    orchestrator: "o",
    ticket,
    status: "implement",
    eventId: "e1",
    eventTs: new Date().toISOString(),
  });
}
// Close it: the same worker reaches a terminal status.
function closeActivityGate(ticket = "CTL-1523") {
  upsertWorkerState({
    orchestrator: "o",
    ticket,
    status: "done",
    eventId: "e2",
    eventTs: new Date(Date.now() + 1000).toISOString(),
  });
}
function interestsSize() {
  return getInterests().size;
}
function ticks(n) {
  for (let i = 0; i < n; i++) runWatchdogTick();
}

let dir;
let prevCatalystDir;
let prevDegradedEnabled;
beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  dir = mkdtempSync(join(tmpdir(), "broker-degraded-wiring-"));
  process.env.CATALYST_DIR = dir;
  // CTL-1523: the detector is OPT-IN and dormant by default (under execution-core
  // dispatch nothing registers interests, so the empty-interests conjunct is
  // permanently true and the gate carries no information — see
  // isBrokerDegradedDetectorEnabled; on a legacy-wave host, which DOES register
  // interests, it discriminates). Every wiring case below asserts the ARMED
  // behaviour, so arm it here; the opt-in-gate block overrides locally.
  prevDegradedEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
  process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
  closeBrokerStateDb();
  openBrokerStateDb(join(dir, "broker-state.db"));
  __clearIngestionRecencyForTest();
  __resetBrokerDegradedLatchForTest();
  clearInterests();
  clearLastHeartbeat();
  __resetBrokerStartedAtForTest();
});
afterEach(() => {
  closeBrokerStateDb();
  __resetBrokerDegradedLatchForTest();
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevDegradedEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
  else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevDegradedEnabled;
  rmSync(dir, { recursive: true, force: true });
});

describe("the idle-fleet regression (CTL-1523)", () => {
  test("(a) idle fleet + empty interests + 6-min uptime + many ticks → ZERO degraded", () => {
    pastGrace();
    // no worker rows at all → hasActiveWorkers() false → the discriminator holds
    ticks(SUSTAINED + 5);
    expect(degradedEvents()).toHaveLength(0);
    expect(recoveredEvents()).toHaveLength(0);
    // and nothing was latched, so no marker was written
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
  });
});

describe("degraded fires only for a genuinely-anomalous broker (CTL-1523)", () => {
  test("(b) active worker + empty interests + sustained ticks → exactly ONE degraded", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    const degraded = degradedEvents();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].severityText).toBe("WARN");
    expect(degraded[0].body.payload.reason).toBe("no registered interests while fleet is active");
    expect(degraded[0].body.payload.activeWorkers).toBe(true);
    expect(degraded[0].body.payload.sustainedTicks).toBe(SUSTAINED);
    expect(typeof degraded[0].body.payload.uptimeMs).toBe("number");
    // edge-triggered: further anomalous ticks do NOT re-emit
    ticks(3);
    expect(degradedEvents()).toHaveLength(1);
  });

  test("(c) below the sustained-tick threshold → no degraded yet", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED - 1);
    expect(degradedEvents()).toHaveLength(0);
    // the very next contiguous anomalous tick trips it
    ticks(1);
    expect(degradedEvents()).toHaveLength(1);
  });

  test("a non-anomalous tick in the middle resets the run (must be contiguous)", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED - 1);
    closeActivityGate(); // gate closes → run resets
    ticks(1);
    openActivityGate("CTL-1524"); // gate re-opens with a fresh row
    ticks(SUSTAINED - 1);
    expect(degradedEvents()).toHaveLength(0);
    ticks(1);
    expect(degradedEvents()).toHaveLength(1);
  });
});

describe("the paired recovery event (CTL-1523)", () => {
  test("(d) an interest registers after degraded → exactly one recovered", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-recover-1",
      detail: { interest_id: "recover-1", notify_event: "filter.wake.recover-1", prompt: "p" },
    });
    ticks(1);

    const recovered = recoveredEvents();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].severityText).toBe("INFO");
    expect(recovered[0].body.payload.reason).toBe("interests registered");
    expect(recovered[0].body.payload.interestCount).toBe(1);
    expect(typeof recovered[0].body.payload.degradedForMs).toBe("number");
    // and it does not re-emit on subsequent ticks
    ticks(2);
    expect(recoveredEvents()).toHaveLength(1);
  });

  test("(e) the fleet goes idle after degraded → exactly one recovered (fleet idle)", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);

    closeActivityGate(); // worker terminal → gate closes
    ticks(1);

    const recovered = recoveredEvents();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].body.payload.reason).toBe("fleet idle");
    expect(recovered[0].body.payload.interestCount).toBe(0);
    ticks(3);
    expect(recoveredEvents()).toHaveLength(1);
  });

  // Codex round 3 (T4): the interest-return edge that falls BETWEEN two ticks.
  // Replacing the CTL-352 synchronous re-arm with the watchdog's periodic
  // `interests.size` sample lost the one-shot case entirely: an interest that
  // registers AND deregisters inside the ~60 s tick interval was never observed, so
  // the `recovered` never fired and the stale latch suppressed every later degraded
  // episode until the fleet went idle.
  test("(d') an interest registered AND deregistered BETWEEN ticks still recovers", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);

    // A whole interest lifecycle with NO intervening watchdog tick.
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-oneshot",
      detail: { interest_id: "oneshot-1", notify_event: "filter.wake.oneshot-1", prompt: "p" },
    });
    handleDeregister({
      event: "filter.deregister",
      orchestrator: "orch-oneshot",
      detail: { interest_id: "oneshot-1" },
    });

    // The live table is empty again at sampling time — the sample alone sees nothing.
    ticks(1);
    const recovered = recoveredEvents();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].body.payload.reason).toBe("interests registered");

    // The edge is consumed by that one tick: it does not linger and re-clear later,
    // and the still-anomalous condition has to re-earn the full debounce.
    ticks(SUSTAINED - 2);
    expect(recoveredEvents()).toHaveLength(1);
    expect(degradedEvents()).toHaveLength(1);
  });

  test("a re-armed episode after a recovery emits a SECOND degraded", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED); // degraded #1
    closeActivityGate();
    ticks(1); // recovered #1
    openActivityGate("CTL-1525");
    ticks(SUSTAINED); // degraded #2
    expect(degradedEvents()).toHaveLength(2);
    expect(recoveredEvents()).toHaveLength(1);
  });
});

describe("the DURABLE latch (CTL-1523 — the restart-driven re-fire fix)", () => {
  test("(f) the latch survives a simulated restart: no duplicate degraded", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(true);
    expect(JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8")).latched).toBe(true);

    // Simulate a broker restart: only the IN-MEMORY latch is cleared, the on-disk
    // marker survives — exactly the ~5/day merge-triggered stack reload that made
    // the CTL-352 guard re-fire 104 times in July.
    __resetBrokerDegradedLatchForTest();
    pastGrace(); // a fresh process is past the grace again after 6 min
    ticks(SUSTAINED + 3); // long enough to re-earn the debounce if the latch were lost

    expect(degradedEvents()).toHaveLength(1);
    expect(recoveredEvents()).toHaveLength(0);
  });

  test("a restart mid-episode still emits the recovery when the condition clears", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    __resetBrokerDegradedLatchForTest(); // restart
    pastGrace();
    closeActivityGate();
    ticks(1);
    expect(recoveredEvents()).toHaveLength(1);
    expect(degradedEvents()).toHaveLength(1);
  });
});

describe("the opt-in gate (CTL-1523)", () => {
  // Run `fn` with FILTER_BROKER_DEGRADED_ENABLED forced to `value` (undefined =
  // unset), restoring whatever the outer beforeEach installed. Same save/restore
  // idiom as the rest of the file, scoped to one case.
  const withDegradedEnv = (value, fn) => {
    const prev = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    if (value === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
      else process.env.FILTER_BROKER_DEGRADED_ENABLED = prev;
    }
  };

  // (g) THE DEFAULT. Unset is the production state on every execution-core host: the
  // detector must be completely inert — no event, and no latch marker written.
  for (const [label, value] of [
    ["UNSET — the production default", undefined],
    ["=0 — the explicit kill-switch", "0"],
    ["=true — anything that is not exactly \"1\"", "true"],
  ]) {
    test(`${label} → ZERO emits despite a genuine anomaly`, () => {
      withDegradedEnv(value, () => {
        pastGrace();
        openActivityGate();
        ticks(SUSTAINED + 3);
        expect(readDegradedEvents(getEventLogPath())).toHaveLength(0);
        expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
      });
    });
  }

  test('=1 opts in → the same anomaly emits exactly one degraded', () => {
    withDegradedEnv("1", () => {
      pastGrace();
      openActivityGate();
      ticks(SUSTAINED);
      expect(degradedEvents()).toHaveLength(1);
    });
  });
});

// CTL-1523 (review): the ONLY site that actually PRODUCES the `null` (unknown)
// activity reading is fleetActivity's catch in router.mjs. Every other F2 test
// injects `fleetActive` straight into the pure classifiers or into
// checkBrokerDegraded, so reverting that catch to `return false` left the whole
// suite green — which de-fanged the fix. This pins it end-to-end: a real
// broker-state read failure must be UNKNOWN (latch holds), never "proven idle"
// (which would emit a false `recovered` and then a duplicate degraded edge once
// the DB recovers).
describe("an unavailable activity reading is UNKNOWN, not idle (end-to-end)", () => {
  test("a broker-state read failure holds a latched episode instead of clearing it", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);
    expect(recoveredEvents()).toHaveLength(0);

    // Make the REAL read fail the way a transient SQLite error would: the
    // handle is gone, so hasActiveWorkers throws and fleetActivity catches.
    closeBrokerStateDb();

    expect(() => ticks(10)).not.toThrow(); // runWatchdogTick must never throw
    expect(recoveredEvents()).toHaveLength(0); // <- the guard: no false recovery
    expect(degradedEvents()).toHaveLength(1); // and no duplicate degraded

    // The durable latch is still open, so the owed recovery is still owed.
    const latch = JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8"));
    expect(latch.latched).toBe(true);

    // Once the read works again AND the fleet is genuinely idle, it clears once.
    // (Reopening alone is not enough: the worker row is still fresh, so activity
    // reads `true` — which is itself the point, unknown never became idle.)
    openBrokerStateDb(join(dir, "broker-state.db"));
    ticks(1);
    expect(recoveredEvents()).toHaveLength(0); // still active, still no recovery
    closeActivityGate();
    ticks(1);
    expect(recoveredEvents()).toHaveLength(1);
    expect(recoveredEvents()[0].attributes["event.name"]).toBe(BROKER_RECOVERED_EVENT);
  });
});

// Codex P2 round 4 (#2740): the cross-tick registration edge is EVIDENCE, and the
// only thing making the clear verdict true for a one-shot interest. Consuming it
// before the append meant a FAILED `recovered` destroyed it — latch stranded open,
// suppressing every later degraded until an unrelated registration or an idle fleet.
describe("the interest edge survives a failed recovery append (round 4)", () => {
  test("a failed recovered retries on the next tick instead of losing the edge", () => {
    pastGrace();
    openActivityGate();
    ticks(SUSTAINED);
    expect(degradedEvents()).toHaveLength(1);

    // One-shot interest: registers and deregisters entirely between ticks.
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-round4",
      detail: { interest_id: "r4", notify_event: "filter.wake.r4", prompt: "p" },
    });
    handleDeregister({ event: "filter.deregister", detail: { interest_id: "r4" } });
    expect(interestsSize()).toBe(0); // live table is empty again

    // Make the append fail for this tick by pointing the event log at a directory.
    const logPath = getEventLogPath();
    const saved = readFileSync(logPath, "utf8");
    rmSync(logPath, { force: true });
    mkdirSync(logPath, { recursive: true });
    ticks(1);
    // Append failed, so the episode is still open and owes a recovered.
    rmSync(logPath, { recursive: true, force: true });
    writeFileSync(logPath, saved);
    expect(recoveredEvents()).toHaveLength(0);

    // The edge must NOT have been spent: the next tick retries and lands it.
    ticks(1);
    expect(recoveredEvents()).toHaveLength(1);
    expect(recoveredEvents()[0].body.payload.reason).toBe("interests registered");
  });
});
