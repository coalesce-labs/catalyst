// linear-breaker.test.mjs — Linear rate-limit circuit breaker (CTL-679).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-breaker.test.mjs
import { describe, test, expect } from "bun:test";
import { createLinearBreaker, withBreaker, isRateLimitError } from "./linear-breaker.mjs";

const silentLogger = { warn() {}, info() {}, error() {} };
const RATE_LIMIT_STDERR = "Rate limit exceeded. Only 2500 requests are allowed per 1 hour";

describe("isRateLimitError", () => {
  test("matches the linearis 429 stderr (case-insensitive)", () => {
    expect(isRateLimitError(RATE_LIMIT_STDERR)).toBe(true);
    expect(isRateLimitError("RATE LIMIT EXCEEDED")).toBe(true);
  });
  test("does not match unrelated errors or empty input", () => {
    expect(isRateLimitError("label not found")).toBe(false);
    expect(isRateLimitError("")).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("createLinearBreaker", () => {
  test("starts closed", () => {
    const b = createLinearBreaker({ logger: silentLogger });
    expect(b.isOpen(0)).toBe(false);
  });

  test("a 429 opens the breaker for the base cooldown", () => {
    const b = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    b.recordRateLimited(0);
    expect(b.isOpen(0)).toBe(true);
    expect(b.isOpen(999)).toBe(true);
    // boundary: cooldown elapsed → closed again
    expect(b.isOpen(1000)).toBe(false);
  });

  test("consecutive 429s back off exponentially, capped at maxCooldownMs", () => {
    const b = createLinearBreaker({
      logger: silentLogger,
      baseCooldownMs: 1000,
      maxCooldownMs: 5000,
    });
    b.recordRateLimited(0); // 1000
    expect(b.state().openUntil).toBe(1000);
    b.recordRateLimited(1000); // base*2^1 = 2000
    expect(b.state().openUntil).toBe(3000);
    b.recordRateLimited(3000); // base*2^2 = 4000
    expect(b.state().openUntil).toBe(7000);
    b.recordRateLimited(7000); // base*2^3 = 8000 → capped to 5000
    expect(b.state().openUntil).toBe(12000);
  });

  test("honors a larger Retry-After hint over the computed backoff", () => {
    const b = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    b.recordRateLimited(0, { retryAfterMs: 9000 });
    expect(b.state().openUntil).toBe(9000);
  });

  test("a success closes the breaker and resets the backoff exponent", () => {
    const b = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    b.recordRateLimited(0);
    b.recordRateLimited(1000); // exponent now 2 → would be 2000
    b.recordSuccess();
    expect(b.isOpen(2000)).toBe(false);
    expect(b.state().consecutive).toBe(0);
    // next 429 starts from base again, not the prior exponent
    b.recordRateLimited(10000);
    expect(b.state().openUntil).toBe(11000);
  });

  test("logs exactly one OPEN line per 429 and one CLOSE line on recovery", () => {
    const lines = [];
    const logger = {
      warn: (_o, m) => lines.push(["warn", m]),
      info: (_o, m) => lines.push(["info", m]),
    };
    const b = createLinearBreaker({ logger, baseCooldownMs: 1000 });
    b.recordRateLimited(0);
    b.recordSuccess();
    expect(lines.filter(([lvl]) => lvl === "warn")).toHaveLength(1);
    expect(lines.filter(([lvl]) => lvl === "info")).toHaveLength(1);
  });

  test("a success while already closed logs nothing", () => {
    const lines = [];
    const logger = { warn: () => lines.push("warn"), info: () => lines.push("info") };
    const b = createLinearBreaker({ logger });
    b.recordSuccess();
    expect(lines).toHaveLength(0);
  });
});

describe("withBreaker", () => {
  test("short-circuits without spawning while open", () => {
    const breaker = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    const calls = [];
    const raw = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 1, stdout: "", stderr: RATE_LIMIT_STDERR };
    };
    let clock = 0;
    const exec = withBreaker(raw, { breaker, now: () => clock });

    // first call spawns, hits 429, opens the breaker
    const first = exec("linearis", ["issues", "list"]);
    expect(first.code).not.toBe(0);
    expect(calls).toHaveLength(1);

    // subsequent calls within the cooldown DO NOT spawn — synthetic circuit-open
    clock = 500;
    const second = exec("linearis", ["issues", "list"]);
    expect(calls).toHaveLength(1); // raw exec NOT called again
    expect(second.stderr).toBe("circuit-open");
    expect(second.code).not.toBe(0);
  });

  test("resumes spawning after the cooldown elapses", () => {
    const breaker = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    const calls = [];
    let stderr = RATE_LIMIT_STDERR;
    let code = 1;
    const raw = () => {
      calls.push(1);
      return { code, stdout: "", stderr };
    };
    let clock = 0;
    const exec = withBreaker(raw, { breaker, now: () => clock });

    exec("linearis", ["x"]); // opens breaker, calls=1
    clock = 1000; // cooldown elapsed
    code = 0;
    stderr = "";
    const r = exec("linearis", ["x"]); // spawns again, succeeds
    expect(calls).toHaveLength(2);
    expect(r.code).toBe(0);
    expect(breaker.isOpen(1000)).toBe(false); // success closed it
  });

  test("a non-429 failure does not open the breaker", () => {
    const breaker = createLinearBreaker({ logger: silentLogger });
    const raw = () => ({ code: 1, stdout: "", stderr: "label not found" });
    const exec = withBreaker(raw, { breaker });
    exec("linearis", ["x"]);
    expect(breaker.isOpen()).toBe(false);
  });
});
