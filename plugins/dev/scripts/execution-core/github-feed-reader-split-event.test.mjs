// CTL-2011: Phase 3 tests — reader-split alertable events.
// Run: cd plugins/dev/scripts && bun test execution-core/github-feed-reader-split-event.test.mjs

import { describe, expect, it, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReaderSplit,
  EVENT_READERS_DIVERGED,
  EVENT_READERS_CONVERGED,
  startGithubFeedTimer,
} from "./github-feed-timer.mjs";
import { readGithubFeedConfig, resolveGithubFeedLayer2Mode } from "./config.mjs";

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

// ── Production wiring (CTL-2011 remediation) ─────────────────────────────────
//
// The tests above all INJECT resolveLayer2ModeFn, so they prove the timer's
// mechanism but say nothing about whether the daemon ever hands it a resolver.
// verify.json flagged exactly that gap: the sole production caller
// (daemon.mjs) defaulted resolveLayer2ModeFn to null, so the alarm was dead in
// prod (the CTL-1644 dead-detector family). These two tests lock the wiring:
// (1) the resolver the daemon uses actually strips the pin to produce the
// broker view, and (2) the daemon call site actually passes it.

describe("resolveGithubFeedLayer2Mode — the daemon's broker-view resolver", () => {
  // A hermetic HOME with no Layer-2 config → Layer-2 read falls through to the
  // "off" default. So an env pin that says "enforce" is a genuine split: the
  // exec-core view (pin honored) is enforce, the broker view (pin stripped) is off.
  const hermeticHome = () => {
    const d = join(tmpdir(), `cth-l2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("strips CATALYST_GITHUB_FEED so the broker view diverges from the pinned exec-core view", () => {
    const HOME = hermeticHome();
    const env = { HOME, CATALYST_GITHUB_FEED: "enforce" };
    // Exec-core view: pin honored.
    expect(readGithubFeedConfig(env).mode).toBe("enforce");
    // Broker view: pin stripped → falls through to the default.
    expect(resolveGithubFeedLayer2Mode(env).mode).toBe("off");
    // And the pair is exactly what classifyReaderSplit calls a divergence.
    const split = classifyReaderSplit({
      source: readGithubFeedConfig(env).source,
      effectiveMode: readGithubFeedConfig(env).mode,
      layer2Mode: resolveGithubFeedLayer2Mode(env).mode,
    });
    expect(split.diverged).toBe(true);
  });

  it("also strips CATALYST_GITHUB_FEED_INTERVAL_SEC (both pins gone in the broker view)", () => {
    const HOME = hermeticHome();
    const env = { HOME, CATALYST_GITHUB_FEED: "enforce", CATALYST_GITHUB_FEED_INTERVAL_SEC: "5" };
    const broker = resolveGithubFeedLayer2Mode(env);
    expect(broker.mode).toBe("off");
    // The interval-pin cannot leak through into the broker view.
    expect(broker.intervalSec).not.toBe(5);
  });

  it("no env pin → broker view equals exec-core view (no split)", () => {
    const HOME = hermeticHome();
    const env = { HOME };
    expect(resolveGithubFeedLayer2Mode(env).mode).toBe(readGithubFeedConfig(env).mode);
  });
});

describe("⛔ daemon wires resolveLayer2ModeFn into startGithubFeedTimer (else the alarm is dead in prod)", () => {
  // Comments are stripped before matching so an assertion cannot be satisfied by
  // prose that merely mentions the symbol (the CTL-50 false-read trap — the same
  // family as the finding this test remediates).
  const daemonSrc = readFileSync(join(import.meta.dir, "daemon.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  test("the startGithubFeedTimer({...}) call passes resolveLayer2ModeFn", () => {
    const callStart = daemonSrc.indexOf("startGithubFeedTimer({");
    expect(callStart).toBeGreaterThan(-1);
    // Bound the search to the call's own argument object so a resolveLayer2ModeFn
    // elsewhere in the file cannot satisfy this.
    const callEnd = daemonSrc.indexOf("});", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const callArgs = daemonSrc.slice(callStart, callEnd);
    expect(callArgs).toContain("resolveLayer2ModeFn:");
    expect(callArgs).toContain("resolveGithubFeedLayer2Mode(");
  });

  test("resolveGithubFeedLayer2Mode is imported from config.mjs", () => {
    expect(daemonSrc).toContain("resolveGithubFeedLayer2Mode");
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
