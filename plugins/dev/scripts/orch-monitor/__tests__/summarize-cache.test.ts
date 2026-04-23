import { describe, it, expect } from "bun:test";
import { createCache } from "../lib/summarize/cache";

describe("createCache", () => {
  it("returns null for unknown key", () => {
    const cache = createCache<string>(60_000);
    expect(cache.get("missing")).toBeNull();
  });

  it("returns value after set", () => {
    const cache = createCache<string>(60_000);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  it("expires entries after ttl", () => {
    let now = 0;
    const clock = () => now;
    const cache = createCache<string>(1000, clock);
    cache.set("k", "v");
    now = 999;
    expect(cache.get("k")).toBe("v");
    now = 1001;
    expect(cache.get("k")).toBeNull();
  });

  it("keeps different keys independent", () => {
    const cache = createCache<number>(60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("overwrites an existing key", () => {
    let now = 0;
    const clock = () => now;
    const cache = createCache<string>(1000, clock);
    cache.set("k", "v1");
    now = 500;
    cache.set("k", "v2");
    now = 1200;
    expect(cache.get("k")).toBe("v2");
  });
});
