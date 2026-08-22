// sweep-stale-recovery-intents.test.mjs — CTL-1431. Tests for the one-time
// operator hygiene tool that lists / deletes escalated recovery-intents aged past
// RECOVERY_TERMINAL_INTENT_TTL_MS.
//
// Run: cd plugins/dev/scripts/execution-core && bun test sweep-stale-recovery-intents.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import {
  selectStaleRecoveryIntents,
  sweepStaleRecoveryIntents,
  selectStaleFixFailures,
  sweepStaleFixFailures,
  RECOVERY_FIX_FAILURE_TTL_MS,
} from "./sweep-stale-recovery-intents.mjs";
import {
  defaultRecordIntent,
  RECOVERY_TERMINAL_INTENT_TTL_MS,
} from "./recovery-reasoning.mjs";
import {
  clearFixFailures,
  commitFixCommentHash,
  fixCommentHash,
  recordFixFailure,
  RECOVERY_FIX_BACKOFF_MAX_MS,
} from "./recovery-fix-backoff.mjs";

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

  test("(F1) selectStaleRecoveryIntents throws on a non-finite/non-positive ttl (never sweeps the whole ledger)", () => {
    // A mistyped `--ttl-days foo` → NaN would otherwise make `ageMs < ttlMs` always
    // false and mark EVERY escalated intent stale. Guard rejects it loudly instead.
    expect(() => selectStaleRecoveryIntents({ orchDir, ttlMs: NaN, now: () => tNow })).toThrow();
    expect(() => selectStaleRecoveryIntents({ orchDir, ttlMs: 0, now: () => tNow })).toThrow();
    expect(() => selectStaleRecoveryIntents({ orchDir, ttlMs: -5, now: () => tNow })).toThrow();
  });
});

describe("fix-failure marker hygiene (CAT-124)", () => {
  let orchDir;
  const t0 = 1_000_000_000_000;
  const fixPath = (ticket) =>
    pathJoin(orchDir, ".recovery-fix-failures", `${ticket}-orphan_stale.json`);

  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "fix-failure-sweep-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("selects an aged failure and leaves a fresh failure", () => {
    const tNow = t0 + RECOVERY_FIX_FAILURE_TTL_MS + 1;
    recordFixFailure(orchDir, "OLD-1", "orphan_stale", "same", t0);
    recordFixFailure(orchDir, "NEW-1", "orphan_stale", "same", tNow);

    const result = selectStaleFixFailures({ orchDir, now: () => tNow });
    expect(result.stale.map((entry) => entry.file)).toEqual(["OLD-1-orphan_stale.json"]);
    expect(result.unagable).toEqual([]);
  });

  test("ages residual comment-hash-only files by lastCommentTs", () => {
    commitFixCommentHash(orchDir, "RES-1", "orphan_stale", fixCommentHash("body"), t0);
    clearFixFailures(orchDir, "RES-1", "orphan_stale");

    expect(selectStaleFixFailures({ orchDir, now: () => t0 + RECOVERY_FIX_FAILURE_TTL_MS - 1 }).stale).toEqual([]);
    expect(selectStaleFixFailures({ orchDir, now: () => t0 + RECOVERY_FIX_FAILURE_TTL_MS + 1 }).stale.map((entry) => entry.file)).toEqual(["RES-1-orphan_stale.json"]);
  });

  test("uses the newest timestamp as the age anchor", () => {
    recordFixFailure(orchDir, "BOTH-1", "orphan_stale", "same", t0);
    commitFixCommentHash(orchDir, "BOTH-1", "orphan_stale", fixCommentHash("body"), t0 + RECOVERY_FIX_FAILURE_TTL_MS);

    expect(selectStaleFixFailures({ orchDir, now: () => t0 + RECOVERY_FIX_FAILURE_TTL_MS + 1 }).stale).toEqual([]);
    expect(selectStaleFixFailures({ orchDir, now: () => t0 + 2 * RECOVERY_FIX_FAILURE_TTL_MS + 1 }).stale.map((entry) => entry.file)).toEqual(["BOTH-1-orphan_stale.json"]);
  });

  test("leaves timestamp-less files in place and reports them as un-agable", () => {
    mkdirSync(pathJoin(orchDir, ".recovery-fix-failures"), { recursive: true });
    writeFileSync(fixPath("NOTS-1"), '{"lastCommentHash":"x"}\n');

    const selected = selectStaleFixFailures({ orchDir, now: () => t0 });
    expect(selected.stale).toEqual([]);
    expect(selected.unagable).toEqual([{ file: "NOTS-1-orphan_stale.json" }]);
    sweepStaleFixFailures({ orchDir, now: () => t0, execute: true, quiet: true });
    expect(existsSync(fixPath("NOTS-1"))).toBe(true);
  });

  test("rejects non-finite and non-positive TTLs", () => {
    expect(() => selectStaleFixFailures({ orchDir, ttlMs: NaN })).toThrow();
    expect(() => selectStaleFixFailures({ orchDir, ttlMs: 0 })).toThrow();
    expect(() => selectStaleFixFailures({ orchDir, ttlMs: -5 })).toThrow();
  });

  test("default TTL outlives the maximum backoff and terminal intent windows", () => {
    expect(RECOVERY_FIX_FAILURE_TTL_MS).toBeGreaterThanOrEqual(2 * RECOVERY_FIX_BACKOFF_MAX_MS);
    expect(RECOVERY_FIX_FAILURE_TTL_MS).toBeGreaterThanOrEqual(RECOVERY_TERMINAL_INTENT_TTL_MS);
  });

  test("dry-run deletes nothing; execute unlinks only stale fix failures", () => {
    const tNow = t0 + RECOVERY_FIX_FAILURE_TTL_MS + 1;
    recordFixFailure(orchDir, "OLD-1", "orphan_stale", "same", t0);
    recordFixFailure(orchDir, "NEW-1", "orphan_stale", "same", tNow);
    defaultRecordIntent("INTENT-1", { decision: "escalate" }, { orchDir, now: () => t0 });
    const intent = intentPath(orchDir, "INTENT-1");

    sweepStaleFixFailures({ orchDir, now: () => tNow, execute: false, quiet: true });
    expect(existsSync(fixPath("OLD-1"))).toBe(true);
    expect(existsSync(fixPath("NEW-1"))).toBe(true);
    expect(existsSync(intent)).toBe(true);

    const unlinked = [];
    const result = sweepStaleFixFailures({
      orchDir,
      now: () => tNow,
      execute: true,
      quiet: true,
      unlink: (path) => {
        unlinked.push(path);
        rmSync(path);
      },
    });
    expect(unlinked).toEqual([fixPath("OLD-1")]);
    expect(result.swept).toEqual(["OLD-1-orphan_stale.json"]);
    expect(existsSync(fixPath("OLD-1"))).toBe(false);
    expect(existsSync(fixPath("NEW-1"))).toBe(true);
    expect(existsSync(intent)).toBe(true);
  });

  // CAT-124 (Codex #3223 P2): --execute races the recovery daemon, which publishes
  // both backoff state (recordFixFailure) and comment-dedup state
  // (commitFixCommentHash) by atomic rename onto the very path being swept. The
  // scan/unlink window is real, so the delete must be conditional on the version
  // that was scanned — otherwise live state is destroyed and the ticket retries
  // immediately / re-posts a duplicate audit comment.
  describe("pre-delete revalidation (scan→unlink race)", () => {
    const tNow = () => t0 + RECOVERY_FIX_FAILURE_TTL_MS + 1;
    const TICKETS = ["RACEA-1", "RACEZ-1"];

    // The scan→unlink window only exists INSIDE sweepStaleFixFailures, so the race
    // has to be driven from a seam that fires there. Two equally-stale markers are
    // seeded; when the sweep unlinks whichever it reaches first, `duringSweep` runs
    // against the OTHER one — i.e. the daemon lands state mid-loop, exactly the
    // interleaving the finding describes. Written order-independently because
    // readdirSync order is not guaranteed.
    const sweepRacing = (duringSweep) => {
      for (const ticket of TICKETS) recordFixFailure(orchDir, ticket, "orphan_stale", "same", t0);
      expect(selectStaleFixFailures({ orchDir, now: tNow }).stale).toHaveLength(2);

      const unlinked = [];
      const result = sweepStaleFixFailures({
        orchDir,
        now: tNow,
        execute: true,
        quiet: true,
        unlink: (path) => {
          unlinked.push(path);
          rmSync(path);
          if (unlinked.length === 1) {
            duringSweep(TICKETS.find((t) => !path.includes(t.split("-")[0])));
          }
        },
      });
      const victim = TICKETS.find((t) => unlinked[0]?.includes(t.split("-")[0]));
      const raced = TICKETS.find((t) => t !== victim);
      return { unlinked, result, victim, raced };
    };

    test("keeps a marker whose backoff state was refreshed after the scan", () => {
      const { unlinked, result, victim, raced } = sweepRacing((ticket) =>
        recordFixFailure(orchDir, ticket, "orphan_stale", "same", tNow())
      );

      // The untouched marker is still swept; the refreshed one survives.
      expect(unlinked).toHaveLength(1);
      expect(result.swept).toEqual([`${victim}-orphan_stale.json`]);
      expect(result.skipped).toEqual([`${raced}-orphan_stale.json`]);
      expect(existsSync(fixPath(victim))).toBe(false);
      expect(existsSync(fixPath(raced))).toBe(true);
    });

    test("keeps a marker whose comment-dedup state was committed after the scan", () => {
      const { result, victim, raced } = sweepRacing((ticket) =>
        commitFixCommentHash(orchDir, ticket, "orphan_stale", fixCommentHash("body"), tNow())
      );

      expect(result.swept).toEqual([`${victim}-orphan_stale.json`]);
      expect(result.skipped).toEqual([`${raced}-orphan_stale.json`]);
      expect(existsSync(fixPath(raced))).toBe(true);
    });

    test("tolerates a marker deleted by someone else between scan and unlink", () => {
      const { unlinked, result, victim, raced } = sweepRacing((ticket) =>
        rmSync(fixPath(ticket))
      );

      // Only the first unlink runs — the vanished one is reported skipped, not thrown.
      expect(unlinked).toHaveLength(1);
      expect(result.swept).toEqual([`${victim}-orphan_stale.json`]);
      expect(result.skipped).toEqual([`${raced}-orphan_stale.json`]);
    });

    test("sweeps both when nothing races (revalidation is not a blanket refusal)", () => {
      const { unlinked, result } = sweepRacing(() => {});

      expect(unlinked).toHaveLength(2);
      expect(result.swept).toHaveLength(2);
      expect(result.skipped).toEqual([]);
      for (const ticket of TICKETS) expect(existsSync(fixPath(ticket))).toBe(false);
    });
  });
});
