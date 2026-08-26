// lookup-corpus-integration.test.ts — Phase 2 integration gate (CTL-751)
// Verifies the committed reference-class-corpus.json is consumable and
// returns a valid points value. Fails until Phase 1's corpus is committed.
// Run: bun test plugins/pm/scripts/estimate/__tests__/lookup-corpus-integration.test.ts
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const LOOKUP = resolve(import.meta.dir, "../reference-class-lookup.ts");
const CORPUS = resolve(import.meta.dir, "../reference-class-corpus.json");

describe("reference-class-lookup corpus integration", () => {
  test("lookup exits 0 and returns a valid points value", () => {
    const r = spawnSync(
      "bun",
      [LOOKUP, "--corpus", CORPUS, "--title", "wire estimate write-back into scheduler", "--json"],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    const points = json.reference_class?.points;
    expect([1, 3, 5, 8, 13]).toContain(points);
    expect(Array.isArray(json.neighbors)).toBe(true);
  });
});
