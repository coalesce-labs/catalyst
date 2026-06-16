import { describe, it, expect, beforeEach } from "bun:test";
import {
  fillTitleDescriptionFallback,
  _clearTitleDescCache,
  _getTitleDescCacheSize,
  _sweepTitleDescCache,
  TITLE_DESC_CAP,
} from "../lib/linear-title-description-fallback.mjs";

// These IDs all FAIL parseIdentifier (no team-number shape) so fillTitle…
// stores a null entry WITHOUT firing any GraphQL — no network in tests.
function unparseableIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `zzz${i}`);
}

describe("title-desc cache bound (CTL-1215 A1)", () => {
  beforeEach(() => {
    _clearTitleDescCache();
  });

  it("caps the cache at TITLE_DESC_CAP under sustained inserts", async () => {
    expect(TITLE_DESC_CAP).toBeGreaterThan(0);
    await fillTitleDescriptionFallback(unparseableIds(TITLE_DESC_CAP + 50));
    expect(_getTitleDescCacheSize()).toBeLessThanOrEqual(TITLE_DESC_CAP);
  });

  it("_sweepTitleDescCache drops expired entries far in the future and returns the count", async () => {
    await fillTitleDescriptionFallback(unparseableIds(10));
    const before = _getTitleDescCacheSize();
    expect(before).toBe(10);
    // unparseable entries get the 5-min default TTL; a now far ahead expires all.
    const farFuture = Date.now() + 60 * 60 * 1000; // +1h
    const removed = _sweepTitleDescCache(farFuture);
    expect(removed).toBe(before);
    expect(_getTitleDescCacheSize()).toBe(0);
  });

  it("_sweepTitleDescCache leaves a freshly-set entry untouched at now+6min", async () => {
    await fillTitleDescriptionFallback(unparseableIds(3));
    // 6 min ahead: the 5-min-TTL unparseable entries ARE expired (sweep removes them),
    // so re-insert and sweep at a horizon shorter than the default TTL to prove
    // fresh entries survive.
    _clearTitleDescCache();
    await fillTitleDescriptionFallback(unparseableIds(3));
    const removed = _sweepTitleDescCache(Date.now() + 60 * 1000); // +1 min < 5 min TTL
    expect(removed).toBe(0);
    expect(_getTitleDescCacheSize()).toBe(3);
  });
});
