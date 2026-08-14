// webhook-route-health.test.ts — CTL-1841. Unit tests for the pure route-comparison
// detector. Each gherkin scenario maps 1:1 to a named test; the positive-control replay
// MUST fail if the detector is stubbed to raise:false.

import { describe, it, expect } from "bun:test";
import {
  initialRouteHealthState,
  classifyLinearWebhookHealth,
  nextLinearWebhook401Latch,
  resolveWebhookRouteHealthConfig,
  buildRouteHealthMarker,
} from "../webhook-route-health";

const CFG = resolveWebhookRouteHealthConfig({});
const MIN = 60_000;

describe("classifyLinearWebhookHealth", () => {
  // Gherkin scenario 1 — Linear 4xx while GitHub 200s → raise
  it("raises when Linear is non-2xx-only past threshold and GitHub is healthy", () => {
    const now = 1_000 * MIN;
    const state = {
      lastLinear2xxMs: null, // Linear NEVER succeeded
      lastLinearFailMs: now - 1 * MIN, // a recent 401
      lastGithub2xxMs: now - 2 * MIN, // GitHub control is live
    };
    const v = classifyLinearWebhookHealth(state, now, CFG);
    expect(v.raise).toBe(true);
    expect(v.clear).toBe(false);
    expect(v.route).toBe("/api/webhook/linear");
  });

  // Gherkin scenario 2 — genuinely quiet → do NOT raise
  it("does not raise when there are no Linear failures at all", () => {
    const now = 1_000 * MIN;
    const state = {
      lastLinear2xxMs: null,
      lastLinearFailMs: null,
      lastGithub2xxMs: now - 1 * MIN,
    };
    expect(classifyLinearWebhookHealth(state, now, CFG).raise).toBe(false);
  });

  // Positive control — MUST FAIL if the detector is removed (2026-08-14 replay)
  it("raises on the 2026-08-14 replay: every Linear delivery 401s while GitHub 200s", () => {
    let state = initialRouteHealthState();
    const t0 = 500 * MIN;
    // GitHub keeps succeeding; Linear keeps failing
    for (let i = 0; i <= CFG.silentThresholdMs / MIN; i++) {
      const t = t0 + i * MIN;
      state = { ...state, lastLinearFailMs: t, lastGithub2xxMs: t };
    }
    const now = t0 + (CFG.silentThresholdMs / MIN) * MIN + 1;
    expect(classifyLinearWebhookHealth(state, now, CFG).raise).toBe(true);
  });

  it("does NOT raise before the silent threshold elapses", () => {
    const now = 1_000 * MIN;
    // A recent success means the "no ok for >= threshold" condition isn't met
    const stateRecentOk = {
      lastLinear2xxMs: now - 1 * MIN,
      lastLinearFailMs: now - 30_000,
      lastGithub2xxMs: now - 1 * MIN,
    };
    expect(classifyLinearWebhookHealth(stateRecentOk, now, CFG).raise).toBe(false);
  });

  it("does not raise when GitHub control is also stale (cannot prove the tunnel is up)", () => {
    const now = 1_000 * MIN;
    const state = {
      lastLinear2xxMs: null,
      lastLinearFailMs: now - 1 * MIN,
      lastGithub2xxMs: now - 999 * MIN, // GitHub way outside its healthy window
    };
    expect(classifyLinearWebhookHealth(state, now, CFG).raise).toBe(false);
  });

  it("clears when a Linear 2xx arrives after the failures (operator fixed the secret)", () => {
    const now = 1_000 * MIN;
    const state = {
      lastLinear2xxMs: now - 30_000,
      lastLinearFailMs: now - 5 * MIN,
      lastGithub2xxMs: now - 1 * MIN,
    };
    const v = classifyLinearWebhookHealth(state, now, CFG);
    expect(v.clear).toBe(true);
    expect(v.raise).toBe(false);
  });

  it("does not raise when Linear last outcome was a success even if there were prior failures", () => {
    const now = 1_000 * MIN;
    // last ok is MORE RECENT than last fail — last outcome is success
    const state = {
      lastLinear2xxMs: now - 1 * MIN,
      lastLinearFailMs: now - 20 * MIN,
      lastGithub2xxMs: now - 1 * MIN,
    };
    expect(classifyLinearWebhookHealth(state, now, CFG).raise).toBe(false);
  });

  it("does not raise when no GitHub control seen at all", () => {
    const now = 1_000 * MIN;
    const state = {
      lastLinear2xxMs: null,
      lastLinearFailMs: now - 1 * MIN,
      lastGithub2xxMs: null, // no GitHub data
    };
    expect(classifyLinearWebhookHealth(state, now, CFG).raise).toBe(false);
  });
});

describe("nextLinearWebhook401Latch (edge machine, EMIT-THEN-ADVANCE)", () => {
  it("fires 'raised' only on the rising edge", () => {
    expect(
      nextLinearWebhook401Latch(false, { raise: true, clear: false }).emit,
    ).toBe("raised");
    expect(
      nextLinearWebhook401Latch(true, { raise: true, clear: false }).emit,
    ).toBe(null); // already latched
  });

  it("fires 'recovered' only on the falling edge", () => {
    expect(
      nextLinearWebhook401Latch(true, { raise: false, clear: true }).emit,
    ).toBe("recovered");
    expect(
      nextLinearWebhook401Latch(false, { raise: false, clear: true }).emit,
    ).toBe(null);
  });

  it("advances the latch state correctly", () => {
    const rising = nextLinearWebhook401Latch(false, { raise: true, clear: false });
    expect(rising.latched).toBe(true);

    const falling = nextLinearWebhook401Latch(true, { raise: false, clear: true });
    expect(falling.latched).toBe(false);

    const steady = nextLinearWebhook401Latch(true, { raise: false, clear: false });
    expect(steady.latched).toBe(true);
    expect(steady.emit).toBe(null);
  });
});

describe("resolveWebhookRouteHealthConfig", () => {
  it("applies frozen defaults", () => {
    const cfg = resolveWebhookRouteHealthConfig({});
    expect(cfg.silentThresholdMs).toBe(15 * MIN);
    expect(cfg.failRecencyWindowMs).toBe(30 * MIN);
    expect(cfg.githubHealthyWindowMs).toBe(30 * MIN);
    expect(cfg.tickMs).toBe(MIN);
    expect(cfg.enabled).toBe(true);
  });

  it("accepts overrides via fileCfg", () => {
    const cfg = resolveWebhookRouteHealthConfig({ silentThresholdMs: 5 * MIN });
    expect(cfg.silentThresholdMs).toBe(5 * MIN);
    // others still default
    expect(cfg.failRecencyWindowMs).toBe(30 * MIN);
  });
});

describe("buildRouteHealthMarker", () => {
  it("carries latch + all three stamps + host + ts", () => {
    const state = initialRouteHealthState();
    const m = buildRouteHealthMarker({
      latched: true,
      latchedAtMs: 123,
      state,
      nowMs: 456,
    });
    expect(m.latched).toBe(true);
    expect(m.latchedAtMs).toBe(123);
    expect(m).toHaveProperty("lastLinearFailMs");
    expect(m).toHaveProperty("lastLinear2xxMs");
    expect(m).toHaveProperty("lastGithub2xxMs");
    expect(m).toHaveProperty("ts");
    expect(typeof m.ts).toBe("string");
  });

  it("uses the provided host", () => {
    const m = buildRouteHealthMarker({
      latched: false,
      latchedAtMs: null,
      state: initialRouteHealthState(),
      nowMs: 1000,
      host: "test-host",
    });
    expect(m.host).toBe("test-host");
  });
});
