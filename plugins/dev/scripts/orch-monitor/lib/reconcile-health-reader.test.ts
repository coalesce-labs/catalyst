// reconcile-health-reader.test.ts — CTL-867: reads the execution-core per-team
// reconcile-health markers so /api/snapshot can surface each team's "last
// successful eligible refresh age".

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readReconcileHealth } from "./reconcile-health-reader.ts";

let catalystDir: string;

beforeEach(() => {
  catalystDir = mkdtempSync(join(tmpdir(), "recon-health-"));
});

afterEach(() => {
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeMarker(team: string, marker: Record<string, unknown>) {
  const dir = join(catalystDir, "execution-core", "reconcile-health");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${team}.json`), JSON.stringify(marker));
}

describe("readReconcileHealth", () => {
  test("missing dir → empty map (never throws)", () => {
    expect(readReconcileHealth(catalystDir)).toEqual({});
  });

  test("computes ageMs from lastSuccessTs against injected now", () => {
    writeMarker("ENG", {
      team: "ENG",
      lastSuccessTs: "2026-06-08T10:00:00Z",
      consecutiveFailures: 0,
      alerting: false,
      updatedAt: "2026-06-08T10:00:00Z",
    });
    const now = () => Date.parse("2026-06-08T10:05:00Z");
    const health = readReconcileHealth(catalystDir, { now });
    expect(health.ENG).toBeDefined();
    expect(health.ENG.ageMs).toBe(5 * 60_000);
    expect(health.ENG.alerting).toBe(false);
    expect(health.ENG.consecutiveFailures).toBe(0);
  });

  test("surfaces a starving team — alerting true, consecutiveFailures set, frozen lastSuccessTs", () => {
    writeMarker("CTL", {
      team: "CTL",
      lastSuccessTs: "2026-06-08T08:00:00Z",
      consecutiveFailures: 12,
      alerting: true,
      updatedAt: "2026-06-08T10:00:00Z",
    });
    const now = () => Date.parse("2026-06-08T10:00:00Z");
    const health = readReconcileHealth(catalystDir, { now });
    expect(health.CTL.alerting).toBe(true);
    expect(health.CTL.consecutiveFailures).toBe(12);
    expect(health.CTL.ageMs).toBe(2 * 60 * 60_000); // 2h stale
  });

  test("null lastSuccessTs → ageMs null (never refreshed)", () => {
    writeMarker("NEW", { team: "NEW", lastSuccessTs: null, consecutiveFailures: 1, alerting: false });
    const health = readReconcileHealth(catalystDir);
    expect(health.NEW.lastSuccessTs).toBeNull();
    expect(health.NEW.ageMs).toBeNull();
  });

  test("malformed marker is skipped; valid siblings still read", () => {
    writeMarker("GOOD", {
      team: "GOOD",
      lastSuccessTs: "2026-06-08T10:00:00Z",
      consecutiveFailures: 0,
      alerting: false,
    });
    const dir = join(catalystDir, "execution-core", "reconcile-health");
    writeFileSync(join(dir, "BAD.json"), "{ not json");
    const health = readReconcileHealth(catalystDir);
    expect(health.GOOD).toBeDefined();
    expect(health.BAD).toBeUndefined();
  });

  test("ignores .tmp files and non-json entries", () => {
    const dir = join(catalystDir, "execution-core", "reconcile-health");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ENG.json.tmp"), "{}");
    writeFileSync(join(dir, "README"), "ignore me");
    expect(readReconcileHealth(catalystDir)).toEqual({});
  });
});
