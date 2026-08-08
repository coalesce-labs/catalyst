import { describe, test, expect, afterEach } from "bun:test";
import { getDispatchOutageFallback } from "../config.mjs";

const prior = process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK;
afterEach(() => {
  if (prior === undefined) delete process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK;
  else process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK = prior;
});

describe("getDispatchOutageFallback", () => {
  test("defaults to last-known-good", () => {
    delete process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK;
    expect(getDispatchOutageFallback()).toBe("last-known-good");
  });
  test("environment accepts the explicit full-roster opt-out", () => {
    process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK = "full-roster";
    expect(getDispatchOutageFallback()).toBe("full-roster");
  });
  test("unknown values degrade to last-known-good", () => {
    process.env.CATALYST_DISPATCH_OUTAGE_FALLBACK = "invalid";
    expect(getDispatchOutageFallback()).toBe("last-known-good");
  });
});
