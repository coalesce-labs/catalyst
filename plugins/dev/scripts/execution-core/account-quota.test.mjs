import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCOUNT_QUOTA_MAX_AGE_MS,
  accountQuotaPath,
  readAccountQuota,
  resolveAccountResetsAt,
  writeAccountQuota,
} from "./account-quota.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "cat58-account-quota-"));
  dirs.push(dir);
  return dir;
}

describe("account quota snapshot", () => {
  test("writeAccountQuota publishes sampled resets atomically", () => {
    const orchDir = freshDir();
    writeAccountQuota(orchDir, { sevenDayResetsAt: "2026-08-10T18:00:00.000Z", sevenDayPct: 100 }, { now: () => Date.parse("2026-08-08T18:00:00.000Z") });
    expect(readAccountQuota(orchDir, { now: () => Date.parse("2026-08-08T18:01:00.000Z") }).sevenDayResetsAt).toBe("2026-08-10T18:00:00.000Z");
    expect(readdirSync(orchDir).filter((name) => name.includes(".tmp."))).toHaveLength(0);
  });

  test("readAccountQuota fails open on absent and corrupt files", () => {
    expect(readAccountQuota("/nonexistent/cat58-account-quota")).toBeNull();
    const orchDir = freshDir();
    writeFileSync(accountQuotaPath(orchDir), "{not json");
    expect(readAccountQuota(orchDir)).toBeNull();
  });

  test("resolveAccountResetsAt selects the reset for the most exhausted window, then falls back", () => {
    const nowMs = Date.parse("2026-08-08T18:00:00.000Z");
    const orchDir = freshDir();
    writeAccountQuota(orchDir, { fiveHourPct: 80, sevenDayPct: 100, fiveHourResetsAt: "2026-08-08T20:00:00.000Z", sevenDayResetsAt: "2026-08-10T18:00:00.000Z" }, { now: () => nowMs });
    expect(resolveAccountResetsAt(orchDir, { now: () => nowMs })).toBe("2026-08-10T18:00:00.000Z");
    writeAccountQuota(orchDir, { fiveHourPct: 100, sevenDayPct: 80, fiveHourResetsAt: "2026-08-08T20:00:00.000Z", sevenDayResetsAt: "2026-08-10T18:00:00.000Z" }, { now: () => nowMs });
    expect(resolveAccountResetsAt(orchDir, { now: () => nowMs })).toBe("2026-08-08T20:00:00.000Z");
    writeAccountQuota(orchDir, { fiveHourResetsAt: "2026-08-08T20:00:00.000Z" }, { now: () => nowMs });
    expect(resolveAccountResetsAt(orchDir, { now: () => nowMs })).toBe("2026-08-08T20:00:00.000Z");
    writeAccountQuota(orchDir, { fiveHourPct: null, sevenDayPct: 80, fiveHourResetsAt: "2026-08-08T20:00:00.000Z", sevenDayResetsAt: "2026-08-10T18:00:00.000Z" }, { now: () => nowMs });
    expect(resolveAccountResetsAt(orchDir, { now: () => nowMs })).toBe("2026-08-10T18:00:00.000Z");
    writeAccountQuota(orchDir, {}, { now: () => nowMs });
    expect(resolveAccountResetsAt(orchDir, { now: () => nowMs })).toBeNull();
  });

  test("a stale snapshot is ignored", () => {
    const orchDir = freshDir();
    const sampledAt = Date.parse("2026-08-08T18:00:00.000Z");
    writeAccountQuota(orchDir, { sevenDayResetsAt: "2026-08-10T18:00:00.000Z" }, { now: () => sampledAt });
    expect(readAccountQuota(orchDir, { now: () => sampledAt + ACCOUNT_QUOTA_MAX_AGE_MS + 1 })).toBeNull();
  });
});
