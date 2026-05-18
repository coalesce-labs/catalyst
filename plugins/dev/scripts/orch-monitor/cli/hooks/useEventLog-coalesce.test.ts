// useEventLog-coalesce.test.ts — mirrors the microtask coalescer added in
// useEventLog.ts. The hook itself can't be invoked in bun:test (it pulls in
// filesystem I/O and React state), so we mirror the *coalescing contract*
// here. Drift between this mirror and the source is caught when either
// changes.

import { describe, test, expect } from "bun:test";
import { createCoalescer } from "./useEventLog.ts";

describe("createCoalescer (CTL-473 Fix 4)", () => {
  test("N enqueues in the same task produce one flush call with all items", async () => {
    const seen: number[][] = [];
    const coalescer = createCoalescer<number>((batch) => seen.push(batch));
    for (let i = 0; i < 50; i++) coalescer.enqueue(i);
    await Promise.resolve(); // drain microtasks
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("single enqueue produces one flush call with one item", async () => {
    const seen: number[][] = [];
    const coalescer = createCoalescer<number>((batch) => seen.push(batch));
    coalescer.enqueue(42);
    await Promise.resolve();
    expect(seen).toEqual([[42]]);
  });

  test("two separate task ticks produce two flush calls", async () => {
    const seen: number[][] = [];
    const coalescer = createCoalescer<number>((batch) => seen.push(batch));
    coalescer.enqueue(1);
    coalescer.enqueue(2);
    await Promise.resolve();
    coalescer.enqueue(3);
    coalescer.enqueue(4);
    await Promise.resolve();
    expect(seen).toEqual([[1, 2], [3, 4]]);
  });

  test("no enqueues = no flush", async () => {
    const seen: number[][] = [];
    createCoalescer<number>((batch) => seen.push(batch));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  test("flush is empty-array safe (no spurious empty batches)", async () => {
    const seen: number[][] = [];
    const c = createCoalescer<number>((batch) => seen.push(batch));
    c.enqueue(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.length).toBe(1);
  });
});
