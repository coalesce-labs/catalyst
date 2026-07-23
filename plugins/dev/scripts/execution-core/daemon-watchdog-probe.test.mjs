// daemon-watchdog-probe.test.mjs — CTL-1502. The probe state machine: hysteresis,
// off/shadow/enforce gating, restart-with-cooldown, a post-restart verify window,
// and escalation. A structural clone of the fleet-health probe: fake clock,
// injected readers/restart/alert, tick() called directly — no real timer, statSync,
// or execFile.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-watchdog-probe.test.mjs

import { test, expect, describe } from "bun:test";
import { startDaemonWatchdogProbe } from "./daemon-watchdog-probe.mjs";

const TARGET = {
  name: "otel-forward",
  dlqPath: "/fake/dlq",
  checkpointPath: "/fake/ck",
  restartArgs: ["forward-restart"],
};

const DLQ_MAX = 100;

// Recording fake clock — setInterval returns a handle; tick() is driven manually.
function recordingClock() {
  const handle = { id: Symbol("interval"), unref() {} };
  let cleared = false;
  return {
    setInterval: () => handle,
    clearInterval: (h) => {
      if (h === handle) cleared = true;
    },
    wasCleared: () => cleared,
  };
}

// Build a probe with fully-injected deps + a `ctl` handle to drive the scenario.
function makeProbe({ mode = "enforce", sustainedTicks = 2, verifyTicks = 2, cooldownMs = 10_000, targets = [TARGET], readDlqThrows = false } = {}) {
  const ctl = { stuck: false, nowMs: 1_000_000, restartCalls: 0, restartThrows: false };
  const alertCalls = { raise: 0, clear: 0, escalate: 0, lastEscalate: null };
  const logCalls = [];
  const alert = {
    raiseAlert: () => { alertCalls.raise += 1; },
    clearAlert: () => { alertCalls.clear += 1; },
    escalate: (t, p) => { alertCalls.escalate += 1; alertCalls.lastEscalate = p; },
  };
  const probe = startDaemonWatchdogProbe({
    clock: recordingClock(),
    config: { mode, intervalMs: 120_000, dlqMaxBytes: DLQ_MAX, stalenessMs: 900_000, cooldownMs, sustainedTicks, verifyTicks },
    targets,
    readDlqBytes: () => {
      if (readDlqThrows) throw new Error("statSync boom");
      return ctl.stuck ? DLQ_MAX : 0;
    },
    readLagStuck: () => false,
    restart: async () => {
      ctl.restartCalls += 1;
      if (ctl.restartThrows) throw new Error("restart boom");
    },
    alert,
    now: () => ctl.nowMs,
    log: { warn: (o, m) => logCalls.push(["warn", m]), info: (o, m) => logCalls.push(["info", m]), error: (o, m) => logCalls.push(["error", m]) },
    io: {},
  });
  return { probe, ctl, alertCalls, logCalls, get restartCalls() { return ctl.restartCalls; } };
}

describe("healthy", () => {
  test("healthy tick → no emit, no restart", async () => {
    const { probe, ctl, alertCalls } = makeProbe();
    ctl.stuck = false;
    await probe.tick();
    await probe.tick();
    expect(ctl.restartCalls).toBe(0);
    expect(alertCalls.raise).toBe(0);
    expect(alertCalls.clear).toBe(0);
  });
});

describe("shadow mode — detect + log, mutate nothing", () => {
  test("sustained breach logs would-restart, restart NEVER called, no alert raised", async () => {
    const { probe, ctl, alertCalls, logCalls } = makeProbe({ mode: "shadow", sustainedTicks: 2 });
    ctl.stuck = true;
    await probe.tick(); // sustained=1
    await probe.tick(); // sustained=2 → would-restart
    expect(ctl.restartCalls).toBe(0);
    expect(alertCalls.raise).toBe(0);
    expect(alertCalls.escalate).toBe(0);
    expect(logCalls.some(([, m]) => /would-restart/.test(m))).toBe(true);
  });
});

describe("enforce mode — restart with hysteresis + cooldown", () => {
  test("breach sustained to sustainedTicks → restart EXACTLY once + raiseAlert once", async () => {
    const { probe, ctl, alertCalls } = makeProbe({ mode: "enforce", sustainedTicks: 2 });
    ctl.stuck = true;
    await probe.tick(); // sustained=1 < 2 → nothing
    expect(ctl.restartCalls).toBe(0);
    await probe.tick(); // sustained=2 → restart
    expect(ctl.restartCalls).toBe(1);
    expect(alertCalls.raise).toBe(1);
  });

  test("cooldown: a second episode's breach within cooldownMs does NOT restart again", async () => {
    const { probe, ctl } = makeProbe({ mode: "enforce", sustainedTicks: 1, cooldownMs: 10_000 });
    // Episode 1: restart at t=1_000_000
    ctl.stuck = true;
    await probe.tick();
    expect(ctl.restartCalls).toBe(1);
    // Healthy tick clears/re-arms the episode (restartedAt persists for cooldown)
    ctl.stuck = false;
    await probe.tick();
    // Episode 2 within cooldown window (advance only 5s < 10s)
    ctl.nowMs += 5_000;
    ctl.stuck = true;
    await probe.tick();
    expect(ctl.restartCalls).toBe(1); // cooldown blocks the second restart
  });

  test("after cooldown expires, a new episode CAN restart again", async () => {
    const { probe, ctl } = makeProbe({ mode: "enforce", sustainedTicks: 1, cooldownMs: 10_000 });
    ctl.stuck = true;
    await probe.tick(); // restart #1 at 1_000_000
    ctl.stuck = false;
    await probe.tick(); // clear/re-arm
    ctl.nowMs += 20_000; // past cooldown
    ctl.stuck = true;
    await probe.tick(); // restart #2
    expect(ctl.restartCalls).toBe(2);
  });
});

describe("verify window", () => {
  test("predicate clears within verifyTicks → clearAlert once, episode re-arms", async () => {
    const { probe, ctl, alertCalls } = makeProbe({ mode: "enforce", sustainedTicks: 1, verifyTicks: 2, cooldownMs: 0 });
    ctl.stuck = true;
    await probe.tick(); // restart
    expect(ctl.restartCalls).toBe(1);
    ctl.stuck = false;
    await probe.tick(); // healthy → clearAlert, re-arm
    expect(alertCalls.clear).toBe(1);
    expect(alertCalls.escalate).toBe(0);
    // a later breach (cooldown 0) can restart again → episode re-armed
    ctl.stuck = true;
    await probe.tick();
    expect(ctl.restartCalls).toBe(2);
  });

  test("still tripped after restart across verifyTicks → escalate once, NO second restart", async () => {
    const { probe, ctl, alertCalls } = makeProbe({ mode: "enforce", sustainedTicks: 1, verifyTicks: 2 });
    ctl.stuck = true;
    await probe.tick(); // restart (tick A)
    expect(ctl.restartCalls).toBe(1);
    await probe.tick(); // verifyCount=1
    expect(alertCalls.escalate).toBe(0);
    await probe.tick(); // verifyCount=2 → escalate
    expect(alertCalls.escalate).toBe(1);
    await probe.tick(); // still stuck, already escalated → nothing new
    expect(alertCalls.escalate).toBe(1);
    expect(ctl.restartCalls).toBe(1); // NEVER a second restart within the episode
  });
});

describe("fail-open + registry robustness", () => {
  test("a reader that throws → treated as healthy, tick never throws", async () => {
    const { probe, ctl, alertCalls } = makeProbe({ mode: "enforce", sustainedTicks: 1, readDlqThrows: true });
    await expect(probe.tick()).resolves.toBeUndefined();
    await probe.tick();
    expect(ctl.restartCalls).toBe(0);
    expect(alertCalls.raise).toBe(0);
  });

  test("a restart that throws is swallowed (tick never throws); state still advances", async () => {
    const { probe, ctl } = makeProbe({ mode: "enforce", sustainedTicks: 1 });
    ctl.stuck = true;
    ctl.restartThrows = true;
    await expect(probe.tick()).resolves.toBeUndefined();
    expect(ctl.restartCalls).toBe(1); // it was called; the throw was caught
  });

  test("a target with an unresolvable path is skipped; others still processed", async () => {
    const bad = { name: "bad", dlqPath: null, checkpointPath: null, restartArgs: ["x"] };
    const { probe, ctl } = makeProbe({ mode: "enforce", sustainedTicks: 1, targets: [bad, TARGET] });
    ctl.stuck = true;
    await probe.tick();
    // TARGET still got processed → 1 restart; bad was skipped (no crash)
    expect(ctl.restartCalls).toBe(1);
  });
});

describe("lifecycle", () => {
  test("stop() clears the interval", () => {
    const clock = recordingClock();
    const p = startDaemonWatchdogProbe({
      clock,
      config: { mode: "enforce", intervalMs: 1, dlqMaxBytes: DLQ_MAX, stalenessMs: 1, cooldownMs: 1, sustainedTicks: 1, verifyTicks: 1 },
      targets: [TARGET],
      readDlqBytes: () => 0,
      readLagStuck: () => false,
      restart: async () => {},
      alert: { raiseAlert() {}, clearAlert() {}, escalate() {} },
      now: () => 0,
      log: { warn() {}, info() {}, error() {} },
    });
    p.stop();
    expect(clock.wasCleared()).toBe(true);
  });

  test("off mode → tick is a no-op (defensive; daemon gates on enabled)", async () => {
    const { probe, ctl, alertCalls } = makeProbe({ mode: "off", sustainedTicks: 1 });
    ctl.stuck = true;
    await probe.tick();
    await probe.tick();
    expect(ctl.restartCalls).toBe(0);
    expect(alertCalls.raise).toBe(0);
  });
});
