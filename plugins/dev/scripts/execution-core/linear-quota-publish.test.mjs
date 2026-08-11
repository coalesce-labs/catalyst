import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishLinearQuota, readLinearQuota, sampleAndPublish } from "./linear-quota-publish.mjs";

const snap = (at, remaining = 10) => ({ requests: { limit: 100, used: 100 - remaining, remaining, resetAt: null }, sampledAt: at, host: "a" });
describe("linear quota publishing", () => {
  test("publishes atomically and monotonically", () => {
    const dir = mkdtempSync(join(tmpdir(), "linear-quota-"));
    expect(publishLinearQuota(dir, snap("2026-01-02T00:00:00Z", 9))).toBe(true);
    expect(publishLinearQuota(dir, snap("2026-01-01T00:00:00Z", 10))).toBe(false);
    expect(readLinearQuota(dir).requests.remaining).toBe(9);
  });
  test("missing and corrupt snapshots read null", () => {
    const dir = mkdtempSync(join(tmpdir(), "linear-quota-"));
    expect(readLinearQuota(dir)).toBeNull();
    writeFileSync(join(dir, "linear-quota.json"), "{");
    expect(readLinearQuota(dir, { log: { warn() {} } })).toBeNull();
  });
  test("samples headers without throwing on write failure", () => {
    const headers = { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "5" };
    expect(sampleAndPublish(headers, { orchDir: "/nope", nowMs: 0, log: { warn() {} }, fileOps: { readFileSync() { throw Object.assign(new Error(), { code: "ENOENT" }); }, writeFileSync() { throw new Error("no"); }, renameSync() {} } })).toBe(false);
  });
});
