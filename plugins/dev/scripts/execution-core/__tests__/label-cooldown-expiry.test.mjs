import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { inLabelCooldown, labelCooldownPath } from "../label-guard.mjs";

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function marker(value) {
  const dir = mkdtempSync(`${tmpdir()}/cat-134-`); dirs.push(dir);
  const path = labelCooldownPath(dir, "CAT-134", "blocked");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value);
  return dir;
}

describe("label cooldown expiry", () => {
  test("honors explicit retryAfterMs", () => expect(inLabelCooldown(marker(JSON.stringify({ failedAt: 0, retryAfterMs: 900_000 })), "CAT-134", "blocked", 120_000)).toBe(true));
  test("uses legacy fallback", () => expect(inLabelCooldown(marker(JSON.stringify({ failedAt: 0 })), "CAT-134", "blocked", 30_000)).toBe(true));
  test("fails open for malformed markers", () => expect(inLabelCooldown(marker("nope"), "CAT-134", "blocked", 1)).toBe(false));
});
