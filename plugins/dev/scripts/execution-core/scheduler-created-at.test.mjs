import { describe, test, expect } from "bun:test";
import { resolveWaitingCreatedAt } from "./scheduler.mjs";

describe("resolveWaitingCreatedAt (CAT-36)", () => {
  test("prefers persisted createdAt without writing", () => {
    let writes = 0;
    expect(resolveWaitingCreatedAt("/tmp/x", "CAT-1", {
      persisted: "2026-01-01T00:00:00Z",
      rel: { createdAt: "2026-02-01T00:00:00Z" },
      write: () => writes++,
    })).toBe("2026-01-01T00:00:00Z");
    expect(writes).toBe(0);
  });
  test("falls back to batch relation and backfills", () => {
    const calls = [];
    expect(resolveWaitingCreatedAt("/tmp/x", "CAT-2", {
      rel: { createdAt: "2026-02-01T00:00:00Z" }, priority: 1,
      write: (...args) => calls.push(args),
    })).toBe("2026-02-01T00:00:00Z");
    expect(calls).toHaveLength(1);
  });
  test("falls back to eligible projection", () => {
    const eligibleById = new Map([["CAT-3", { createdAt: "2026-03-01T00:00:00Z" }]]);
    expect(resolveWaitingCreatedAt("/tmp/x", "CAT-3", { eligibleById, write: () => {} }))
      .toBe("2026-03-01T00:00:00Z");
  });
  test("returns null when every source is absent", () => {
    expect(resolveWaitingCreatedAt("/tmp/x", "CAT-4", {})).toBeNull();
  });
  test("swallows a backfill failure", () => {
    expect(resolveWaitingCreatedAt("/tmp/x", "CAT-5", {
      rel: { createdAt: "2026-05-01T00:00:00Z" },
      write: () => { throw new Error("EIO"); },
    })).toBe("2026-05-01T00:00:00Z");
  });
});
