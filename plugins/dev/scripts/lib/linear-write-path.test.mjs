// CTL-1961 — the agent tools' write-path decision.
//
// The property that matters is NOT "shadow writes direct" (obvious); it is that
// "the proxy is OFF" and "I could not reach the proxy" are never collapsed into the
// same answer. Collapsing them is how a tool writes direct forever while looking routed
// — which is exactly what the first cut of this change did, by importing an export name
// that does not exist.
import { describe, test, expect } from "bun:test";
import { decideWritePath, WRITE_PROXY_MODES } from "./linear-write-path.mjs";

describe("decideWritePath — off", () => {
  test("off writes direct, says nothing, observes nothing", () => {
    expect(decideWritePath({ mode: "off", proxyReady: false })).toEqual({
      action: "direct",
      observe: false,
      reason: null,
    });
  });

  test("off is unaffected by a READY proxy — an installed transport is not a mandate", () => {
    expect(decideWritePath({ mode: "off", proxyReady: true }).action).toBe("direct");
    expect(decideWritePath({ mode: "off", proxyReady: true }).observe).toBe(false);
  });
});

describe("decideWritePath — enforce", () => {
  test("enforce with a ready proxy routes to the cloud", () => {
    expect(decideWritePath({ mode: "enforce", proxyReady: true })).toEqual({
      action: "proxy",
      observe: false,
      reason: null,
    });
  });

  test("⛔ THE DEFECT THIS PINS: enforce WITHOUT a proxy REFUSES — it must never write direct", () => {
    const d = decideWritePath({
      mode: "enforce",
      proxyReady: false,
      unavailableReason: "proxy modules unreachable: Cannot find module",
    });
    expect(d.action).toBe("refuse");
    // ⛔ the reason must survive to the operator — a bare refusal is not diagnosable
    expect(d.reason).toContain("Cannot find module");
  });

  test("enforce without a proxy AND without a stated reason still refuses, with a default one", () => {
    const d = decideWritePath({ mode: "enforce", proxyReady: false });
    expect(d.action).toBe("refuse");
    expect(typeof d.reason).toBe("string");
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("decideWritePath — shadow", () => {
  test("shadow with a ready proxy: direct write PLUS an observation", () => {
    expect(decideWritePath({ mode: "shadow", proxyReady: true })).toEqual({
      action: "direct",
      observe: true,
      reason: null,
    });
  });

  test("⭐ shadow with NO proxy still writes — but says why it could not observe", () => {
    // shadow's contract is "change nothing the operator can see in Linear", so an
    // unreachable proxy must not block the write. It must still be audible.
    const d = decideWritePath({ mode: "shadow", proxyReady: false, unavailableReason: "out-of-tree copy" });
    expect(d.action).toBe("direct");
    expect(d.observe).toBe(false);
    expect(d.reason).toBe("out-of-tree copy");
  });
});

describe("⛔ the distinction the whole module exists for", () => {
  test("`off` and `unavailable` are NEVER the same answer under enforce", () => {
    const off = decideWritePath({ mode: "off", proxyReady: false });
    const unavailable = decideWritePath({ mode: "enforce", proxyReady: false, unavailableReason: "x" });
    // Same inputs to a naive implementation ("no transport → write direct"); different answers here.
    expect(off.action).toBe("direct");
    expect(unavailable.action).toBe("refuse");
    expect(off.action).not.toBe(unavailable.action);
  });

  test("`off` and `unavailable` differ under shadow too — by the reason, not the action", () => {
    const off = decideWritePath({ mode: "off", proxyReady: false });
    const unavailable = decideWritePath({ mode: "shadow", proxyReady: false, unavailableReason: "x" });
    expect(off.action).toBe(unavailable.action); // both write
    expect(off.reason).toBeNull();
    expect(unavailable.reason).toBe("x"); // ...but only one of them is silent
  });
});

describe("⛔ unknown / hostile modes degrade to off, never to enforce", () => {
  test("a typo'd mode is treated as off — it must not REFUSE a write on a typo", () => {
    for (const bad of ["Enforce", "ENFORCE", "enforce ", "on", "true", "", null, undefined, 7, {}]) {
      const d = decideWritePath({ mode: bad, proxyReady: true });
      expect(d.action).toBe("direct");
      expect(d.observe).toBe(false);
    }
  });

  test("no arguments at all is `off`, not a crash", () => {
    expect(decideWritePath()).toEqual({ action: "direct", observe: false, reason: null });
  });

  test("the mode vocabulary is exactly these three", () => {
    expect([...WRITE_PROXY_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });
});
