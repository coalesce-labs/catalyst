// entitlement.test.mjs — CTL-1785 Phase 1. Unit suite for the entitlement leaf:
// the tri-state mode ladder (mirrors deployment-mode.test.mjs) and the local
// EntitlementProvider whose fail direction is ENTITLED (preserve today's behavior).
import { test, expect } from "bun:test";
import {
  ENTITLEMENT_MODES,
  resolveEntitlementMode,
  getEntitlementMode,
  VERDICT,
  REASON,
  makeLocalEntitlementProvider,
} from "./entitlement.mjs";

// --- tri-state ladder (mirrors deployment-mode.test.mjs) ---
test("default is off when nothing declared", () => {
  const r = resolveEntitlementMode({ env: {}, layer1ConfigPath: "/nope", layer2ConfigPath: "/nope" });
  expect(r).toMatchObject({ mode: "off", source: "default", inferred: true, recognized: true });
});

test("env CATALYST_ENTITLEMENT wins the ladder", () => {
  expect(
    resolveEntitlementMode({
      env: { CATALYST_ENTITLEMENT: "shadow" },
      layer1ConfigPath: "/nope",
      layer2ConfigPath: "/nope",
    }).mode
  ).toBe("shadow");
});

test("a typo degrades to off, recognized:false (safe direction)", () => {
  const r = resolveEntitlementMode({
    env: { CATALYST_ENTITLEMENT: "enfroce" },
    layer1ConfigPath: "/nope",
    layer2ConfigPath: "/nope",
  });
  expect(r).toMatchObject({ mode: "off", recognized: false });
});

test("ENTITLEMENT_MODES is the frozen closed enum", () => {
  expect(ENTITLEMENT_MODES).toEqual(["off", "shadow", "enforce"]);
  expect(Object.isFrozen(ENTITLEMENT_MODES)).toBe(true);
});

test("getEntitlementMode returns just the mode string and never throws", () => {
  expect(() =>
    getEntitlementMode({ env: {}, layer1ConfigPath: "/nope", layer2ConfigPath: "/nope" })
  ).not.toThrow();
  expect(getEntitlementMode({ env: { CATALYST_ENTITLEMENT: "enforce" }, layer1ConfigPath: "/nope", layer2ConfigPath: "/nope" })).toBe(
    "enforce"
  );
});

// --- local provider reproduces today: entitled iff self ∈ roster ---
test("local provider ENTITLED for self in roster", () => {
  const p = makeLocalEntitlementProvider();
  const v = p.check({ host: "mini", roster: ["mini", "mini-2"] });
  expect(v).toMatchObject({ verdict: VERDICT.ENTITLED, reason: REASON.PRESENT_IN_LOCAL_ROSTER });
});

test("local provider UNENTITLED for host not in roster", () => {
  const p = makeLocalEntitlementProvider();
  expect(p.check({ host: "ghost", roster: ["mini"] }).verdict).toBe(VERDICT.UNENTITLED);
  expect(p.check({ host: "ghost", roster: ["mini"] }).reason).toBe(REASON.ABSENT_FROM_LOCAL_ROSTER);
});

test("fail direction is ENTITLED: malformed input never refuses", () => {
  const p = makeLocalEntitlementProvider();
  expect(p.check({ host: "", roster: null }).verdict).toBe(VERDICT.ENTITLED); // INCONCLUSIVE→ENTITLED
  expect(p.check({ host: "", roster: null }).reason).toBe(REASON.BAD_INPUT);
});

test("provider exposes a TTL and never throws", () => {
  const p = makeLocalEntitlementProvider();
  expect(typeof p.ttlMs).toBe("number");
  expect(p.ttlMs).toBeGreaterThan(0);
  expect(() => p.check(undefined)).not.toThrow();
  expect(p.check(undefined).verdict).toBe(VERDICT.ENTITLED); // undefined arg → fail-open
});

test("provider TTL is overridable", () => {
  const p = makeLocalEntitlementProvider({ ttlMs: 42 });
  expect(p.ttlMs).toBe(42);
});

test("VERDICT and REASON are frozen enums", () => {
  expect(Object.isFrozen(VERDICT)).toBe(true);
  expect(Object.isFrozen(REASON)).toBe(true);
  expect(VERDICT.ENTITLED).toBe("entitled");
  expect(VERDICT.UNENTITLED).toBe("unentitled");
  expect(VERDICT.INCONCLUSIVE).toBe("inconclusive");
});
