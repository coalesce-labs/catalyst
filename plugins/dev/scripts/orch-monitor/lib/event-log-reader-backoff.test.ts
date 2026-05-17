// event-log-reader-backoff.test.ts — mirrors the idle-tick backoff schedule
// added to tailEventLog (lib/event-log-reader.ts). Pure-function mirror so
// bun:test can run it without driving the async loop. Drift between this
// schedule and the source is caught when either changes.

import { describe, test, expect } from "bun:test";
import { nextPollMs } from "./event-log-reader.ts";

describe("nextPollMs (CTL-473 Fix 8)", () => {
  test("busy tick resets to base (200ms)", () => {
    expect(nextPollMs({ prevMs: 1600, sawNewBytes: true })).toBe(200);
    expect(nextPollMs({ prevMs: 800, sawNewBytes: true })).toBe(200);
    expect(nextPollMs({ prevMs: 200, sawNewBytes: true })).toBe(200);
  });

  test("idle tick doubles up to the cap (1600ms)", () => {
    expect(nextPollMs({ prevMs: 200, sawNewBytes: false })).toBe(400);
    expect(nextPollMs({ prevMs: 400, sawNewBytes: false })).toBe(800);
    expect(nextPollMs({ prevMs: 800, sawNewBytes: false })).toBe(1600);
    expect(nextPollMs({ prevMs: 1600, sawNewBytes: false })).toBe(1600);
  });

  test("does not exceed the cap regardless of input", () => {
    expect(nextPollMs({ prevMs: 10_000, sawNewBytes: false })).toBe(1600);
  });

  test("never returns below the base (200ms)", () => {
    expect(nextPollMs({ prevMs: 50, sawNewBytes: true })).toBe(200);
    expect(nextPollMs({ prevMs: 50, sawNewBytes: false })).toBe(200);
  });

  test("honors a custom base when provided", () => {
    expect(nextPollMs({ prevMs: 500, sawNewBytes: true, baseMs: 500 })).toBe(500);
    expect(nextPollMs({ prevMs: 500, sawNewBytes: false, baseMs: 500 })).toBe(1000);
  });
});
