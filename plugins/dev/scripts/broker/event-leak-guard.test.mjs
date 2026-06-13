// event-leak-guard.test.mjs — CTL-1086 sentinel write guard tests.
// Verifies isSentinelLeak predicate + appendEvent drop behavior.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendEvent } from "./router.mjs";
import { isSentinelLeak, defaultProductionEventsDir, getEventLogPath } from "./config.mjs";

describe("CTL-1086 sentinel write guard", () => {
  test("orch-test aimed at default prod path is a leak", () => {
    const prodPath = resolve(homedir(), "catalyst", "events", "2026-06.jsonl");
    expect(isSentinelLeak({ resource: { "catalyst.orchestration": "orch-test" } }, prodPath)).toBe(true);
  });

  test("orch-test aimed at a temp dir is NOT a leak (legit test write)", () => {
    expect(
      isSentinelLeak({ resource: { "catalyst.orchestration": "orch-test" } },
        "/tmp/scratch/events/2026-06.jsonl")
    ).toBe(false);
  });

  test("real orchestration aimed at default prod path is NOT a leak", () => {
    const prodPath = resolve(homedir(), "catalyst", "events", "2026-06.jsonl");
    expect(
      isSentinelLeak({ resource: { "catalyst.orchestration": "orch-CTL-1086" } }, prodPath)
    ).toBe(false);
  });

  test("appendEvent drops a leak and writes nothing", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ctl1086-home-"));
    const prevHome = process.env.HOME;
    const prevDir = process.env.CATALYST_DIR;
    process.env.HOME = fakeHome;
    delete process.env.CATALYST_DIR;
    try {
      appendEvent({ name: "phase.plan.complete.CTL-100", orchestrator: "orch-test" });
      expect(existsSync(getEventLogPath())).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      const hermetic = process.env.CATALYST_HERMETIC_DIR;
      if (hermetic) {
        process.env.CATALYST_DIR = hermetic;
      } else if (prevDir !== undefined) {
        process.env.CATALYST_DIR = prevDir;
      }
    }
  });
});
