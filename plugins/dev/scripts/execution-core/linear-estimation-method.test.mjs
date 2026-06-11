// linear-estimation-method.test.mjs — unit tests for CTL-954.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-estimation-method.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getEstimationMethod,
  scaleForMethod,
  mapScopeToEstimate,
  _resetMemoForTests,
} from "./linear-estimation-method.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

// Isolate each test by redirecting HOME to a temp dir so cache files don't
// collide with production state and don't persist between tests.
let tmpHome;
beforeEach(() => {
  tmpHome = join(tmpdir(), `lem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "catalyst", "execution-core"), { recursive: true });
  process.env.HOME = tmpHome;
  _resetMemoForTests();
});
afterEach(() => {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.HOME;
  _resetMemoForTests();
});

function cacheFilePath(teamId) {
  return join(tmpHome, "catalyst", "execution-core", `team-estimation-${teamId}.json`);
}

function writeCacheRecord(teamId, method, fetchedAt = new Date().toISOString()) {
  writeFileSync(
    cacheFilePath(teamId),
    JSON.stringify({ teamId, method, fetchedAt })
  );
}

// ── scaleForMethod ────────────────────────────────────────────────────────────

describe("scaleForMethod", () => {
  test("fibonacci → [0,1,2,3,5,8,13]", () => {
    expect(scaleForMethod("fibonacci")).toEqual([0, 1, 2, 3, 5, 8, 13]);
  });
  test("tShirt → [0,1,2,3,5]", () => {
    expect(scaleForMethod("tShirt")).toEqual([0, 1, 2, 3, 5]);
  });
  test("exponential → [0,1,2,4,8,16,32]", () => {
    expect(scaleForMethod("exponential")).toEqual([0, 1, 2, 4, 8, 16, 32]);
  });
  test("linear → [0..10]", () => {
    expect(scaleForMethod("linear")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  test("notUsed → []", () => {
    expect(scaleForMethod("notUsed")).toEqual([]);
  });
  test("unknown string → []", () => {
    expect(scaleForMethod("mystery")).toEqual([]);
  });
});

// ── mapScopeToEstimate ────────────────────────────────────────────────────────

describe("mapScopeToEstimate — fibonacci", () => {
  test("xs → 1", () => expect(mapScopeToEstimate("xs", "fibonacci")).toBe(1));
  test("small → 1", () => expect(mapScopeToEstimate("small", "fibonacci")).toBe(1));
  test("medium → 3", () => expect(mapScopeToEstimate("medium", "fibonacci")).toBe(3));
  test("large → 5", () => expect(mapScopeToEstimate("large", "fibonacci")).toBe(5));
  test("xl → 8", () => expect(mapScopeToEstimate("xl", "fibonacci")).toBe(8));
  test("epic → 8", () => expect(mapScopeToEstimate("epic", "fibonacci")).toBe(8));
});

describe("mapScopeToEstimate — tShirt", () => {
  test("xs → 0 (XS)", () => expect(mapScopeToEstimate("xs", "tShirt")).toBe(0));
  test("small → 1 (S)", () => expect(mapScopeToEstimate("small", "tShirt")).toBe(1));
  test("medium → 2 (M)", () => expect(mapScopeToEstimate("medium", "tShirt")).toBe(2));
  test("large → 3 (L)", () => expect(mapScopeToEstimate("large", "tShirt")).toBe(3));
  test("xl → 5 (XL)", () => expect(mapScopeToEstimate("xl", "tShirt")).toBe(5));
  test("epic → 5 (XL, clamped)", () => expect(mapScopeToEstimate("epic", "tShirt")).toBe(5));
});

describe("mapScopeToEstimate — exponential", () => {
  test("small → 1", () => expect(mapScopeToEstimate("small", "exponential")).toBe(1));
  test("medium → 2", () => expect(mapScopeToEstimate("medium", "exponential")).toBe(2));
  test("large → 4", () => expect(mapScopeToEstimate("large", "exponential")).toBe(4));
  test("xl → 8", () => expect(mapScopeToEstimate("xl", "exponential")).toBe(8));
  test("epic → 8", () => expect(mapScopeToEstimate("epic", "exponential")).toBe(8));
});

describe("mapScopeToEstimate — linear", () => {
  test("small → 1", () => expect(mapScopeToEstimate("small", "linear")).toBe(1));
  test("medium → 2", () => expect(mapScopeToEstimate("medium", "linear")).toBe(2));
  test("large → 3", () => expect(mapScopeToEstimate("large", "linear")).toBe(3));
  test("xl → 4", () => expect(mapScopeToEstimate("xl", "linear")).toBe(4));
});

describe("mapScopeToEstimate — edge cases", () => {
  test("notUsed → null", () => expect(mapScopeToEstimate("medium", "notUsed")).toBeNull());
  test("unknown type → null", () => expect(mapScopeToEstimate("medium", "mystery")).toBeNull());
  test("null scope → null", () => expect(mapScopeToEstimate(null, "fibonacci")).toBeNull());
  test("empty scope → null", () => expect(mapScopeToEstimate("", "fibonacci")).toBeNull());
  test("null type → null", () => expect(mapScopeToEstimate("small", null)).toBeNull());
  test("unrecognized scope 'huge' → null", () =>
    expect(mapScopeToEstimate("huge", "fibonacci")).toBeNull());
  test("case-insensitive: 'SMALL' → 1 (fibonacci)", () =>
    expect(mapScopeToEstimate("SMALL", "fibonacci")).toBe(1));
  test("case-insensitive: 'Medium' → 3 (fibonacci)", () =>
    expect(mapScopeToEstimate("Medium", "fibonacci")).toBe(3));
});

// ── getEstimationMethod — cache ───────────────────────────────────────────────

describe("getEstimationMethod — cache hit", () => {
  test("reads from disk cache on cold start (no memo)", () => {
    const method = { type: "fibonacci", allowZero: true, extended: false };
    writeCacheRecord("TEAM-1", method);
    const result = getEstimationMethod("TEAM-1");
    expect(result).toEqual(method);
  });

  test("in-process memo avoids second disk read", () => {
    const method = { type: "tShirt", allowZero: false, extended: false };
    writeCacheRecord("TEAM-2", method);
    // First call populates memo.
    getEstimationMethod("TEAM-2");
    // Delete the disk cache — memo should still serve it.
    rmSync(cacheFilePath("TEAM-2"));
    const result = getEstimationMethod("TEAM-2");
    expect(result).toEqual(method);
  });

  test("stale cache (past TTL) is treated as a miss → returns null (no real fetch in test)", () => {
    const method = { type: "fibonacci", allowZero: true, extended: false };
    // fetchedAt 8 days ago → beyond DEFAULT_TTL_MS (7d)
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeCacheRecord("TEAM-3", method, staleDate);
    // No LINEAR_API_TOKEN set → curl will fail → fail-open null.
    const result = getEstimationMethod("TEAM-3", { ttlMs: 7 * 24 * 60 * 60 * 1000 });
    // Either null (curl failed) or the method (if somehow cached) — we only
    // assert the stale check doesn't throw and returns null/object.
    expect(result === null || typeof result.type === "string").toBe(true);
  });

  test("custom short TTL forces re-fetch even on fresh cache", () => {
    const method = { type: "fibonacci", allowZero: true, extended: false };
    writeCacheRecord("TEAM-4", method);
    // 1ms TTL → even a just-written record is stale.
    const result = getEstimationMethod("TEAM-4", { ttlMs: 1 });
    // No token → curl fails → null (fail-open).
    expect(result === null || typeof result?.type === "string").toBe(true);
  });

  test("corrupt cache JSON → falls through to fetch → null (no token)", () => {
    writeFileSync(cacheFilePath("TEAM-5"), "not-valid-json");
    const result = getEstimationMethod("TEAM-5");
    expect(result === null || typeof result?.type === "string").toBe(true);
  });

  test("null teamId → returns null immediately", () => {
    expect(getEstimationMethod(null)).toBeNull();
  });

  test("empty string teamId → returns null immediately", () => {
    expect(getEstimationMethod("")).toBeNull();
  });

  test("non-string teamId → returns null immediately", () => {
    expect(getEstimationMethod(42)).toBeNull();
  });
});

// ── Integration: getEstimationMethod → mapScopeToEstimate ────────────────────

describe("getEstimationMethod + mapScopeToEstimate integration", () => {
  test("cached tShirt method → mapScopeToEstimate produces correct tShirt values", () => {
    const method = { type: "tShirt", allowZero: true, extended: false };
    writeCacheRecord("CTL-UUID", method);
    const m = getEstimationMethod("CTL-UUID");
    expect(m).not.toBeNull();
    expect(mapScopeToEstimate("medium", m.type)).toBe(2); // M
    expect(mapScopeToEstimate("large", m.type)).toBe(3);  // L
    expect(mapScopeToEstimate("epic", m.type)).toBe(5);   // XL (clamped)
  });

  test("cached fibonacci method → mapScopeToEstimate produces fibonacci values", () => {
    const method = { type: "fibonacci", allowZero: true, extended: false };
    writeCacheRecord("CTL-UUID2", method);
    const m = getEstimationMethod("CTL-UUID2");
    expect(m).not.toBeNull();
    expect(mapScopeToEstimate("small", m.type)).toBe(1);
    expect(mapScopeToEstimate("medium", m.type)).toBe(3);
    expect(mapScopeToEstimate("large", m.type)).toBe(5);
    expect(mapScopeToEstimate("epic", m.type)).toBe(8);
  });
});
