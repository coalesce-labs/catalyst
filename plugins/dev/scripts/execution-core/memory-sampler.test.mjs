// memory-sampler.test.mjs — CTL-685. The memory-sampler core: classifyMemPressure,
// hysteresis, WARN/KILL escalation, killEnabled gate, non-background skip,
// transient resilience, counter pruning, and stop(). All dependencies injected;
// tick() called directly — no real timer.
//
// Run: cd plugins/dev/scripts/execution-core && bun test memory-sampler.test.mjs

import { test, expect, describe } from "bun:test";
import { classifyMemPressure, startMemorySampler } from "./memory-sampler.mjs";
import {
  MEMORY_EVENT_SAMPLED,
  MEMORY_EVENT_WARN,
  MEMORY_EVENT_KILLED,
} from "./memory-event.mjs";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const SHORT = "aaaaaaaa";

// Recording fake clock
function recordingClock() {
  const handle = { id: Symbol("interval") };
  let cleared = false;
  return {
    setInterval: () => handle,
    clearInterval: (h) => {
      if (h === handle) cleared = true;
    },
    handle,
    wasCleared: () => cleared,
  };
}

// Fake ps snapshot for a single pid with a given RSS in KB
function fakePsLines(pid, rssKb) {
  return [`${pid} 1 ${rssKb}`];
}

// Build a minimal agent record
function agent(opts = {}) {
  return {
    sessionId: opts.sessionId ?? SID,
    kind: opts.kind ?? "background",
    pid: opts.pid ?? 12345,
    name: opts.name ?? `o-orch:CTL-685:implement:1`,
    cwd: opts.cwd ?? "/wt/CTL-685",
    ...opts,
  };
}

// Build a test harness
function harness({
  agentsRef,
  psRef,
  killEnabled = true,
  killSustainedSamples = 3,
  warnThresholdMb = 1500,
  killThresholdMb = 4000,
  hostFreeFloorMb = 4096,
  getHostFreeMb = () => 33_000, // default: plenty of headroom, matches aldebaran's normal state
}) {
  const emitted = [];
  const killed = [];
  const marked = [];
  const clock = recordingClock();
  const w = startMemorySampler({
    clock,
    config: {
      intervalMs: 30_000,
      warnThresholdMb,
      killThresholdMb,
      hostFreeFloorMb,
      killEnabled,
      killSustainedSamples,
    },
    listAgents: () => agentsRef.current,
    psLines: () => psRef.current,
    emit: (name, payload) => emitted.push({ name, payload }),
    killWorker: (shortId) => killed.push(shortId),
    markOom: (ag, meta) => marked.push({ ag, meta }),
    resolveMeta: () => ({
      ticket: "CTL-685",
      phase: "implement",
      shortId: SHORT,
    }),
    getHostFreeMb,
  });
  return { w, emitted, killed, marked, clock };
}

// ─── classifyMemPressure ─────────────────────────────────────────────────────

describe("classifyMemPressure (pure)", () => {
  const thresholds = { warnThresholdMb: 1500, killThresholdMb: 4000 };

  test("below warn threshold → OK", () => {
    expect(classifyMemPressure(1000, thresholds)).toBe("OK");
    expect(classifyMemPressure(0, thresholds)).toBe("OK");
    expect(classifyMemPressure(1499, thresholds)).toBe("OK");
  });

  test("exactly at warn threshold → WARN", () => {
    expect(classifyMemPressure(1500, thresholds)).toBe("WARN");
  });

  test("between warn and kill → WARN", () => {
    expect(classifyMemPressure(2000, thresholds)).toBe("WARN");
    expect(classifyMemPressure(3999, thresholds)).toBe("WARN");
  });

  test("exactly at kill threshold → KILL", () => {
    expect(classifyMemPressure(4000, thresholds)).toBe("KILL");
  });

  test("above kill threshold → KILL", () => {
    expect(classifyMemPressure(5000, thresholds)).toBe("KILL");
  });
});

describe("classifyMemPressure — headroom-aware KILL (CTL-1533)", () => {
  // A high-memory worker that would have hit the OLD flat killThresholdMb,
  // but the new absolute backstop is raised well above it.
  const highBackstop = { warnThresholdMb: 1500, killThresholdMb: 24_000 };

  test("above warnThreshold but host has plenty of free memory → WARN, not KILL", () => {
    expect(
      classifyMemPressure(9500, { ...highBackstop, hostFreeMb: 33_000, hostFreeFloorMb: 4096 })
    ).toBe("WARN");
  });

  test("above warnThreshold AND host free memory below the floor → KILL", () => {
    expect(
      classifyMemPressure(2000, { ...highBackstop, hostFreeMb: 3000, hostFreeFloorMb: 4096 })
    ).toBe("KILL");
  });

  test("exactly at the host-free floor is NOT below it → WARN", () => {
    expect(
      classifyMemPressure(2000, { ...highBackstop, hostFreeMb: 4096, hostFreeFloorMb: 4096 })
    ).toBe("WARN");
  });

  test("one MB below the floor → KILL", () => {
    expect(
      classifyMemPressure(2000, { ...highBackstop, hostFreeMb: 4095, hostFreeFloorMb: 4096 })
    ).toBe("KILL");
  });

  test("host free memory omitted (no headroom wiring) → falls back to flat-threshold behavior", () => {
    // Below the (raised) absolute backstop, no host info at all → same as pre-CTL-1533: WARN only.
    expect(classifyMemPressure(9500, highBackstop)).toBe("WARN");
  });

  test("hostFreeFloorMb omitted but hostFreeMb present → headroom path stays disabled (both required)", () => {
    expect(classifyMemPressure(2000, { ...highBackstop, hostFreeMb: 100 })).toBe("WARN");
  });

  test("absolute backstop still fires even when host has free memory (runaway safety valve)", () => {
    expect(
      classifyMemPressure(24_000, { ...highBackstop, hostFreeMb: 33_000, hostFreeFloorMb: 4096 })
    ).toBe("KILL");
  });

  test("below warnThreshold is OK regardless of host pressure", () => {
    expect(
      classifyMemPressure(1000, { ...highBackstop, hostFreeMb: 0, hostFreeFloorMb: 4096 })
    ).toBe("OK");
  });
});

// ─── Sampler tick behaviour ──────────────────────────────────────────────────

test("emits exactly one sampled event per tick for a healthy worker (800 MB)", () => {
  const agentsRef = { current: [agent()] };
  // 800 MB in KB = 819200 KB
  const psRef = { current: fakePsLines(12345, 819200) };
  const { w, emitted } = harness({ agentsRef, psRef });

  w.tick();
  const sampledEvents = emitted.filter((e) => e.name === MEMORY_EVENT_SAMPLED);
  expect(sampledEvents.length).toBe(1);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_WARN).length).toBe(0);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_KILLED).length).toBe(0);
});

test("emits warn when worker crosses warnThreshold (1800 MB)", () => {
  const agentsRef = { current: [agent()] };
  // 1800 MB in KB = 1843200 KB
  const psRef = { current: fakePsLines(12345, 1843200) };
  const { w, emitted } = harness({ agentsRef, psRef });

  w.tick();
  const warnEvents = emitted.filter((e) => e.name === MEMORY_EVENT_WARN);
  expect(warnEvents.length).toBe(1);
  expect(warnEvents[0].payload.threshold_mb).toBe(1500);
  // sampled also fires
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_SAMPLED).length).toBe(1);
});

test("no kill after 1 or 2 consecutive KILL-level ticks (hysteresis)", () => {
  const agentsRef = { current: [agent()] };
  // 5000 MB in KB = 5120000 KB
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed, emitted } = harness({ agentsRef, psRef, killSustainedSamples: 3 });

  w.tick(); // tick 1 — above kill, n=1
  w.tick(); // tick 2 — above kill, n=2
  expect(killed.length).toBe(0);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_KILLED).length).toBe(0);
});

test("kills worker and emits killed after killSustainedSamples=3 consecutive KILL ticks", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed, marked, emitted } = harness({
    agentsRef,
    psRef,
    killSustainedSamples: 3,
  });

  w.tick(); // n=1
  w.tick(); // n=2
  w.tick(); // n=3 → kill fires
  expect(killed.length).toBe(1);
  expect(killed[0]).toBe(SHORT);
  expect(marked.length).toBe(1);
  const killedEvents = emitted.filter((e) => e.name === MEMORY_EVENT_KILLED);
  expect(killedEvents.length).toBe(1);
  expect(killedEvents[0].payload.sample_count).toBe(3);
});

test("counter resets after kill; next 3 ticks triggers another kill", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed } = harness({ agentsRef, psRef, killSustainedSamples: 3 });

  w.tick(); w.tick(); w.tick(); // first kill
  expect(killed.length).toBe(1);

  w.tick(); w.tick(); // not yet
  expect(killed.length).toBe(1);

  w.tick(); // second kill
  expect(killed.length).toBe(2);
});

test("hysteresis reset: drop to healthy before reaching killSustainedSamples clears counter", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed } = harness({ agentsRef, psRef, killSustainedSamples: 3 });

  w.tick(); w.tick(); // n=2, still no kill
  // Drop to healthy (800 MB)
  psRef.current = fakePsLines(12345, 819200);
  w.tick(); // counter cleared
  expect(killed.length).toBe(0);

  // Back to high: needs fresh 3 consecutive
  psRef.current = fakePsLines(12345, 5120000);
  w.tick(); w.tick(); // n=1, n=2
  expect(killed.length).toBe(0);
  w.tick(); // n=3 → kill
  expect(killed.length).toBe(1);
});

test("killEnabled:false — sustained breach emits warn but never kills or marks", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed, marked, emitted } = harness({
    agentsRef,
    psRef,
    killEnabled: false,
    killSustainedSamples: 1,
  });

  w.tick(); w.tick(); w.tick();
  expect(killed.length).toBe(0);
  expect(marked.length).toBe(0);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_KILLED).length).toBe(0);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_WARN).length).toBeGreaterThan(0);
});

test("only background agents are processed; interactive and pid-less agents are skipped", () => {
  const agentsRef = {
    current: [
      { ...agent(), kind: "interactive" },
      { ...agent({ sessionId: "bbbb" }), pid: null },
    ],
  };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, emitted } = harness({ agentsRef, psRef });

  w.tick();
  expect(emitted.length).toBe(0);
});

test("transient resilience: listAgents throwing does not crash tick and emits nothing", () => {
  const emitted = [];
  const clock = recordingClock();
  const w = startMemorySampler({
    clock,
    config: { intervalMs: 30_000, warnThresholdMb: 1500, killThresholdMb: 4000, killEnabled: true, killSustainedSamples: 3 },
    listAgents: () => { throw new Error("claude agents failed"); },
    psLines: () => [],
    emit: (name, payload) => emitted.push({ name, payload }),
    killWorker: () => {},
    markOom: () => {},
    resolveMeta: () => ({}),
  });
  expect(() => w.tick()).not.toThrow();
  expect(emitted.length).toBe(0);
});

test("counter pruning: vanished agent has its aboveKillSince entry removed", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 5120000) };
  const { w, killed } = harness({ agentsRef, psRef, killSustainedSamples: 3 });

  w.tick(); w.tick(); // n=2, agent still present
  // Remove the agent
  agentsRef.current = [];
  w.tick(); // pruned; n resets
  // Bring it back
  agentsRef.current = [agent()];
  w.tick(); w.tick(); // n=1, n=2
  expect(killed.length).toBe(0);
  w.tick(); // n=3 → kill
  expect(killed.length).toBe(1);
});

test("stop() calls clock.clearInterval with the registered handle", () => {
  const clock = recordingClock();
  const w = startMemorySampler({
    clock,
    config: { intervalMs: 30_000, warnThresholdMb: 1500, killThresholdMb: 4000, killEnabled: true, killSustainedSamples: 3 },
    listAgents: () => [],
    psLines: () => [],
    emit: () => {},
    killWorker: () => {},
    markOom: () => {},
    resolveMeta: () => ({}),
  });
  expect(clock.wasCleared()).toBe(false);
  w.stop();
  expect(clock.wasCleared()).toBe(true);
});

// ─── Headroom-aware tick behaviour (CTL-1533) ────────────────────────────────

test("a high-RSS worker is NOT killed when the host has plenty of free memory", () => {
  const agentsRef = { current: [agent()] };
  // 9500 MB — well above warnThresholdMb, well below the raised 24000 MB backstop.
  const psRef = { current: fakePsLines(12345, 9_500 * 1024) };
  const { w, killed, emitted } = harness({
    agentsRef,
    psRef,
    killThresholdMb: 24_000,
    hostFreeFloorMb: 4096,
    getHostFreeMb: () => 33_000, // matches aldebaran's real measured headroom
    killSustainedSamples: 3,
  });

  w.tick(); w.tick(); w.tick();
  expect(killed.length).toBe(0);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_KILLED).length).toBe(0);
  // Still warns — the ladder is intact, just doesn't escalate to KILL.
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_WARN).length).toBeGreaterThan(0);
});

test("the same worker IS killed once host free memory drops below the floor", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 9_500 * 1024) };
  const { w, killed, marked, emitted } = harness({
    agentsRef,
    psRef,
    killThresholdMb: 24_000,
    hostFreeFloorMb: 4096,
    getHostFreeMb: () => 2_000, // host is genuinely short on memory
    killSustainedSamples: 3,
  });

  w.tick(); w.tick(); w.tick();
  expect(killed.length).toBe(1);
  expect(marked.length).toBe(1);
  expect(emitted.filter((e) => e.name === MEMORY_EVENT_KILLED).length).toBe(1);
});

test("sampled + warn payloads carry host_free_mb for observability", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 1_800 * 1024) };
  const { w, emitted } = harness({ agentsRef, psRef, getHostFreeMb: () => 12_345 });

  w.tick();
  const sampled = emitted.find((e) => e.name === MEMORY_EVENT_SAMPLED);
  const warn = emitted.find((e) => e.name === MEMORY_EVENT_WARN);
  expect(sampled.payload.host_free_mb).toBe(12_345);
  expect(warn.payload.host_free_mb).toBe(12_345);
});

test("getHostFreeMb throwing does not crash the tick (degrades to backstop-only)", () => {
  const agentsRef = { current: [agent()] };
  const psRef = { current: fakePsLines(12345, 9_500 * 1024) };
  const { w, killed, emitted } = harness({
    agentsRef,
    psRef,
    killThresholdMb: 24_000,
    hostFreeFloorMb: 4096,
    getHostFreeMb: () => {
      throw new Error("os.freemem failed");
    },
    killSustainedSamples: 3,
  });

  expect(() => {
    w.tick(); w.tick(); w.tick();
  }).not.toThrow();
  // hostFreeMb resolves to null → headroom path disabled → below the raised
  // backstop → never kills, same as the pre-CTL-1533 fallback.
  expect(killed.length).toBe(0);
  const sampled = emitted.find((e) => e.name === MEMORY_EVENT_SAMPLED);
  expect(sampled.payload.host_free_mb).toBe(null);
});

test("rss_mb in sampled payload rounds correctly from KB snapshot", () => {
  const agentsRef = { current: [agent()] };
  // 1500 * 1024 = 1536000 KB → rssTotalForPid returns 1536000 → Math.round(1536000/1024) = 1500
  const psRef = { current: fakePsLines(12345, 1536000) };
  const { w, emitted } = harness({ agentsRef, psRef });

  w.tick();
  const sampled = emitted.find((e) => e.name === MEMORY_EVENT_SAMPLED);
  expect(sampled.payload.rss_mb).toBe(1500);
});
