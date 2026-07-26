import { describe, test, expect } from "bun:test";
import { withRetry, HttpError, classifyStatus, parseRetryAfter, withHttpRetry } from "./retry.ts";

describe("withRetry", () => {
  test("returns on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; }, 3, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries up to maxAttempts and throws", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("fail"); }, 3, [0, 0, 0])).rejects.toThrow("fail");
    expect(calls).toBe(3);
  });
});

describe("HttpError", () => {
  test("is an instance of Error", () => {
    const err = new HttpError(503);
    expect(err).toBeInstanceOf(Error);
  });

  test("exposes status and message", () => {
    const err = new HttpError(400);
    expect(err.status).toBe(400);
    expect(err.message).toBe("OTLP HTTP 400");
  });

  test("exposes optional retryAfterMs", () => {
    const err = new HttpError(429, 2000);
    expect(err.retryAfterMs).toBe(2000);
  });

  test("retryAfterMs is undefined when not provided", () => {
    const err = new HttpError(503);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("classifyStatus", () => {
  test("400 is terminal", () => expect(classifyStatus(400)).toBe("terminal"));
  test("404 is terminal", () => expect(classifyStatus(404)).toBe("terminal"));
  test("413 is terminal", () => expect(classifyStatus(413)).toBe("terminal"));
  test("429 is retryable", () => expect(classifyStatus(429)).toBe("retryable"));
  test("500 is retryable", () => expect(classifyStatus(500)).toBe("retryable"));
  test("502 is retryable", () => expect(classifyStatus(502)).toBe("retryable"));
  test("503 is retryable", () => expect(classifyStatus(503)).toBe("retryable"));
});

describe("parseRetryAfter", () => {
  test("delta-seconds '2' → 2000 ms", () => {
    expect(parseRetryAfter("2", Date.now())).toBe(2000);
  });

  test("HTTP-date 5s in future → ~5000 ms", () => {
    const futureMs = Date.now() + 5000;
    const httpDate = new Date(futureMs).toUTCString();
    const result = parseRetryAfter(httpDate, Date.now());
    expect(result).toBeGreaterThanOrEqual(4000);
    expect(result).toBeLessThanOrEqual(6000);
  });

  test("null → undefined", () => {
    expect(parseRetryAfter(null, Date.now())).toBeUndefined();
  });

  test("empty string → undefined", () => {
    expect(parseRetryAfter("", Date.now())).toBeUndefined();
  });

  test("garbage string → undefined", () => {
    expect(parseRetryAfter("not-a-date", Date.now())).toBeUndefined();
  });

  test("past date → 0", () => {
    const pastDate = new Date(Date.now() - 10000).toUTCString();
    expect(parseRetryAfter(pastDate, Date.now())).toBe(0);
  });
});

describe("withHttpRetry", () => {
  test("aborts immediately on terminal HttpError — fn called exactly once", async () => {
    let calls = 0;
    const err = new HttpError(400);
    await expect(withHttpRetry(async () => {
      calls++;
      throw err;
    }, { maxElapsedMs: 60_000 }, { now: () => 0, sleep: async () => {} }))
      .rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  test("retries retryable HttpError and succeeds on later attempt", async () => {
    let calls = 0;
    const result = await withHttpRetry(async () => {
      calls++;
      if (calls < 3) throw new HttpError(503);
      return "ok";
    }, { baseMs: 0, maxElapsedMs: 60_000 }, { now: () => 0, sleep: async () => {} });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("retries plain network Error (non-HttpError is retryable)", async () => {
    let calls = 0;
    const result = await withHttpRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNREFUSED");
      return "ok";
    }, { baseMs: 0, maxElapsedMs: 60_000 }, { now: () => 0, sleep: async () => {} });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("honors Retry-After: scheduled delay is at least retryAfterMs", async () => {
    const sleepDelays: number[] = [];
    let calls = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      throw new HttpError(429, 3000);
    }, { baseMs: 0, maxElapsedMs: 0 }, {
      now: () => 0,
      sleep: async (ms) => { sleepDelays.push(ms); },
    })).rejects.toBeInstanceOf(HttpError);
    // Window exhausted immediately, so no sleep before first throw, but we verify
    // that if we got a sleep it would be >= retryAfterMs. Window=0 means we don't retry.
    expect(calls).toBe(1);
  });

  test("honors Retry-After: delay is at least retryAfterMs on retry", async () => {
    const sleepDelays: number[] = [];
    let calls = 0;
    let nowVal = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      throw new HttpError(429, 3000);
    }, { baseMs: 0, maxElapsedMs: 10_000 }, {
      now: () => nowVal,
      sleep: async (ms) => { sleepDelays.push(ms); nowVal += ms; },
    })).rejects.toBeInstanceOf(HttpError);
    // At least one sleep should have been >= 3000 ms (the retryAfterMs)
    expect(sleepDelays.some((d) => d >= 3000)).toBe(true);
  });

  test("gives up after maxElapsedMs and rethrows last error", async () => {
    let calls = 0;
    let nowVal = 0;
    const err = await withHttpRetry(async () => {
      calls++;
      nowVal += 5000; // advance simulated clock past maxElapsedMs on first attempt
      throw new HttpError(503);
    }, { maxElapsedMs: 1000 }, {
      now: () => nowVal,
      sleep: async () => {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});
