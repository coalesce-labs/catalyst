import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneCooldownPath, readLaneCooldown, inLaneCooldown, parkLane, clearLaneCooldown } from "./lane-cooldown.mjs";
import { USAGE_LIMIT_FALLBACK_MS } from "./usage-limit.mjs";
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-cooldown-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("parked lane expires at reset and never shortens", () => {
  const now = Date.parse("2026-08-08T20:00:00Z");
  parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
  parkLane(dir, "bg", { resetsAt: "2026-08-09T18:00:00Z", now });
  expect(readLaneCooldown(dir, "bg").expiresAt).toBe(Date.parse("2026-08-10T18:00:00Z"));
  expect(inLaneCooldown(dir, "bg", now)).toBe(true);
  expect(inLaneCooldown(dir, "bg", Date.parse("2026-08-11T00:00:00Z"))).toBe(false);
});
test("missing and malformed markers fail open", () => {
  expect(inLaneCooldown(dir, "bg", Date.now())).toBe(false);
  mkdirSync(join(dir, ".lane-cooldowns"));
  writeFileSync(laneCooldownPath(dir, "bg"), "{{{");
  expect(inLaneCooldown(dir, "bg", Date.now())).toBe(false);
});
test("stale reset timestamps use the bounded fallback", () => {
  const now = Date.parse("2026-08-08T20:00:00Z");
  const marker = parkLane(dir, "bg", { resetsAt: "2026-08-08T19:00:00Z", now });
  expect(marker.expiresAt).toBe(now + USAGE_LIMIT_FALLBACK_MS);
});
test("a recovered lane can be explicitly unparked", () => {
  parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now: Date.parse("2026-08-08T20:00:00Z") });
  expect(clearLaneCooldown(dir, "bg")).toBe(true);
  expect(readLaneCooldown(dir, "bg")).toBeNull();
});
