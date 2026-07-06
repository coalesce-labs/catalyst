// sweep-stale-recovery-intents.test.mjs — CTL-1431. Tests for the one-time
// operator hygiene tool that lists / deletes escalated recovery-intents aged past
// RECOVERY_TERMINAL_INTENT_TTL_MS.
//
// Run: cd plugins/dev/scripts/execution-core && bun test sweep-stale-recovery-intents.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import {
  selectStaleRecoveryIntents,
  sweepStaleRecoveryIntents,
} from "./sweep-stale-recovery-intents.mjs";
import {
  defaultRecordIntent,
  RECOVERY_TERMINAL_INTENT_TTL_MS,
} from "./recovery-reasoning.mjs";

const intentPath = (orchDir, ticket) =>
  pathJoin(orchDir, ".recovery-intents", `${ticket}.json`);

describe("sweep-stale-recovery-intents (CTL-1431)", () => {
  let orchDir;
  const t0 = 1_000_000_000_000;
  const TTL = RECOVERY_TERMINAL_INTENT_TTL_MS;
  const tNow = t0 + TTL + 1; // just past the TTL for a t0-aged intent

  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-sweep-"));
    // A stale escalated intent (recorded at t0 → aged past the TTL by tNow).
    defaultRecordIntent("STALE-ESC", { decision: "escalate" }, { orchDir, now: () => t0 });
    // A stale but NON-escalated (fix) intent — must never be swept.
    defaultRecordIntent("STALE-FIX", { decision: "fix", fix_class: "x" }, { orchDir, now: () => t0 });
    // A fresh escalated intent (recorded at tNow → age 0) — must never be swept.
    defaultRecordIntent("FRESH-ESC", { decision: "escalate" }, { orchDir, now: () => tNow });
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("selectStaleRecoveryIntents returns only the stale escalated entry", () => {
    const stale = selectStaleRecoveryIntents({ orchDir, now: () => tNow });
    expect(stale.map((s) => s.ticket).sort()).toEqual(["STALE-ESC"]);
  });

  test("dry-run lists stale intents without deleting", () => {
    const { swept, skipped } = sweepStaleRecoveryIntents({
      orchDir,
      now: () => tNow,
      execute: false,
      quiet: true,
    });
    expect(swept).toEqual(["STALE-ESC"]);
    expect(skipped).toEqual([]);
    // Nothing deleted — every seeded file still on disk.
    expect(existsSync(intentPath(orchDir, "STALE-ESC"))).toBe(true);
    expect(existsSync(intentPath(orchDir, "STALE-FIX"))).toBe(true);
    expect(existsSync(intentPath(orchDir, "FRESH-ESC"))).toBe(true);
  });

  test("--execute deletes only the stale escalated intent", () => {
    const { swept, skipped } = sweepStaleRecoveryIntents({
      orchDir,
      now: () => tNow,
      execute: true,
      quiet: true,
    });
    expect(swept).toEqual(["STALE-ESC"]);
    expect(skipped).toEqual([]);
    // Only the stale escalated file is gone.
    expect(existsSync(intentPath(orchDir, "STALE-ESC"))).toBe(false);
    // The fresh escalated + the stale non-escalated survive untouched.
    expect(existsSync(intentPath(orchDir, "FRESH-ESC"))).toBe(true);
    expect(existsSync(intentPath(orchDir, "STALE-FIX"))).toBe(true);
  });

  test("--execute never touches a fresh escalated intent (age < TTL)", () => {
    sweepStaleRecoveryIntents({ orchDir, now: () => tNow, execute: true, quiet: true });
    expect(existsSync(intentPath(orchDir, "FRESH-ESC"))).toBe(true);
  });

  test("forgetIntent is invoked only for stale entries under --execute", () => {
    const forgotten = [];
    const { swept } = sweepStaleRecoveryIntents({
      orchDir,
      now: () => tNow,
      execute: true,
      quiet: true,
      forgetIntent: (ticket) => {
        forgotten.push(ticket);
        return true;
      },
    });
    expect(forgotten).toEqual(["STALE-ESC"]);
    expect(swept).toEqual(["STALE-ESC"]);
  });

  test("absent .recovery-intents dir → empty sweep, no throw", () => {
    const empty = mkdtempSync(pathJoin(tmpdir(), "rec-sweep-empty-"));
    try {
      const { swept } = sweepStaleRecoveryIntents({ orchDir: empty, now: () => tNow, quiet: true });
      expect(swept).toEqual([]);
      expect(selectStaleRecoveryIntents({ orchDir: empty, now: () => tNow })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
