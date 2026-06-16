import { describe, it, expect, beforeEach } from "bun:test";
import {
  peekTranscriptCache,
  _seedTranscriptCacheForTest,
  _getTranscriptCacheSize,
  _clearTranscriptCache,
  TRANSCRIPT_CACHE_CAP,
} from "../lib/board-data.mjs";

// resolveTranscript captures HOME at module scope via os.homedir() (not
// process.env.HOME), so the production scan can't be redirected to a temp dir in
// a unit test. The LRU bound itself is exercised through the test-only seeding
// export, which drives the same _transcriptPathCache.set + cap path that
// resolveTranscript uses on a HIT.
describe("transcript-path cache bound (CTL-1215 A2)", () => {
  beforeEach(() => {
    _clearTranscriptCache();
  });

  it("caps the cache at TRANSCRIPT_CACHE_CAP under sustained distinct sessions", () => {
    expect(TRANSCRIPT_CACHE_CAP).toBeGreaterThan(0);
    for (let i = 0; i < TRANSCRIPT_CACHE_CAP + 100; i++) {
      _seedTranscriptCacheForTest(`sid-${i}`, `/tmp/projects/p/sid-${i}.jsonl`);
    }
    expect(_getTranscriptCacheSize()).toBeLessThanOrEqual(TRANSCRIPT_CACHE_CAP);
  });

  it("keeps the most-recently-seeded session (LRU keeps newest)", () => {
    for (let i = 0; i < TRANSCRIPT_CACHE_CAP + 5; i++) {
      _seedTranscriptCacheForTest(`sid-${i}`, `/tmp/projects/p/sid-${i}.jsonl`);
    }
    // The newest sid must still be resolvable; the oldest must be evicted.
    const newest = `sid-${TRANSCRIPT_CACHE_CAP + 4}`;
    expect(peekTranscriptCache(newest)).toBe(`/tmp/projects/p/${newest}.jsonl`);
    expect(peekTranscriptCache("sid-0")).toBeNull();
  });
});
