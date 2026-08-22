// infra-class-backoff.test.mjs — CTL-2061 AC2/AC3/AC5.
//
// AC5: "Mutation control required, and one fixture per axis: an infra-class reason AND a
// genuine product-class reason. A suite with only one cannot tell routing from a
// constant." This file exercises the RETRY/WAIT/PAGE_STEWARD axis directly against the
// on-disk ledger (the same one recovery-fix-backoff.mjs already owns and is tested
// against), rather than mocking the decision away.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyInfraClassAction,
  buildStewardPageBody,
  clearInfraClassBackoff,
  decideInfraClassAction,
  INFRA_RETRY_ACTION,
  INFRA_RETRY_MAX_ATTEMPTS,
} from "./infra-class-backoff.mjs";
import { RECOVERY_FIX_BACKOFF_THRESHOLD, inFixBackoff } from "./recovery-fix-backoff.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl2061-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

const REASON = "sdk-overloaded-exhausted";
const T0 = 1_700_000_000_000;

describe("decideInfraClassAction", () => {
  test("a fresh ticket (no ledger row) decides RETRY", () => {
    const d = decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: T0 });
    expect(d.action).toBe(INFRA_RETRY_ACTION.RETRY);
    expect(d.count).toBe(0);
  });

  test("below RECOVERY_FIX_BACKOFF_THRESHOLD stays RETRY on every tick", () => {
    let now = T0;
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i++) {
      const d = decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
      expect(d.action).toBe(INFRA_RETRY_ACTION.RETRY);
      applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
      now += 1000;
    }
  });

  test("at/above threshold, inside the backoff window, decides WAIT", () => {
    let now = T0;
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i++) {
      applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
      now += 1000;
    }
    const d = decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
    expect(d.action).toBe(INFRA_RETRY_ACTION.WAIT);
    expect(d.until).toBeGreaterThan(now);
  });

  test("once the window elapses, decides RETRY again", () => {
    let now = T0;
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i++) {
      applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
      now += 1000;
    }
    const waiting = decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
    expect(waiting.action).toBe(INFRA_RETRY_ACTION.WAIT);
    const past = decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: waiting.until + 1 });
    expect(past.action).toBe(INFRA_RETRY_ACTION.RETRY);
  });

  // ── Axis: the bounded attempt budget (AC3) ──────────────────────────────────
  test("at INFRA_RETRY_MAX_ATTEMPTS recorded attempts, decides PAGE_STEWARD — never needs-human", () => {
    let now = T0;
    for (let i = 0; i < INFRA_RETRY_MAX_ATTEMPTS; i++) {
      const d = decideInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: now });
      // Force past every backoff window rather than waiting it out, so the loop reaches
      // the budget in a bounded number of iterations regardless of window growth.
      const effectiveNow = d.action === INFRA_RETRY_ACTION.WAIT ? d.until + 1 : now;
      applyInfraClassAction(orchDir, "CTC-790", REASON, {
        nowMs: effectiveNow,
        postComment: () => ({ posted: true }),
      });
      now = effectiveNow + 1000;
    }
    const exhausted = decideInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: now });
    expect(exhausted.action).toBe(INFRA_RETRY_ACTION.PAGE_STEWARD);
    expect(exhausted.count).toBeGreaterThanOrEqual(INFRA_RETRY_MAX_ATTEMPTS);
  });

  test("PAGE_STEWARD is sticky — it does not revert to RETRY on its own", () => {
    // Manually inflate the ledger past the budget via repeated RETRY applications, using
    // a fresh nowMs each time to always land outside any prior backoff window.
    let now = T0;
    for (let i = 0; i < INFRA_RETRY_MAX_ATTEMPTS + 2; i++) {
      const d = decideInfraClassAction(orchDir, "CTC-9", REASON, { nowMs: now });
      const effectiveNow = d.action === INFRA_RETRY_ACTION.WAIT ? d.until + 1 : now;
      if (d.action !== INFRA_RETRY_ACTION.PAGE_STEWARD) {
        applyInfraClassAction(orchDir, "CTC-9", REASON, {
          nowMs: effectiveNow,
          postComment: () => ({ posted: true }),
        });
      }
      now = effectiveNow + 1000;
    }
    const still = decideInfraClassAction(orchDir, "CTC-9", REASON, { nowMs: now + 999_999 });
    expect(still.action).toBe(INFRA_RETRY_ACTION.PAGE_STEWARD);
  });

  test("clearInfraClassBackoff resets the ledger to a fresh RETRY state", () => {
    applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: T0 });
    applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: T0 + 1 });
    expect(inFixBackoff(orchDir, "CTC-778", "infra-retry", T0 + 2).count).toBe(2);
    clearInfraClassBackoff(orchDir, "CTC-778");
    expect(inFixBackoff(orchDir, "CTC-778", "infra-retry", T0 + 3).count).toBe(0);
    expect(decideInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: T0 + 3 }).action).toBe(
      INFRA_RETRY_ACTION.RETRY
    );
  });
});

describe("applyInfraClassAction — the I/O half", () => {
  test("RETRY records an attempt in the ledger", () => {
    applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: T0 });
    expect(inFixBackoff(orchDir, "CTC-778", "infra-retry", T0 + 1).count).toBe(1);
  });

  test("WAIT does NOT record another attempt — the count stays put", () => {
    let now = T0;
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD; i++) {
      applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now });
      now += 1000;
    }
    const before = inFixBackoff(orchDir, "CTC-778", "infra-retry", now).count;
    applyInfraClassAction(orchDir, "CTC-778", REASON, { nowMs: now }); // should decide WAIT
    const after = inFixBackoff(orchDir, "CTC-778", "infra-retry", now).count;
    expect(after).toBe(before);
  });

  test("PAGE_STEWARD posts a comment exactly once, then dedupes on the next identical tick", () => {
    let now = T0;
    let posts = 0;
    const postComment = () => {
      posts++;
      return { posted: true };
    };
    for (let i = 0; i < INFRA_RETRY_MAX_ATTEMPTS; i++) {
      const d = decideInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: now });
      const effectiveNow = d.action === INFRA_RETRY_ACTION.WAIT ? d.until + 1 : now;
      applyInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: effectiveNow, postComment });
      now = effectiveNow + 1000;
    }
    expect(posts).toBe(0); // budget not yet exhausted during the ramp-up
    applyInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: now, postComment });
    expect(posts).toBe(1);
    // Same reason, same count -> same body -> dedup must suppress the repost.
    applyInfraClassAction(orchDir, "CTC-790", REASON, { nowMs: now + 1000, postComment });
    expect(posts).toBe(1);
  });

  test("never throws on a missing/empty orchDir (fail-safe, same discipline as inFixBackoff)", () => {
    expect(() => applyInfraClassAction(null, "CTC-1", REASON, { nowMs: T0 })).not.toThrow();
    expect(() => decideInfraClassAction(null, "CTC-1", REASON, { nowMs: T0 })).not.toThrow();
  });
});

describe("buildStewardPageBody", () => {
  test("names the instrument, the ticket, the reason and the count", () => {
    const body = buildStewardPageBody("CTC-790", REASON, 10);
    expect(body).toContain("instrument/infra-class-backoff");
    expect(body).toContain("CTC-790");
    expect(body).toContain(REASON);
    expect(body).toContain(String(10));
  });
});
