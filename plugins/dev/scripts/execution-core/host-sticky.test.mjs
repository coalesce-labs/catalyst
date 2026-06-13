// host-sticky.test.mjs — unit tests for sticky identity round-trip (CTL-1093 Phase 1).
// Run: cd plugins/dev/scripts/execution-core && bun test host-sticky.test.mjs

import { test, expect } from "bun:test";
import { readStickyIdentity, writeStickyIdentity } from "./host-sticky.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("write then read round-trips the name", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-"));
  writeStickyIdentity({ dir, name: "mini" });
  expect(readStickyIdentity({ dir })).toBe("mini");
  rmSync(dir, { recursive: true, force: true });
});

test("read returns null on missing file", () => {
  expect(readStickyIdentity({ dir: "/nonexistent-xyz-ctl1093" })).toBeNull();
});

test("read returns null on malformed file (never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-"));
  writeFileSync(join(dir, ".host-identity.json"), "{ not json");
  expect(readStickyIdentity({ dir })).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("read returns null when name field is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-"));
  writeFileSync(join(dir, ".host-identity.json"), JSON.stringify({ other: "field" }));
  expect(readStickyIdentity({ dir })).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("read returns null when name is empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-"));
  writeFileSync(join(dir, ".host-identity.json"), JSON.stringify({ name: "" }));
  expect(readStickyIdentity({ dir })).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("write is idempotent — second write wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-"));
  writeStickyIdentity({ dir, name: "first" });
  writeStickyIdentity({ dir, name: "second" });
  expect(readStickyIdentity({ dir })).toBe("second");
  rmSync(dir, { recursive: true, force: true });
});
