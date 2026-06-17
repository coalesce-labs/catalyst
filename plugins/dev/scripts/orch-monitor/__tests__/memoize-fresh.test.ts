// CTL-1257: memoize-fresh.mjs — the load-bearing counter proof. The whole point
// of the fix is that N getter calls within the TTL/until-invalidate window
// trigger exactly ONE underlying read (the every-3s collapse), not N. We inject
// a spy read fn + an injectable `now` (the bounded-map.test.ts pattern) and
// assert the read counter, not just the value.

import { describe, it, expect } from "bun:test";
import { createMemoizedRead } from "../lib/memoize-fresh.mjs";

describe("createMemoizedRead — single-slot TTL memo", () => {
  it("returns the cached value on the 2nd..Nth call within TTL (1 read, not N)", () => {
    let t = 1000;
    let reads = 0;
    const memo = createMemoizedRead<number>({
      read: () => {
        reads++;
        return 42;
      },
      ttlMs: 10_000,
      now: () => t,
    });

    // 5 gets, all within the TTL window → exactly ONE underlying read.
    for (let i = 0; i < 5; i++) {
      expect(memo.get()).toBe(42);
      t += 100; // 5 calls span 500ms ≪ 10s TTL
    }
    expect(reads).toBe(1);
  });

  it("re-reads once after now() advances past TTL (counter 1 → 2)", () => {
    let t = 0;
    let reads = 0;
    const memo = createMemoizedRead<string>({
      read: () => {
        reads++;
        return `read-${reads}`;
      },
      ttlMs: 1000,
      now: () => t,
    });

    expect(memo.get()).toBe("read-1");
    t = 999; // still within TTL
    expect(memo.get()).toBe("read-1");
    expect(reads).toBe(1);

    t = 1000; // TTL is exclusive (>= ttlMs is stale) → re-read
    expect(memo.get()).toBe("read-2");
    expect(reads).toBe(2);
  });

  it("invalidate() forces the next get() to re-read even within TTL (the onAppend path)", () => {
    let t = 5000;
    let reads = 0;
    const memo = createMemoizedRead<number>({
      read: () => ++reads,
      ttlMs: 60_000, // long TTL — only invalidate can force a re-read here
      now: () => t,
    });

    expect(memo.get()).toBe(1);
    expect(memo.get()).toBe(1); // cached
    expect(reads).toBe(1);

    memo.invalidate(); // simulate eventRing.onAppend firing on a new log line
    expect(memo.get()).toBe(2); // re-read despite being well within TTL
    expect(reads).toBe(2);
    expect(memo.get()).toBe(2); // cached again
    expect(reads).toBe(2);
  });

  it("re-reads when the key changes (path-keyed dedup, no cross-key skew)", () => {
    let reads = 0;
    const memo = createMemoizedRead<string>({
      read: (path: string) => {
        reads++;
        return `value-for-${path}`;
      },
      ttlMs: 60_000,
      key: (path: string) => path,
      now: () => 0,
    });

    expect(memo.get("/log-A")).toBe("value-for-/log-A");
    expect(memo.get("/log-A")).toBe("value-for-/log-A"); // cached
    expect(reads).toBe(1);

    expect(memo.get("/log-B")).toBe("value-for-/log-B"); // different key → re-read
    expect(reads).toBe(2);

    expect(memo.get("/log-A")).toBe("value-for-/log-A"); // single-slot → key changed → re-read
    expect(reads).toBe(3);
  });

  it("passes through call args to the read fn (heartbeat reader shape)", () => {
    let t = 0;
    const seen: Array<[unknown, unknown]> = [];
    const memo = createMemoizedRead<string>({
      read: (deps: { name: string }, opts: { logPath?: string }) => {
        seen.push([deps, opts]);
        return `${deps.name}:${opts.logPath ?? ""}`;
      },
      ttlMs: 10_000,
      key: (_deps: unknown, opts: { logPath?: string }) => opts?.logPath ?? "",
      now: () => t,
    });

    expect(memo.get({ name: "recovery" }, {})).toBe("recovery:");
    expect(memo.get({ name: "recovery" }, {})).toBe("recovery:"); // cached
    expect(seen).toHaveLength(1); // 2 calls, 1 read
  });

  it("rejects an invalid ttlMs", () => {
    expect(() => createMemoizedRead({ read: () => 1, ttlMs: -1 })).toThrow();
    expect(() => createMemoizedRead({ read: () => 1, ttlMs: NaN })).toThrow();
  });
});

// Models the server.ts heartbeat-reader wiring: a memo invalidated by a fake
// ring's onAppend. Proves append → 1 read, not poll → N reads, and that the
// memoized value is byte-identical to the un-memoized reader on the same input.
describe("createMemoizedRead — ring-invalidated heartbeat wrapper (server.ts model)", () => {
  // A minimal fake ring exposing only the onAppend hook the wiring uses.
  function fakeRing() {
    const listeners = new Set<() => void>();
    return {
      onAppend(fn: () => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      fireAppend() {
        for (const fn of listeners) fn();
      },
    };
  }

  it("5 polls → 1 read; fire onAppend → next poll re-reads (append→1, not poll→N)", () => {
    let t = 0;
    let reads = 0;
    const lastSeenFixture: Record<string, string> = {
      "host-A": "2026-06-17T12:00:00Z",
      "host-B": "2026-06-17T11:59:30Z",
    };
    const memo = createMemoizedRead<Record<string, string>>({
      read: () => {
        reads++;
        return { ...lastSeenFixture }; // mirror readClusterHeartbeats' map
      },
      ttlMs: 10_000,
      now: () => t,
    });
    const ring = fakeRing();
    ring.onAppend(() => memo.invalidate());

    // 5 board recomputes (3s apart is irrelevant — all < 10s of each other here)
    for (let i = 0; i < 5; i++) {
      expect(memo.get()).toEqual(lastSeenFixture);
      t += 100;
    }
    expect(reads).toBe(1); // poll → N would be 5; memo collapses to 1

    ring.fireAppend(); // a genuine new heartbeat line lands in the ring
    expect(memo.get()).toEqual(lastSeenFixture);
    expect(reads).toBe(2); // exactly one more read on the append, not on the polls
  });

  it("memoized value is byte-identical to the un-memoized reader on the same input", () => {
    const fixture = { "host-A": "2026-06-17T12:00:00Z" };
    const reader = () => ({ ...fixture });
    const memo = createMemoizedRead<Record<string, string>>({
      read: reader,
      ttlMs: 10_000,
      now: () => 0,
    });
    expect(memo.get()).toEqual(reader()); // parity with the direct call
  });
});
