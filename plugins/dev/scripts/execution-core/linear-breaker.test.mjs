// linear-breaker.test.mjs — Linear rate-limit circuit breaker (CTL-679).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-breaker.test.mjs
import { describe, test, expect } from "bun:test";
import { createLinearBreaker, withBreaker, isRateLimitError, deriveCaller } from "./linear-breaker.mjs";

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

  // CTL-1341: a wall-clock TIMEOUT (the CTL-1339 cap fired) is a degraded-API
  // signal — it must trip the breaker so the next read in a multi-read pass
  // short-circuits instead of paying the full cap again (bounds the per-PASS
  // aggregate to ~1 cap, not N×cap).
  test("a timed-out read (timedOut:true) opens the breaker", () => {
    const breaker = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    const raw = () => ({ code: 127, stdout: "", stderr: "spawnSync linearis ETIMEDOUT", timedOut: true });
    const exec = withBreaker(raw, { breaker, now: () => 0 });
    exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(breaker.isOpen(0)).toBe(true);
  });

  test("after a timeout opens the breaker, the next read short-circuits (per-pass bound)", () => {
    const breaker = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    const calls = [];
    const raw = (...all) => {
      calls.push(all);
      return { code: 127, stdout: "", stderr: "spawnSync linearis ETIMEDOUT", timedOut: true };
    };
    let clock = 0;
    const exec = withBreaker(raw, { breaker, now: () => clock });
    // first per-signal read times out → opens the breaker (one real spawn)
    const first = exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(first.code).toBe(127);
    expect(calls).toHaveLength(1);
    // the SAME pass's next per-signal read short-circuits — NO second 8s stall
    clock = 10;
    const second = exec("linearis", ["issues", "read", "CTL-2"], { timeoutMs: 8000 });
    expect(calls).toHaveLength(1); // raw NOT spawned again
    expect(second.stderr).toBe("circuit-open");
  });

  test("a non-timeout spawn error (ENOENT, timedOut:false) does NOT open the breaker", () => {
    const breaker = createLinearBreaker({ logger: silentLogger });
    const raw = () => ({ code: 127, stdout: "", stderr: "spawnSync linearis ENOENT", timedOut: false });
    const exec = withBreaker(raw, { breaker });
    exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(breaker.isOpen()).toBe(false);
  });

  // CTL-1339: the opt-in per-call wall-clock cap rides a 3rd `opts` arg that the
  // wrapper must forward to the inner rawExec untouched.
  test("forwards a 3rd opts arg (e.g. { timeoutMs }) to the inner rawExec", () => {
    const breaker = createLinearBreaker({ logger: silentLogger });
    const calls = [];
    const raw = (...all) => {
      calls.push(all);
      return { code: 0, stdout: "", stderr: "" };
    };
    const exec = withBreaker(raw, { breaker });
    exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 }]);
  });

  test("omitting the opts arg forwards undefined (uncapped, as before)", () => {
    const breaker = createLinearBreaker({ logger: silentLogger });
    const calls = [];
    const raw = (...all) => {
      calls.push(all);
      return { code: 0, stdout: "", stderr: "" };
    };
    const exec = withBreaker(raw, { breaker });
    exec("linearis", ["issues", "list"]);
    expect(calls[0][2]).toBeUndefined();
  });
});

describe("deriveCaller (CTL-1430)", () => {
  test("tags a linearis subcommand from the argv (basename + first two non-flag args)", () => {
    expect(deriveCaller("linearis", ["issues", "list"])).toBe("linearis:issues-list");
    expect(deriveCaller("/usr/local/bin/linearis", ["issues", "read", "CTL-1"])).toBe("linearis:issues-read");
  });
  test("skips leading flags when picking the subcommand tag", () => {
    expect(deriveCaller("linearis", ["--json", "issues", "list"])).toBe("linearis:issues-list");
  });
  test("falls back to the bare basename when there are no positional args", () => {
    expect(deriveCaller("linear-transition.sh", [])).toBe("linear-transition.sh");
    expect(deriveCaller("/opt/bin/linear-transition.sh", ["--flag-only"])).toBe("linear-transition.sh");
  });
  test("never throws on missing/oddly-typed argv", () => {
    expect(deriveCaller(undefined, undefined)).toBe("unknown");
    expect(deriveCaller("linearis", null)).toBe("linearis");
  });
});

describe("CTL-1430: breaker reason/caller + durable event", () => {
  test("recordRateLimited puts reason+caller on the OPEN log line", () => {
    const warned = [];
    const logger = { warn: (o, _m) => warned.push(o), info() {} };
    const b = createLinearBreaker({ logger, baseCooldownMs: 1000 });
    b.recordRateLimited(0, { reason: "timeout", caller: "linearis:issues-read" });
    expect(warned).toHaveLength(1);
    expect(warned[0].reason).toBe("timeout");
    expect(warned[0].caller).toBe("linearis:issues-read");
  });

  test("recordRateLimited emits one durable OPEN event with reason/caller/cooldown/consecutive", () => {
    const events = [];
    const b = createLinearBreaker({
      logger: silentLogger,
      baseCooldownMs: 1000,
      emitEvent: (e) => events.push(e),
    });
    b.recordRateLimited(0, { reason: "429", caller: "cluster-heartbeat-publisher" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "open",
      reason: "429",
      caller: "cluster-heartbeat-publisher",
      cooldownMs: 1000,
      consecutive: 1,
    });
  });

  test("recordSuccess emits one durable CLOSED event carrying recoveredAfter", () => {
    const events = [];
    const b = createLinearBreaker({
      logger: silentLogger,
      baseCooldownMs: 1000,
      emitEvent: (e) => events.push(e),
    });
    b.recordRateLimited(0, { reason: "429", caller: "x" });
    b.recordRateLimited(1000, { reason: "429", caller: "x" }); // consecutive → 2
    b.recordSuccess();
    const closed = events.filter((e) => e.state === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].recoveredAfter).toBe(2);
  });

  test("a steady-state success (never degraded) emits NO event", () => {
    const events = [];
    const b = createLinearBreaker({ logger: silentLogger, emitEvent: (e) => events.push(e) });
    b.recordSuccess();
    expect(events).toHaveLength(0);
  });

  test("the factory default emitEvent is a no-op (hermetic — never touches the real log)", () => {
    const b = createLinearBreaker({ logger: silentLogger });
    expect(() => b.recordRateLimited(0, { reason: "429", caller: "x" })).not.toThrow();
  });

  test("withBreaker tags a 429 with reason='429' + the argv-derived caller", () => {
    const events = [];
    const breaker = createLinearBreaker({ logger: silentLogger, emitEvent: (e) => events.push(e) });
    const raw = () => ({ code: 1, stdout: "", stderr: RATE_LIMIT_STDERR });
    const exec = withBreaker(raw, { breaker, now: () => 0 });
    exec("linearis", ["issues", "list"]);
    expect(events[0]).toMatchObject({ state: "open", reason: "429", caller: "linearis:issues-list" });
  });

  test("withBreaker tags a timed-out read with reason='timeout'", () => {
    const events = [];
    const breaker = createLinearBreaker({ logger: silentLogger, emitEvent: (e) => events.push(e) });
    const raw = () => ({ code: 1, timedOut: true, stdout: "", stderr: "" });
    const exec = withBreaker(raw, { breaker, now: () => 0 });
    exec("linearis", ["issues", "read", "CTL-9"]);
    expect(events[0]).toMatchObject({ state: "open", reason: "timeout", caller: "linearis:issues-read" });
  });

  test("an explicit opts.caller overrides the argv-derived tag", () => {
    const events = [];
    const breaker = createLinearBreaker({ logger: silentLogger, emitEvent: (e) => events.push(e) });
    const raw = () => ({ code: 1, stdout: "", stderr: RATE_LIMIT_STDERR });
    const exec = withBreaker(raw, { breaker, now: () => 0 });
    exec("linearis", ["issues", "list"], { caller: "open-pr-gate" });
    expect(events[0].caller).toBe("open-pr-gate");
  });
});
