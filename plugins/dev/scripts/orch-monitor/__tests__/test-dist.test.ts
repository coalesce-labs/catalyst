import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { ensureTestDist } from "./helpers/test-dist";

const BUILD_TIMEOUT = 60_000;

describe("test-dist helper", () => {
  it("builds a dist containing index.html and hashed /assets bundles", () => {
    const dist = ensureTestDist();
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    const assets = readdirSync(join(dist, "assets"));
    expect(assets.some((f) => /\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /\.css$/.test(f))).toBe(true);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toMatch(/\/assets\/[^"]+\.js/);
  }, BUILD_TIMEOUT);

  it("returns the same path on repeated calls (memoized)", () => {
    const a = ensureTestDist();
    const b = ensureTestDist();
    expect(a).toBe(b);
  }, BUILD_TIMEOUT);
});
