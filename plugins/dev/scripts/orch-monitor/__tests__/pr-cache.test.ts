// Tests for the pr_status_cache write/read path added in CTL-1606.
// Run: cd plugins/dev/scripts/orch-monitor && bun test pr-cache

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileBasedPrCache } from "../lib/pr-cache";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-cache-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("putStatus persists one row per (repo, pr_number); getAllStatuses reads it back", () => {
  const c = createFileBasedPrCache(join(dir, "s1.db"));
  c.putStatus("org/x", 42, "open");
  c.putStatus("org/x", 42, "merged"); // same PR → upsert, one row
  c.putStatus("org/y", 7, "closed");
  const rows = c.getAllStatuses();
  expect(rows.find((r) => r.repo === "org/x" && r.pr_number === 42)?.status).toBe("merged");
  expect(rows.find((r) => r.repo === "org/y" && r.pr_number === 7)?.status).toBe("closed");
  expect(rows.filter((r) => r.pr_number === 42).length).toBe(1); // upsert, not append
});

test("putStatus stamps a fresh updated_at on every write", () => {
  const c = createFileBasedPrCache(join(dir, "s2.db"));
  c.putStatus("org/x", 1, "open");
  const first = c.getAllStatuses()[0].updated_at;
  c.putStatus("org/x", 1, "merged");
  const second = c.getAllStatuses()[0].updated_at;
  expect(second >= first).toBe(true);
});

test("existing put/get still work after adding pr_status_cache table", () => {
  const c = createFileBasedPrCache(join(dir, "s3.db"));
  c.put("org/x", "sha123", "main", 10);
  expect(c.get("org/x", "sha123")).toBe(10);
  expect(c.get("org/x", "nope")).toBeNull();
});

test("getAllStatuses returns empty array on fresh DB", () => {
  const c = createFileBasedPrCache(join(dir, "s4.db"));
  expect(c.getAllStatuses()).toEqual([]);
});

// ─── CTL-1606 (Codex #2878 P1): `merged` is terminal ─────────────────────────
// Webhook delivery is unordered — startup replay overlaps live delivery and GitHub
// retries old deliveries — so a stale `opened`/`synchronize` (which carries
// merged:false) can arrive AFTER the merge and would otherwise overwrite `merged`
// with `open` and take a newer updated_at, making newest-wins prefer the wrong
// answer and board-health misclassify a merged PR as an orphaned open one.

test("a stale non-merged write cannot walk back a merged status", () => {
  const c = createFileBasedPrCache(join(dir, "t.db"));
  c.putStatus("o/r", 7, "merged");
  c.putStatus("o/r", 7, "open"); // the late, stale opened/synchronize delivery
  const row = c.getAllStatuses().find((r) => r.pr_number === 7);
  expect(row?.status).toBe("merged");
});

test("the latch also rejects a later `closed` over `merged`", () => {
  const c = createFileBasedPrCache(join(dir, "t.db"));
  c.putStatus("o/r", 8, "merged");
  c.putStatus("o/r", 8, "closed");
  expect(c.getAllStatuses().find((r) => r.pr_number === 8)?.status).toBe("merged");
});

test("the latch does NOT freeze updated_at for non-terminal rows", () => {
  const c = createFileBasedPrCache(join(dir, "t.db"));
  c.putStatus("o/r", 9, "open");
  const first = c.getAllStatuses().find((r) => r.pr_number === 9)?.updated_at;
  c.putStatus("o/r", 9, "merged");
  const row = c.getAllStatuses().find((r) => r.pr_number === 9);
  expect(row?.status).toBe("merged");
  expect(String(row?.updated_at) >= String(first)).toBe(true);
});

test("a reopen (closed -> open) is still allowed — only `merged` is terminal", () => {
  const c = createFileBasedPrCache(join(dir, "t.db"));
  c.putStatus("o/r", 10, "closed");
  c.putStatus("o/r", 10, "open");
  expect(c.getAllStatuses().find((r) => r.pr_number === 10)?.status).toBe("open");
});

test("the latch is per (repo, pr_number) — a merged PR does not freeze its twins", () => {
  const c = createFileBasedPrCache(join(dir, "t.db"));
  c.putStatus("o/r", 11, "merged");
  c.putStatus("o/other", 11, "open"); // same number, different repo
  c.putStatus("o/r", 12, "open");
  const rows = c.getAllStatuses();
  expect(rows.find((r) => r.repo === "o/r" && r.pr_number === 11)?.status).toBe("merged");
  expect(rows.find((r) => r.repo === "o/other" && r.pr_number === 11)?.status).toBe("open");
  expect(rows.find((r) => r.pr_number === 12)?.status).toBe("open");
});
