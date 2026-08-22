// steward-item-pages.test.mjs — CTL-2129 Phase 3. The per-item page counter is a
// durable, fail-open latch keyed by scope key. Run from execution-core/ under
// `bun test`.
//
// ⚠️ Registered in .github/workflows/execution-core-tests.yml (explicit allowlist,
// not a glob) — an unlisted execution-core test never gates CI.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readItemPages, recordItemPage, resetItemPages } from "../steward-item-pages.mjs";

const dirs = [];
function tmpOrch() {
  const d = mkdtempSync(join(tmpdir(), "ctl2129-pages-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("starts at 0, increments across pages", () => {
  const orchDir = tmpOrch();
  expect(readItemPages(orchDir, "proj-1")).toBe(0);
  expect(recordItemPage(orchDir, "proj-1", { now: 100 })).toBe(1);
  expect(recordItemPage(orchDir, "proj-1", { now: 200 })).toBe(2);
  expect(readItemPages(orchDir, "proj-1")).toBe(2);
});

test("first_paged_at is stamped once and preserved; last_paged_at advances", () => {
  const orchDir = tmpOrch();
  recordItemPage(orchDir, "proj-1", { now: 100 });
  recordItemPage(orchDir, "proj-1", { now: 500 });
  const raw = JSON.parse(
    readFileSync(join(orchDir, ".steward-pages", "proj-1.json"), "utf8"),
  );
  expect(raw.first_paged_at).toBe(100);
  expect(raw.last_paged_at).toBe(500);
  expect(raw.count).toBe(2);
});

test("resets to 0 once the steward has taken a turn since the last page", () => {
  const orchDir = tmpOrch();
  recordItemPage(orchDir, "proj-1", { now: 100 });
  recordItemPage(orchDir, "proj-1", { now: 200 }); // last_paged_at = 200, count = 2
  // A turn AFTER the last page clears it.
  const tookTurnAfter = (_key, lastPagedAt) => lastPagedAt < 300;
  expect(readItemPages(orchDir, "proj-1", { stewardTookTurn: tookTurnAfter })).toBe(0);
  // A turn BEFORE the last page does not.
  const tookTurnBefore = (_key, lastPagedAt) => lastPagedAt < 150;
  expect(readItemPages(orchDir, "proj-1", { stewardTookTurn: tookTurnBefore })).toBe(2);
});

test("two tickets in one project accrue toward the same key", () => {
  const orchDir = tmpOrch();
  // Both stalled tickets map to the same scope key (project id) → shared count.
  recordItemPage(orchDir, "proj-shared"); // ticket A
  const two = recordItemPage(orchDir, "proj-shared"); // ticket B
  expect(two).toBe(2);
});

test("fail-open: a corrupt marker reads as 0, never throws", () => {
  const orchDir = tmpOrch();
  mkdirSync(join(orchDir, ".steward-pages"), { recursive: true });
  writeFileSync(join(orchDir, ".steward-pages", "proj-1.json"), "{ not json");
  expect(readItemPages(orchDir, "proj-1")).toBe(0);
});

test("fail-open: a throwing stewardTookTurn does not crash the read (uses the stored count)", () => {
  const orchDir = tmpOrch();
  recordItemPage(orchDir, "proj-1", { now: 100 });
  const thrower = () => {
    throw new Error("heartbeat unreadable");
  };
  expect(readItemPages(orchDir, "proj-1", { stewardTookTurn: thrower })).toBe(1);
});

test("resetItemPages removes the marker; a later read is 0", () => {
  const orchDir = tmpOrch();
  recordItemPage(orchDir, "proj-1");
  expect(resetItemPages(orchDir, "proj-1")).toBe(true);
  expect(existsSync(join(orchDir, ".steward-pages", "proj-1.json"))).toBe(false);
  expect(readItemPages(orchDir, "proj-1")).toBe(0);
  // resetting an already-gone marker is a best-effort false, not a throw.
  expect(resetItemPages(orchDir, "proj-1")).toBe(false);
});

test("a key with path metacharacters is sanitized and cannot escape .steward-pages", () => {
  const orchDir = tmpOrch();
  recordItemPage(orchDir, "../../etc/passwd");
  // Nothing was written outside the pages dir; the read round-trips by the same key.
  expect(readItemPages(orchDir, "../../etc/passwd")).toBe(1);
  expect(existsSync(join(orchDir, ".steward-pages"))).toBe(true);
});
