// CTL-2011: Phase 3 tests — reader-split alertable events.
// Run: cd plugins/dev/scripts && bun test execution-core/github-feed-reader-split-event.test.mjs

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReaderSplit,
  EVENT_READERS_DIVERGED,
  EVENT_READERS_CONVERGED,
  startGithubFeedTimer,
} from "./github-feed-timer.mjs";

// Helper: get the event name from a canonical (v2) event object.
const eventName = (e) => e?.attributes?.["event.name"] ?? e?.name ?? null;

// ── Pure classifyReaderSplit ─────────────────────────────────────────────────

describe("classifyReaderSplit", () => {
  it("env pin + effective mode differs from layer2 → diverged:true", () => {
    const result = classifyReaderSplit({
      source: "env",
      effectiveMode: "shadow",
      layer2Mode: "enforce",
    });
    expect(result.diverged).toBe(true);
    expect(result.execMode).toBe("shadow");
    expect(result.layer2Mode).toBe("enforce");
  });

  it("source=layer2 → diverged:false regardless of modes", () => {
    const result = classifyReaderSplit({
      source: "layer2",
      effectiveMode: "enforce",
      layer2Mode: "enforce",
    });
    expect(result.diverged).toBe(false);
  });

  it("env pin agrees with layer2 → diverged:false", () => {
    const result = classifyReaderSplit({
      source: "env",
      effectiveMode: "enforce",
      layer2Mode: "enforce",
    });
    expect(result.diverged).toBe(false);
  });

  it("source=default → diverged:false (not an env override)", () => {
    const result = classifyReaderSplit({
      source: "default",
      effectiveMode: "off",
      layer2Mode: "enforce",
    });
    expect(result.diverged).toBe(false);
  });

  it("source=null → diverged:false (unknown origin)", () => {
    const result = classifyReaderSplit({
      source: null,
      effectiveMode: "shadow",
      layer2Mode: "enforce",
    });
    expect(result.diverged).toBe(false);
  });
});

// ── Edge-trigger via the timer ───────────────────────────────────────────────

describe("startGithubFeedTimer — reader-split events (Phase 3)", () => {
  const mkOrchDir = () => {
    const d = join(tmpdir(), `cth-split-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(d, { recursive: true });
    return d;
  };

  // Each test creates a corrupt DB to force the tick's sourceFactory to throw.
  // emitSplitEvent runs AFTER the try/catch, so split events still fire even
  // when the tick fails.
  const makeTimer = (orchDir, opts = {}) => {
    const corruptDb = join(orchDir, "test.db");
    writeFileSync(corruptDb, "this is not sqlite");
    const eventLog = join(orchDir, "events.jsonl");
    const captured = [];
    const timer = startGithubFeedTimer({
      mode: "shadow",
      source: "env",
      intervalSec: 30,
      orchDir,
      dbPath: corruptDb,
      eventLogPath: eventLog,
      appendFn: (path, content) => {
        if (path === eventLog) {
          try { captured.push(JSON.parse(content.trim())); } catch { /* skip */ }
        }
      },
      clock: { setInterval: () => null, clearInterval: () => {} },
      ...opts,
    });
    return { timer, captured };
  };

  it("emits exactly one readers-diverged across N ticks when split (latched)", () => {
    const orchDir = mkOrchDir();
    const { timer, captured } = makeTimer(orchDir, {
      resolveLayer2ModeFn: () => ({ mode: "enforce", intervalSec: 30, source: "layer2" }),
    });

    timer.tickNow();
    timer.tickNow();
    timer.tickNow();

    const diverged = captured.filter((e) => eventName(e) === EVENT_READERS_DIVERGED);
    expect(diverged).toHaveLength(1); // latched — not re-emitted on subsequent ticks
  });

  it("emits readers-converged when layer2 flips to match exec-core", () => {
    const orchDir = mkOrchDir();
    let layer2Mode = "enforce";
    const { timer, captured } = makeTimer(orchDir, {
      resolveLayer2ModeFn: () => ({ mode: layer2Mode, intervalSec: 30, source: "layer2" }),
    });

    timer.tickNow(); // diverge: shadow vs enforce → emit readers-diverged
    layer2Mode = "shadow"; // flip: now they agree
    timer.tickNow(); // converge: both shadow → emit readers-converged
    timer.tickNow(); // still converged: no new event

    const diverged = captured.filter((e) => eventName(e) === EVENT_READERS_DIVERGED);
    const converged = captured.filter((e) => eventName(e) === EVENT_READERS_CONVERGED);
    expect(diverged).toHaveLength(1);
    expect(converged).toHaveLength(1);
  });

  it("re-emits readers-diverged when split recurs after convergence", () => {
    const orchDir = mkOrchDir();
    let layer2Mode = "enforce";
    const { timer, captured } = makeTimer(orchDir, {
      resolveLayer2ModeFn: () => ({ mode: layer2Mode, intervalSec: 30, source: "layer2" }),
    });

    timer.tickNow(); // diverge
    layer2Mode = "shadow";
    timer.tickNow(); // converge
    layer2Mode = "enforce";
    timer.tickNow(); // diverge again

    const diverged = captured.filter((e) => eventName(e) === EVENT_READERS_DIVERGED);
    expect(diverged).toHaveLength(2); // each episode emits its own event
  });

  it("emits no split events when source=layer2 (both views agree by construction)", () => {
    const orchDir = mkOrchDir();
    const corruptDb = join(orchDir, "test.db");
    writeFileSync(corruptDb, "this is not sqlite");
    const eventLog = join(orchDir, "events.jsonl");
    const captured = [];
    const timer = startGithubFeedTimer({
      mode: "enforce",
      source: "layer2", // not an env pin → no split possible
      intervalSec: 30,
      orchDir,
      dbPath: corruptDb,
      eventLogPath: eventLog,
      appendFn: (path, content) => {
        if (path === eventLog) {
          try { captured.push(JSON.parse(content.trim())); } catch { /* skip */ }
        }
      },
      clock: { setInterval: () => null, clearInterval: () => {} },
      resolveLayer2ModeFn: () => ({ mode: "shadow", intervalSec: 30, source: "layer2" }),
    });

    timer.tickNow();
    timer.tickNow();

    const splitEvents = captured.filter(
      (e) => eventName(e) === EVENT_READERS_DIVERGED || eventName(e) === EVENT_READERS_CONVERGED,
    );
    expect(splitEvents).toHaveLength(0);
  });

  it("readers-diverged event carries exec/layer2 mode in attributes", () => {
    const orchDir = mkOrchDir();
    const { timer, captured } = makeTimer(orchDir, {
      resolveLayer2ModeFn: () => ({ mode: "enforce", intervalSec: 30, source: "layer2" }),
    });

    timer.tickNow();

    const evt = captured.find((e) => eventName(e) === EVENT_READERS_DIVERGED);
    expect(evt).toBeDefined();
    // Must carry the modes so an alert has context without reading the ready file.
    expect(evt.attributes?.["catalyst.github_feed.exec_mode"]).toBe("shadow");
    expect(evt.attributes?.["catalyst.github_feed.layer2_mode"]).toBe("enforce");
    expect(evt.attributes?.["catalyst.github_feed.source"]).toBe("env");
  });

  it("no split events when resolveLayer2ModeFn is not provided (default null = opt-in off)", () => {
    const orchDir = mkOrchDir();
    const { timer, captured } = makeTimer(orchDir, {
      // no resolveLayer2ModeFn — opt-in disabled
    });

    timer.tickNow();
    timer.tickNow();

    const splitEvents = captured.filter(
      (e) => eventName(e) === EVENT_READERS_DIVERGED || eventName(e) === EVENT_READERS_CONVERGED,
    );
    expect(splitEvents).toHaveLength(0);
  });
});

// ── Namespace parity ─────────────────────────────────────────────────────────

describe("namespace parity — EVENT_READERS_DIVERGED / EVENT_READERS_CONVERGED", () => {
  it("EVENT_READERS_DIVERGED is a non-empty string", () => {
    expect(typeof EVENT_READERS_DIVERGED).toBe("string");
    expect(EVENT_READERS_DIVERGED.length).toBeGreaterThan(0);
  });

  it("EVENT_READERS_CONVERGED is a non-empty string", () => {
    expect(typeof EVENT_READERS_CONVERGED).toBe("string");
    expect(EVENT_READERS_CONVERGED.length).toBeGreaterThan(0);
  });

  it("neither name collides with the broker-protected namespace", async () => {
    const { isBrokerProtectedName } = await import("../broker/namespace-contract.mjs");
    expect(isBrokerProtectedName(EVENT_READERS_DIVERGED)).toBe(false);
    expect(isBrokerProtectedName(EVENT_READERS_CONVERGED)).toBe(false);
  });
});
