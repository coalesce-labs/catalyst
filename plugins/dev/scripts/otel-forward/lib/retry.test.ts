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

  // CTL-1506 (Codex P2): the loop must recheck the deadline BEFORE starting another
  // attempt. The old code capped the delay to the remaining window and always retried
  // once more — burning an extra request timeout past maxElapsedMs and, for a long
  // Retry-After, sending before the server asked.
  test("stops instead of firing a doomed extra attempt when Retry-After exceeds the window (CTL-1506)", async () => {
    const sleepDelays: number[] = [];
    let calls = 0;
    let nowVal = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      throw new HttpError(429, 5000); // server asks for 5s; window is only 3s
    }, { baseMs: 0, maxElapsedMs: 3000 }, {
      now: () => nowVal,
      sleep: async (ms) => { sleepDelays.push(ms); nowVal += ms; },
    })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);         // no doomed second attempt
    expect(sleepDelays).toEqual([]); // and no early sleep-then-send before the requested time
  });

  test("never sleeps-then-sends once the backoff would cross maxElapsedMs (CTL-1506)", async () => {
    const sleepDelays: number[] = [];
    let calls = 0;
    let nowVal = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      throw new HttpError(503);
    }, { baseMs: 1000, factor: 2, maxElapsedMs: 3500 }, {
      now: () => nowVal,
      sleep: async (ms) => { sleepDelays.push(ms); nowVal += ms; },
    })).rejects.toBeInstanceOf(HttpError);
    // 0+1000<3500 → sleep 1000; 1000+2000<3500 → sleep 2000; 3000+4000>=3500 → stop.
    // Every scheduled sleep stayed inside the window — no capped-then-doomed final attempt.
    expect(sleepDelays).toEqual([1000, 2000]);
    expect(calls).toBe(3);
  });

  test("rechecks the ACTUAL deadline after sleeping — no attempt once a sleep overruns (CTL-1506)", async () => {
    let calls = 0;
    let nowVal = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      throw new HttpError(503);
    }, { baseMs: 100, maxElapsedMs: 250 }, {
      now: () => nowVal,
      sleep: async (ms) => { nowVal += ms * 10; }, // a suspended host: sleep overruns 10x
    })).rejects.toBeInstanceOf(HttpError);
    // Projected 0+100<250 → sleep, but the sleep lands at now=1000 ≥ 250, so the post-sleep
    // recheck stops instead of firing another request past the window.
    expect(calls).toBe(1);
  });

  test("aborts the retry loop when the signal fires (CTL-1506)", async () => {
    const ac = new AbortController();
    let calls = 0;
    await expect(withHttpRetry(async () => {
      calls++;
      ac.abort(); // e.g. daemon SIGTERM during a retry
      throw new HttpError(503);
    }, { baseMs: 0, maxElapsedMs: 60_000 }, {
      now: () => 0, sleep: async () => {}, signal: ac.signal,
    })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1); // stopped after the first failure — no retry, caller DLQs
  });
});
