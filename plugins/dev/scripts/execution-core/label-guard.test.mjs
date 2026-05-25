// label-guard.test.mjs — labelOnce moved from scheduler (CTL-585) + the new
// escalation cool-down primitives (CTL-638). Run:
//   cd plugins/dev/scripts/execution-core && bun test label-guard.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labelOnce,
  inEscalationCooldown,
  recordEscalation,
  escalationCooldownPath,
  ESCALATION_COOLDOWN_MS,
} from "./label-guard.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "label-guard-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// recorder — minimal call-collecting fake; mirrors recovery.test.mjs convention.
function recorder(returnValue) {
  const fn = (...args) => {
    fn.calls.push(args);
    return returnValue;
  };
  fn.calls = [];
  return fn;
}

// ─── labelOnce (CTL-585 — moved from scheduler.mjs) ───

describe("labelOnce", () => {
  test("first call: applyLabel returns applied:true → writes .applied marker", () => {
    const ws = { applyLabel: recorder({ applied: true }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(ws.applyLabel.calls.length).toBe(1);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      true
    );
  });

  test("second call when .applied exists: short-circuits — applyLabel not called", () => {
    const ws = { applyLabel: recorder({ applied: true }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"), "");

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(ws.applyLabel.calls.length).toBe(0);
  });

  test("missing-label reason → writes .skipped marker (no retry within this run)", () => {
    const ws = { applyLabel: recorder({ applied: false, reason: "missing-label" }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"))).toBe(
      true
    );
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      false
    );
  });

  test("rate-limited (any non-applied, non-missing-label) → no marker, next tick retries", () => {
    const ws = { applyLabel: recorder({ applied: false, reason: "rate-limited" }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      false
    );
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"))).toBe(
      false
    );

    // Next call still attempts the write — by design.
    labelOnce(orchDir, "CTL-1", "needs-human", ws);
    expect(ws.applyLabel.calls.length).toBe(2);
  });

  test("applyLabel returning undefined (test stubs) → treated as success", () => {
    const ws = { applyLabel: () => undefined };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "triaged", ws);

    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-triaged.applied"))).toBe(
      true
    );
  });

  test("applyLabel throwing → swallowed (warn-only, no marker)", () => {
    const ws = {
      applyLabel: () => {
        throw new Error("network");
      },
    };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    expect(() => labelOnce(orchDir, "CTL-1", "needs-human", ws)).not.toThrow();
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      false
    );
  });
});

// ─── Escalation cool-down (CTL-638) ───

describe("inEscalationCooldown / recordEscalation", () => {
  test("inEscalationCooldown: no marker present → false", () => {
    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", 1_000_000)).toBe(false);
  });

  test("inEscalationCooldown: malformed JSON in marker → false (treated as absent)", () => {
    mkdirSync(join(orchDir, ".escalation-cooldowns"), { recursive: true });
    writeFileSync(escalationCooldownPath(orchDir, "CTL-9", "pr"), "not json");

    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", 1_000_000)).toBe(false);
  });

  test("inEscalationCooldown: marker present, missing escalatedAt → false", () => {
    mkdirSync(join(orchDir, ".escalation-cooldowns"), { recursive: true });
    writeFileSync(
      escalationCooldownPath(orchDir, "CTL-9", "pr"),
      JSON.stringify({ ticket: "CTL-9" })
    );

    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", 1_000_000)).toBe(false);
  });

  test("recordEscalation then inEscalationCooldown within window → true", () => {
    const t0 = 5_000_000;
    recordEscalation(orchDir, "CTL-9", "pr", "no-probe-for-phase", t0);

    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", t0)).toBe(true);
    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", t0 + ESCALATION_COOLDOWN_MS - 1)).toBe(
      true
    );
  });

  test("inEscalationCooldown returns false exactly at the window boundary", () => {
    const t0 = 5_000_000;
    recordEscalation(orchDir, "CTL-9", "pr", "no-probe-for-phase", t0);

    // Strictly less-than the window, so equal-to is already outside.
    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", t0 + ESCALATION_COOLDOWN_MS)).toBe(false);
  });

  test("recordEscalation creates the .escalation-cooldowns/ directory lazily", () => {
    expect(existsSync(join(orchDir, ".escalation-cooldowns"))).toBe(false);

    recordEscalation(orchDir, "CTL-9", "pr", "no-probe-for-phase", 1_000_000);

    expect(existsSync(join(orchDir, ".escalation-cooldowns"))).toBe(true);
    expect(existsSync(escalationCooldownPath(orchDir, "CTL-9", "pr"))).toBe(true);
  });

  test("recordEscalation persists ticket, phase, reason, escalatedAt for operator forensics", () => {
    recordEscalation(orchDir, "CTL-9", "monitor-merge", "revive-budget-exhausted", 9_876_543);

    const body = JSON.parse(
      Bun.file(escalationCooldownPath(orchDir, "CTL-9", "monitor-merge")).text
        ? require("node:fs").readFileSync(
            escalationCooldownPath(orchDir, "CTL-9", "monitor-merge"),
            "utf8"
          )
        : "{}"
    );
    expect(body).toEqual({
      ticket: "CTL-9",
      phase: "monitor-merge",
      reason: "revive-budget-exhausted",
      escalatedAt: 9_876_543,
    });
  });

  test("recordEscalation swallows mkdir/writeFile failures (warn-only, no throw)", () => {
    // Pass an orchDir under a path component that exists as a FILE — mkdirSync
    // will reject with ENOTDIR. The function must not throw.
    const f = join(orchDir, "not-a-dir");
    writeFileSync(f, "");

    expect(() => recordEscalation(f, "CTL-9", "pr", "any-reason", 1_000_000)).not.toThrow();
  });

  test("different (ticket, phase) pairs each get their own marker", () => {
    const t0 = 1_000_000;
    recordEscalation(orchDir, "CTL-9", "pr", "no-probe-for-phase", t0);
    recordEscalation(orchDir, "CTL-10", "pr", "no-probe-for-phase", t0);
    recordEscalation(orchDir, "CTL-9", "monitor-merge", "no-probe-for-phase", t0);

    expect(inEscalationCooldown(orchDir, "CTL-9", "pr", t0)).toBe(true);
    expect(inEscalationCooldown(orchDir, "CTL-10", "pr", t0)).toBe(true);
    expect(inEscalationCooldown(orchDir, "CTL-9", "monitor-merge", t0)).toBe(true);
    expect(inEscalationCooldown(orchDir, "CTL-11", "pr", t0)).toBe(false);
    expect(inEscalationCooldown(orchDir, "CTL-9", "triage", t0)).toBe(false);
  });
});
