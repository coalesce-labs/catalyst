import { describe, expect, test } from "bun:test";
import { createLinearBreaker, withBreaker } from "../linear-breaker.mjs";

describe("circuit-open retry window", () => {
  test("short circuit reports remaining time without changing the legacy fields", () => {
    let now = 1_000;
    const breaker = createLinearBreaker({ baseCooldownMs: 60_000, logger: { warn() {}, info() {} } });
    breaker.recordRateLimited(now);
    now += 7_000;
    const exec = withBreaker(() => { throw new Error("spawned"); }, { breaker, now: () => now });
    expect(exec("linearis", [])).toEqual({ code: 1, stdout: "", stderr: "circuit-open", retryAfterMs: 53_000 });
  });

  test("pass-through results are untouched", () => {
    const result = { code: 0, stdout: "ok", stderr: "" };
    const exec = withBreaker(() => result, { breaker: createLinearBreaker(), now: () => 1_000 });
    expect(exec("linearis", [])).toBe(result);
    expect(result).not.toHaveProperty("retryAfterMs");
  });
});
