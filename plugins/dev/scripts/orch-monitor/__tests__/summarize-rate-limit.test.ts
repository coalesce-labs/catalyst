import { describe, it, expect } from "bun:test";
import { createRateLimiter } from "../lib/summarize/rate-limit";

describe("createRateLimiter", () => {
  it("acquires a slot under the concurrency limit", () => {
    const now = 0;
    const limiter = createRateLimiter({
      maxConcurrent: 2,
      minIntervalMs: 0,
      clock: () => now,
    });
    expect(limiter.tryAcquire("anthropic")).toBe(true);
    expect(limiter.tryAcquire("anthropic")).toBe(true);
  });

  it("rejects when at concurrency limit", () => {
    const now = 0;
    const limiter = createRateLimiter({
      maxConcurrent: 1,
      minIntervalMs: 0,
      clock: () => now,
    });
    expect(limiter.tryAcquire("anthropic")).toBe(true);
    expect(limiter.tryAcquire("anthropic")).toBe(false);
  });

  it("releases the slot on release", () => {
    const now = 0;
    const limiter = createRateLimiter({
      maxConcurrent: 1,
      minIntervalMs: 0,
      clock: () => now,
    });
    expect(limiter.tryAcquire("anthropic")).toBe(true);
    limiter.release("anthropic");
    expect(limiter.tryAcquire("anthropic")).toBe(true);
  });

  it("enforces min interval between acquisitions", () => {
    let now = 0;
    const limiter = createRateLimiter({
      maxConcurrent: 10,
      minIntervalMs: 500,
      clock: () => now,
    });
    expect(limiter.tryAcquire("openai")).toBe(true);
    limiter.release("openai");
    now = 100;
    expect(limiter.tryAcquire("openai")).toBe(false);
    now = 600;
    expect(limiter.tryAcquire("openai")).toBe(true);
  });

  it("tracks providers independently", () => {
    const now = 0;
    const limiter = createRateLimiter({
      maxConcurrent: 1,
      minIntervalMs: 0,
      clock: () => now,
    });
    expect(limiter.tryAcquire("anthropic")).toBe(true);
    expect(limiter.tryAcquire("openai")).toBe(true);
    expect(limiter.tryAcquire("anthropic")).toBe(false);
  });
});
