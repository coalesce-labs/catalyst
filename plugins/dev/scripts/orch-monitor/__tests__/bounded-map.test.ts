import { describe, it, expect } from "bun:test";
import { BoundedMap } from "../lib/bounded-map.mjs";

describe("BoundedMap", () => {
  it("evicts the oldest-inserted key when set beyond cap", () => {
    const m = new BoundedMap({ cap: 3 });
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4); // pushes over cap → evict "a"
    expect(m.size).toBe(3);
    expect(m.has("a")).toBe(false);
    expect(m.get("d")).toBe(4);
    expect([...m.keys()]).toEqual(["b", "c", "d"]);
  });

  it("re-setting an existing key moves it to MRU (skipped on next evict)", () => {
    const m = new BoundedMap({ cap: 3 });
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("a", 10); // touch "a" → now MRU; "b" is oldest
    m.set("d", 4); // evict oldest = "b"
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(10);
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
  });

  it("get past ttlMs returns undefined and removes the entry (lazy expiry)", () => {
    let t = 1000;
    const m = new BoundedMap({ cap: 10, defaultTtlMs: 500, now: () => t });
    m.set("a", 1);
    t = 1400; // within TTL
    expect(m.get("a")).toBe(1);
    t = 1600; // past TTL (1000 + 500 = 1500)
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(0); // lazily removed
  });

  it("get within ttlMs returns the value", () => {
    let t = 0;
    const m = new BoundedMap({ cap: 10, defaultTtlMs: 1000, now: () => t });
    m.set("a", "hello");
    t = 999;
    expect(m.get("a")).toBe("hello");
  });

  it("sweepExpired drops expired entries, returns the count, keeps fresh ones", () => {
    let t = 0;
    const m = new BoundedMap({ cap: 100, defaultTtlMs: 1000, now: () => t });
    m.set("old1", 1);
    m.set("old2", 2);
    t = 600;
    m.set("fresh", 3); // expires at 1600
    t = 1200; // old1/old2 expired (>=1000), fresh not yet
    const removed = m.sweepExpired();
    expect(removed).toBe(2);
    expect(m.has("old1")).toBe(false);
    expect(m.has("old2")).toBe(false);
    expect(m.get("fresh")).toBe(3);
    expect(m.size).toBe(1);
  });

  it("per-entry ttlMs override outlives the default TTL", () => {
    let t = 0;
    const m = new BoundedMap({ cap: 100, defaultTtlMs: 1000, now: () => t });
    m.set("short", 1); // default TTL → expires 1000
    m.set("long", 2, 10_000); // override → expires 10000
    t = 1500;
    expect(m.get("short")).toBeUndefined();
    expect(m.get("long")).toBe(2);
    t = 9000;
    expect(m.get("long")).toBe(2);
    t = 11_000;
    expect(m.get("long")).toBeUndefined();
  });

  it("delete and clear behave like a Map", () => {
    const m = new BoundedMap({ cap: 10 });
    m.set("a", 1);
    m.set("b", 2);
    expect(m.delete("a")).toBe(true);
    expect(m.delete("a")).toBe(false);
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
  });

  it("has() does not consider TTL (lazy expiry only on get)", () => {
    let t = 0;
    const m = new BoundedMap({ cap: 10, defaultTtlMs: 100, now: () => t });
    m.set("a", 1);
    t = 500; // past TTL
    expect(m.has("a")).toBe(true); // has() ignores TTL
    expect(m.get("a")).toBeUndefined(); // get() honors it + removes
    expect(m.has("a")).toBe(false);
  });

  it("uses injected now for all time logic (no real clock)", () => {
    let t = 0;
    const m = new BoundedMap({ cap: 10, defaultTtlMs: 50, now: () => t });
    m.set("a", 1);
    // Real time has not advanced; only the injected clock matters.
    t = 49;
    expect(m.get("a")).toBe(1);
    t = 50;
    expect(m.get("a")).toBeUndefined();
  });
});
