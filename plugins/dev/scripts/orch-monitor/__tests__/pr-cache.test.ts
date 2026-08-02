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
