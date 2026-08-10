import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RECOVERY_FIX_BACKOFF_BASE_MS,
  RECOVERY_FIX_BACKOFF_THRESHOLD,
  clearFixFailures,
  commitFixCommentHash,
  fixCommentHash,
  inFixBackoff,
  recordFixFailure,
  shouldPostFixComment,
} from "./recovery-fix-backoff.mjs";

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "cat-47-backoff-")));

describe("recovery-fix-backoff (CAT-47)", () => {
  test("N identical failures block the N+1th attempt", () => {
    const root = fresh();
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i += 1) {
      recordFixFailure(root, "CAT-9", "orphan_stale", "same", 1000);
    }
    expect(inFixBackoff(root, "CAT-9", "orphan_stale", 1000)).toMatchObject({
      blocked: true,
      count: RECOVERY_FIX_BACKOFF_THRESHOLD,
      lastReason: "same",
    });
  });

  test("a different failure reason resets the counter", () => {
    const root = fresh();
    recordFixFailure(root, "CAT-9", "orphan_stale", "A", 1000);
    recordFixFailure(root, "CAT-9", "orphan_stale", "A", 1000);
    recordFixFailure(root, "CAT-9", "orphan_stale", "B", 1000);
    expect(inFixBackoff(root, "CAT-9", "orphan_stale", 1000).count).toBe(1);
  });

  test("the block expires after its window", () => {
    const root = fresh();
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i += 1) {
      recordFixFailure(root, "CAT-9", "orphan_stale", "same", 1000);
    }
    expect(inFixBackoff(root, "CAT-9", "orphan_stale", 1000 + RECOVERY_FIX_BACKOFF_BASE_MS).blocked).toBe(false);
  });

  test("state is outside workers and success clears failure fields", () => {
    const root = fresh();
    recordFixFailure(root, "CAT-9", "orphan_stale", "same", 1000);
    const path = join(root, ".recovery-fix-failures", "CAT-9-orphan_stale.json");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, "workers", "CAT-9"))).toBe(false);
    clearFixFailures(root, "CAT-9", "orphan_stale");
    expect(existsSync(path)).toBe(false);
  });

  test("malformed state fails open", () => {
    const root = fresh();
    expect(inFixBackoff(root, "CAT-9", "orphan_stale", 1000).blocked).toBe(false);
  });
});

describe("comment dedup latch (CAT-47)", () => {
  test("read is pure and commit suppresses only the identical body", () => {
    const root = fresh();
    const first = fixCommentHash("first");
    const second = fixCommentHash("second");
    expect(shouldPostFixComment(root, "CAT-9", "orphan_stale", first, 1000)).toBe(true);
    expect(shouldPostFixComment(root, "CAT-9", "orphan_stale", first, 1000)).toBe(true);
    commitFixCommentHash(root, "CAT-9", "orphan_stale", first, 1000);
    expect(shouldPostFixComment(root, "CAT-9", "orphan_stale", first, 1000)).toBe(false);
    expect(shouldPostFixComment(root, "CAT-9", "orphan_stale", second, 1000)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".recovery-fix-failures", "CAT-9-orphan_stale.json"), "utf8")).lastCommentHash).toBe(first);
  });
});
