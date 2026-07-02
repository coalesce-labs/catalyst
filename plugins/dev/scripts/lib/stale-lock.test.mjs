// Tests for stale-lock.mjs (CTL-1415). Run: bun test plugins/dev/scripts/lib/stale-lock.test.mjs

import { describe, test, expect } from "bun:test";
import { staleLockStatus, indexLockPath, STALE_LOCK_THRESHOLD_MS } from "./stale-lock.mjs";

const NOW = 1_750_000_000_000; // fixed epoch ms
const ROOT = "/co/plugin-source";

// makeStatFn — a statFn seam returning a fixed mtime for the index.lock path and
// null (absent) for anything else, mirroring defaultStatFn's ENOENT→null contract.
function makeStatFn(mtimeMs) {
  const lock = indexLockPath(ROOT);
  return (path) => (path === lock && mtimeMs != null ? mtimeMs : null);
}

describe("indexLockPath", () => {
  test("resolves <root>/.git/index.lock", () => {
    expect(indexLockPath(ROOT)).toBe("/co/plugin-source/.git/index.lock");
  });
});

describe("staleLockStatus", () => {
  test("no lock file → not present, not stale", () => {
    const s = staleLockStatus({ root: ROOT, now: NOW, statFn: makeStatFn(null) });
    expect(s).toEqual({ present: false, ageMs: null, stale: false });
  });

  test("fresh lock (younger than threshold) → present but NOT stale (a live git op)", () => {
    const mtime = NOW - 5_000; // 5s old
    const s = staleLockStatus({ root: ROOT, now: NOW, thresholdMs: 600_000, statFn: makeStatFn(mtime) });
    expect(s.present).toBe(true);
    expect(s.ageMs).toBe(5_000);
    expect(s.stale).toBe(false);
  });

  test("lock exactly at the threshold → stale (>= is inclusive)", () => {
    const mtime = NOW - 600_000;
    const s = staleLockStatus({ root: ROOT, now: NOW, thresholdMs: 600_000, statFn: makeStatFn(mtime) });
    expect(s.stale).toBe(true);
    expect(s.ageMs).toBe(600_000);
  });

  test("old lock (older than threshold) → stale", () => {
    const mtime = NOW - 8.5 * 60 * 60 * 1000; // the 8.5h CTL-1401 freeze
    const s = staleLockStatus({ root: ROOT, now: NOW, thresholdMs: 600_000, statFn: makeStatFn(mtime) });
    expect(s.present).toBe(true);
    expect(s.stale).toBe(true);
  });

  test("future mtime (clock skew) clamps age to 0, never stale/negative", () => {
    const s = staleLockStatus({ root: ROOT, now: NOW, thresholdMs: 600_000, statFn: makeStatFn(NOW + 10_000) });
    expect(s.ageMs).toBe(0);
    expect(s.stale).toBe(false);
  });

  test("empty/missing root → not present (no throw)", () => {
    expect(staleLockStatus({ root: "", now: NOW })).toEqual({ present: false, ageMs: null, stale: false });
    expect(staleLockStatus({ now: NOW })).toEqual({ present: false, ageMs: null, stale: false });
  });

  test("default threshold is 10 minutes", () => {
    expect(STALE_LOCK_THRESHOLD_MS).toBe(600_000);
  });
});
