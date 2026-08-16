// linear-write-echo.test.mjs — CTL-1891 increment 1 / CTL-1889.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write-echo.test.mjs

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ECHO_TTL_MS,
  createWriteEchoRing,
  echoKey,
  normalizeEchoValue,
} from "./linear-write-echo.mjs";

/** A controllable clock — a TTL test that sleeps is slow, and one that cannot advance
 *  time cannot test expiry at all. */
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

describe("⭐ the core claim: a host recognises its OWN write coming back", () => {
  test("a recorded write is an echo; an unrecorded one is not", () => {
    const r = createWriteEchoRing();
    r.record("CTL-1", "state", "Done");
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(true);
    expect(r.isEcho("CTL-2", "state", "Done")).toBe(false); // different ticket
    expect(r.isEcho("CTL-1", "state", "Todo")).toBe(false); // different value
    expect(r.isEcho("CTL-1", "labels", "Done")).toBe(false); // different field
  });

  test("⛔ ANOTHER host's identical change is NOT suppressed once ours is consumed", () => {
    // This is the whole point of CTL-1891 Option A: another agent's deliberate board
    // change must dispatch. Only OUR echo is swallowed, and only once.
    const r = createWriteEchoRing();
    r.record("CTL-1", "state", "Done");
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(true); // our echo
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(false); // ← someone else's, dispatches
  });

  test("a write we never made never suppresses anything", () => {
    const r = createWriteEchoRing();
    expect(r.isEcho("CTL-9", "state", "Todo")).toBe(false);
    expect(r.size()).toBe(0);
  });
});

describe("⛔ the entry is CONSUMED on a hit — a one-shot guard, not a repeating one", () => {
  test("a genuine later change to the same value still dispatches", () => {
    // If the record survived the echo, a human setting the same state an hour later
    // (within TTL) would be silently ignored. Silent suppression is the unrecoverable
    // failure; this is the guard against it.
    const c = clock();
    const r = createWriteEchoRing({ now: c.now });
    r.record("CTL-1", "state", "Done");
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(true);
    c.advance(1000);
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(false);
  });
});

describe("TTL expiry", () => {
  test("an entry past its TTL no longer suppresses", () => {
    const c = clock();
    const r = createWriteEchoRing({ ttlMs: 1000, now: c.now });
    r.record("CTL-1", "state", "Done");
    c.advance(1001);
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(false);
  });

  test("an entry just inside its TTL still suppresses", () => {
    const c = clock();
    const r = createWriteEchoRing({ ttlMs: 1000, now: c.now });
    r.record("CTL-1", "state", "Done");
    c.advance(999);
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(true);
  });

  test("re-recording refreshes the TTL", () => {
    const c = clock();
    const r = createWriteEchoRing({ ttlMs: 1000, now: c.now });
    r.record("CTL-1", "state", "Done");
    c.advance(900);
    r.record("CTL-1", "state", "Done"); // written again before expiry
    c.advance(900); // 1800 since first write, 900 since second
    expect(r.isEcho("CTL-1", "state", "Done")).toBe(true);
  });

  test("expired entries are swept, not merely ignored", () => {
    const c = clock();
    const r = createWriteEchoRing({ ttlMs: 1000, now: c.now });
    for (let i = 0; i < 5; i++) r.record(`CTL-${i}`, "state", "Done");
    expect(r.size()).toBe(5);
    c.advance(1001);
    expect(r.size()).toBe(0);
  });

  test("the default TTL is seconds-scale, not minutes — covering the round trip, not a session", () => {
    expect(DEFAULT_ECHO_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_ECHO_TTL_MS).toBeLessThanOrEqual(600_000);
  });
});

describe("bounded memory — eviction can only cost a dispatch, never cause a false suppression", () => {
  test("the ring never exceeds its cap", () => {
    const r = createWriteEchoRing({ maxEntries: 10 });
    for (let i = 0; i < 50; i++) r.record(`CTL-${i}`, "state", "Done");
    expect(r.size()).toBe(10);
  });

  test("⛔ eviction drops the OLDEST — so the newest (most likely to echo) survives", () => {
    const r = createWriteEchoRing({ maxEntries: 3 });
    for (const t of ["A", "B", "C", "D"]) r.record(t, "state", "Done");
    expect(r.isEcho("A", "state", "Done")).toBe(false); // evicted → dispatches (safe)
    expect(r.isEcho("D", "state", "Done")).toBe(true); // newest kept
  });

  test("re-recording moves an entry to the back of the eviction queue", () => {
    const r = createWriteEchoRing({ maxEntries: 3 });
    for (const t of ["A", "B", "C"]) r.record(t, "state", "Done");
    r.record("A", "state", "Done"); // refresh A — B is now oldest
    r.record("D", "state", "Done"); // evicts B
    expect(r.isEcho("A", "state", "Done")).toBe(true);
    expect(r.isEcho("B", "state", "Done")).toBe(false);
  });
});

describe("value normalisation", () => {
  test("⭐ label arrays compare order-independently", () => {
    // The write sends one order and the echo may return another; comparing raw would
    // miss the echo and dispatch on our own write.
    const r = createWriteEchoRing();
    r.record("CTL-1", "labels", ["b", "a", "c"]);
    expect(r.isEcho("CTL-1", "labels", ["a", "c", "b"])).toBe(true);
  });

  test("⛔ null, undefined and empty string are DISTINCT", () => {
    // "cleared the field" and "set it to empty" are different writes; collapsing them
    // would let one suppress the other.
    const keys = new Set([
      normalizeEchoValue(null),
      normalizeEchoValue(undefined),
      normalizeEchoValue(""),
    ]);
    expect(keys.size).toBe(3);
  });

  test("numbers and numeric strings collide deliberately (Linear ids are strings)", () => {
    expect(normalizeEchoValue(3)).toBe(normalizeEchoValue("3"));
  });

  test("the key includes all three dimensions", () => {
    expect(echoKey("T", "state", "Done")).not.toBe(echoKey("T", "labels", "Done"));
    expect(echoKey("T", "state", "Done")).not.toBe(echoKey("U", "state", "Done"));
  });
});

describe("⛔ unidentifiable writes are not remembered — costing a dispatch, not a suppression", () => {
  test("a missing ticket or field records nothing", () => {
    const r = createWriteEchoRing();
    for (const [t, f] of [["", "state"], ["CTL-1", ""], [null, "state"], ["CTL-1", null], [7, "state"]]) {
      expect(r.record(t, f, "Done")).toBeNull();
    }
    expect(r.size()).toBe(0);
  });

  test("a recorded write returns its key, so a caller can assert it landed", () => {
    const r = createWriteEchoRing();
    expect(r.record("CTL-1", "state", "Done")).toBe(echoKey("CTL-1", "state", "Done"));
  });
});
