// label-guard.test.mjs — labelOnce moved from scheduler (CTL-585) + the new
// escalation cool-down primitives (CTL-638). Run:
//   cd plugins/dev/scripts/execution-core && bun test label-guard.test.mjs

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labelOnce,
  clearStalledLabel,
  inEscalationCooldown,
  recordEscalation,
  readEscalationRecord,
  escalationCooldownPath,
  ESCALATION_COOLDOWN_MS,
  recordRemovalFailure,
  clearRemovalFailures,
  inRemovalBackoff,
  beliefOwnsNeedsHuman,
  labelNeedsHumanUnlessBeliefOwner,
  resolveAndApplyWorkerStatusLabel,
  WORKER_STATUS_LABELS,
} from "./label-guard.mjs";
import { validateExplanation } from "./escalation-explanation.mjs";
import { RETRYABLE_STALL_STATUS, TERMINAL_STALL_STATUS } from "./stall-class.mjs";
import { isTicketInFlight } from "./scheduler.mjs";

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

  test("CTL-962: returns true on the first application, false on a marker-guarded no-op", () => {
    const ws = { applyLabel: recorder({ applied: true }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    // First call performs the write → true (callers bound side-effects to this).
    expect(labelOnce(orchDir, "CTL-1", "needs-human", ws)).toBe(true);
    // Second call short-circuits on the .applied marker → false.
    expect(labelOnce(orchDir, "CTL-1", "needs-human", ws)).toBe(false);
    expect(ws.applyLabel.calls.length).toBe(1);
  });

  test("CTL-962: returns false on a no-op when a .skipped marker exists", () => {
    const ws = { applyLabel: recorder({ applied: true }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"), "");

    expect(labelOnce(orchDir, "CTL-1", "needs-human", ws)).toBe(false);
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

  test("CTL-834: exclusive-conflict reason → writes .skipped marker (no retry storm)", () => {
    const ws = { applyLabel: recorder({ applied: false, reason: "exclusive-conflict" }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"))).toBe(
      true
    );
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      false
    );
  });

  test("CTL-1085: team-mismatch reason → writes .skipped marker (storm-break preserved)", () => {
    const ws = { applyLabel: recorder({ applied: false, reason: "team-mismatch" }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"))).toBe(
      true
    );
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.applied"))).toBe(
      false
    );
  });

  test("transient reason → NO marker (retries next tick)", () => {
    const ws = { applyLabel: recorder({ applied: false, reason: "transient" }) };
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });

    labelOnce(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(orchDir, "workers", "CTL-1", ".linear-label-needs-human.skipped"))).toBe(
      false
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
      // CTL-1442: the ask-cap fields ride the same marker.
      askCount: 1,
      asks: [9_876_543],
    });
  });

  // ─── CTL-1442: consecutive-ask counting on the cool-down marker ───

  test("same-reason asks accrue askCount + a bounded ask history", () => {
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 1_000);
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 2_000);
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 3_000);
    const rec = readEscalationRecord(orchDir, "CTL-9", "pr");
    expect(rec.askCount).toBe(3);
    expect(rec.asks).toEqual([1_000, 2_000, 3_000]);
  });

  test("a DIFFERENT reason restarts the count (a new question, not a repeat)", () => {
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 1_000);
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 2_000);
    recordEscalation(orchDir, "CTL-9", "pr", "wedged-never-started", 3_000);
    const rec = readEscalationRecord(orchDir, "CTL-9", "pr");
    expect(rec.askCount).toBe(1);
    expect(rec.asks).toEqual([3_000]);
  });

  test("the ask history is bounded to the last 10 entries", () => {
    for (let i = 1; i <= 14; i++) {
      recordEscalation(orchDir, "CTL-9", "pr", "no-progress", i * 1_000);
    }
    const rec = readEscalationRecord(orchDir, "CTL-9", "pr");
    expect(rec.askCount).toBe(14);
    expect(rec.asks.length).toBe(10);
    expect(rec.asks[rec.asks.length - 1]).toBe(14_000);
  });

  test("readEscalationRecord: absent/malformed → null (fail-open)", () => {
    expect(readEscalationRecord(orchDir, "CTL-none", "pr")).toBeNull();
    mkdirSync(join(orchDir, ".escalation-cooldowns"), { recursive: true });
    writeFileSync(escalationCooldownPath(orchDir, "CTL-bad", "pr"), "not json");
    expect(readEscalationRecord(orchDir, "CTL-bad", "pr")).toBeNull();
  });

  test("a LEGACY marker (no askCount) counts as a fresh ask on the next record", () => {
    mkdirSync(join(orchDir, ".escalation-cooldowns"), { recursive: true });
    writeFileSync(
      escalationCooldownPath(orchDir, "CTL-9", "pr"),
      JSON.stringify({ ticket: "CTL-9", phase: "pr", reason: "no-progress", escalatedAt: 500 })
    );
    recordEscalation(orchDir, "CTL-9", "pr", "no-progress", 1_000);
    const rec = readEscalationRecord(orchDir, "CTL-9", "pr");
    expect(rec.askCount).toBe(1); // legacy marker had no count → restart at 1
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

// ─── clearStalledLabel (CTL-646) ───

describe("clearStalledLabel", () => {
  test("clears label + deletes .applied marker together", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    const removed = [];
    const ws = { removeLabel: (t, l) => { removed.push({ t, l }); return { removed: true }; } };

    clearStalledLabel(orchDir, "CTL-1", "needs-human", ws);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual({ t: "CTL-1", l: "needs-human" });
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });

  test("also deletes the .skipped marker", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.skipped"), "");
    const ws = { removeLabel: () => ({ removed: true }) };

    clearStalledLabel(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(workerDir, ".linear-label-needs-human.skipped"))).toBe(false);
  });

  test("no-op when no marker present — still calls removeLabel, does not throw", () => {
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    const removed = [];
    const ws = { removeLabel: (t, l) => { removed.push({ t, l }); return { removed: true }; } };

    expect(() => clearStalledLabel(orchDir, "CTL-1", "needs-human", ws)).not.toThrow();
    expect(removed).toHaveLength(1);
  });

  test("marker retained on failed removal (removed: false)", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    const ws = { removeLabel: () => ({ removed: false, reason: "transient" }) };

    clearStalledLabel(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);
  });

  test("never throws when removeLabel throws — marker kept", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    const ws = { removeLabel: () => { throw new Error("network"); } };

    expect(() => clearStalledLabel(orchDir, "CTL-1", "needs-human", ws)).not.toThrow();
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);
  });

  // CTL-639 verify: the async (Promise) branch is what the real Linearis
  // removeLabel actually returns — exercise it directly, not just the sync stub.
  test("async removeLabel resolving { removed: true } deletes the marker", async () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let resolveFn;
    const pending = new Promise((res) => { resolveFn = res; });
    const ws = { removeLabel: () => pending };

    clearStalledLabel(orchDir, "CTL-1", "needs-human", ws);
    // Marker still present until the promise settles.
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);

    resolveFn({ removed: true });
    await pending;
    await Promise.resolve(); // flush the .then(finalize) microtask

    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });

  test("async removeLabel rejecting does not throw and retains the marker", async () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let rejectFn;
    // Deferred so clearStalledLabel's .catch attaches before the rejection
    // fires — avoids a spurious unhandled-rejection flag.
    const pending = new Promise((_res, rej) => { rejectFn = rej; });
    const ws = { removeLabel: () => pending };

    expect(() => clearStalledLabel(orchDir, "CTL-1", "needs-human", ws)).not.toThrow();
    rejectFn(new Error("network"));
    await pending.catch(() => {}); // settle the rejection
    await Promise.resolve();

    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);
  });

  test("removeLabel returning undefined is treated as success — marker deleted", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    const ws = { removeLabel: () => undefined };

    clearStalledLabel(orchDir, "CTL-1", "needs-human", ws);

    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });

  test("apply → clear → re-apply cycle re-arms the labelOnce guard", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });

    // Apply
    labelOnce(orchDir, "CTL-1", "needs-human", { applyLabel: () => ({ applied: true }) });
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);

    // Clear
    clearStalledLabel(orchDir, "CTL-1", "needs-human", { removeLabel: () => ({ removed: true }) });
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);

    // Re-apply
    let applied = 0;
    labelOnce(orchDir, "CTL-1", "needs-human", { applyLabel: () => { applied++; return { applied: true }; } });
    expect(applied).toBe(1);
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);
  });
});

// ─── CTL-1045 Bug 4: clearStalledLabel onRemoved callback ───────────────────

describe("CTL-1045 Bug 4 — clearStalledLabel onRemoved callback", () => {
  test("onRemoved is invoked only when removal is confirmed (removed: true)", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let called = 0;

    clearStalledLabel(orchDir, "CTL-1", "needs-human", { removeLabel: () => ({ removed: true }) }, { onRemoved: () => { called++; } });
    expect(called).toBe(1);
  });

  test("onRemoved is withheld when removal is NOT confirmed (removed: false)", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let called = 0;

    clearStalledLabel(orchDir, "CTL-1", "needs-human", { removeLabel: () => ({ removed: false }) }, { onRemoved: () => { called++; } });
    expect(called).toBe(0);
  });

  test("onRemoved fires after an async removeLabel resolving removed:true", async () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let called = 0;

    clearStalledLabel(
      orchDir, "CTL-1", "needs-human",
      { removeLabel: () => Promise.resolve({ removed: true }) },
      { onRemoved: () => { called++; } },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(1);
  });

  test("a throwing onRemoved does not propagate — clearStalledLabel stays best-effort", () => {
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");

    // onRemoved throws — clearStalledLabel must not re-throw.
    expect(() =>
      clearStalledLabel(
        orchDir, "CTL-1", "needs-human",
        { removeLabel: () => ({ removed: true }) },
        { onRemoved: () => { throw new Error("disk full"); } },
      )
    ).not.toThrow();
    // The marker deletion still completed before onRemoved was called.
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });
});

// ─── CTL-936: labelOnce — operator-visible event on unrecoverable failure ────

describe("labelOnce CTL-936 operator-visible event", () => {
  test("emits intent.ineffective event on exclusive-conflict when enforce=1", () => {
    mkdirSync(join(orchDir, "workers", "CTL-936-A"), { recursive: true });
    const events = [];
    const appendEvent = (evt) => events.push(evt);
    const ws = { applyLabel: () => ({ applied: false, reason: "exclusive-conflict" }) };

    labelOnce(orchDir, "CTL-936-A", "needs-human", ws, {
      appendEvent,
      env: { CATALYST_INTENTS_ENFORCE: "1" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("intent.ineffective");
    expect(events[0].payload.kind).toBe("label");
    expect(events[0].payload.subject).toBe("CTL-936-A");
    expect(events[0].payload.postcondition.label).toBe("needs-human");
    expect(events[0].payload.reason).toBe("exclusive-conflict");
    // .skipped marker still written (retry storm still suppressed)
    expect(
      existsSync(join(orchDir, "workers", "CTL-936-A", ".linear-label-needs-human.skipped"))
    ).toBe(true);
  });

  test("does NOT emit event in shadow mode (enforce=0)", () => {
    mkdirSync(join(orchDir, "workers", "CTL-936-B"), { recursive: true });
    const events = [];
    const appendEvent = (evt) => events.push(evt);
    const ws = { applyLabel: () => ({ applied: false, reason: "exclusive-conflict" }) };

    labelOnce(orchDir, "CTL-936-B", "needs-human", ws, {
      appendEvent,
      env: { CATALYST_INTENTS_ENFORCE: "0" },
    });

    expect(events).toHaveLength(0);
  });

  test("does NOT emit event when appendEvent is absent (legacy callers)", () => {
    mkdirSync(join(orchDir, "workers", "CTL-936-C"), { recursive: true });
    const ws = { applyLabel: () => ({ applied: false, reason: "exclusive-conflict" }) };
    // Should not throw even without appendEvent
    expect(() => {
      labelOnce(orchDir, "CTL-936-C", "needs-human", ws, {
        env: { CATALYST_INTENTS_ENFORCE: "1" },
      });
    }).not.toThrow();
  });

  test("does NOT emit event for transient failures (only unrecoverable)", () => {
    mkdirSync(join(orchDir, "workers", "CTL-936-D"), { recursive: true });
    const events = [];
    const appendEvent = (evt) => events.push(evt);
    const ws = { applyLabel: () => ({ applied: false, reason: "rate-limited" }) };

    labelOnce(orchDir, "CTL-936-D", "needs-human", ws, {
      appendEvent,
      env: { CATALYST_INTENTS_ENFORCE: "1" },
    });

    expect(events).toHaveLength(0);
    // No .skipped marker for transient failures (retry next tick)
    expect(
      existsSync(join(orchDir, "workers", "CTL-936-D", ".linear-label-needs-human.skipped"))
    ).toBe(false);
  });
});

// ─── CTL-1078: remove-path failure counter + storm-break ─────────────────────

describe("recordRemovalFailure / clearRemovalFailures / inRemovalBackoff", () => {
  test("inRemovalBackoff is false when no marker exists", () => {
    expect(inRemovalBackoff(orchDir, "CTL-1", "needs-human", Date.now())).toBe(false);
  });

  test("recordRemovalFailure increments count and persists state", () => {
    mkdirSync(join(orchDir, ".removal-failures"), { recursive: true });
    const r1 = recordRemovalFailure(orchDir, "CTL-1", "needs-human", "transient", Date.now());
    expect(r1.count).toBe(1);
    const r2 = recordRemovalFailure(orchDir, "CTL-1", "needs-human", "transient", Date.now());
    expect(r2.count).toBe(2);
  });

  test("clearRemovalFailures resets counter and disarms backoff", () => {
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "transient", Date.now());
    clearRemovalFailures(orchDir, "CTL-1", "needs-human");
    expect(inRemovalBackoff(orchDir, "CTL-1", "needs-human", Date.now())).toBe(false);
    // recordRemovalFailure after clear starts from 1 again
    const r = recordRemovalFailure(orchDir, "CTL-1", "needs-human", "transient", Date.now());
    expect(r.count).toBe(1);
  });

  test("inRemovalBackoff is true within cooldown window after threshold reached", () => {
    const now = 1_000_000;
    // Simulate threshold failures having been recorded and backoff marker written
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    // Within the cooldown window → still in backoff
    expect(inRemovalBackoff(orchDir, "CTL-1", "needs-human", now + 1000)).toBe(true);
  });

  test("inRemovalBackoff is false after cooldown window expires", () => {
    const now = 1_000_000;
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    recordRemovalFailure(orchDir, "CTL-1", "needs-human", "auth-error", now);
    // After the cooldown window expires → no longer in backoff
    expect(inRemovalBackoff(orchDir, "CTL-1", "needs-human", now + ESCALATION_COOLDOWN_MS + 1)).toBe(false);
  });

  test("recordRemovalFailure swallows write errors (warn-only, no throw)", () => {
    // Pass a non-writable orchDir path — should not throw
    expect(() => recordRemovalFailure("/nonexistent/orchdir", "CTL-X", "lbl", "transient", Date.now())).not.toThrow();
  });
});

describe("clearStalledLabel — CTL-1078 storm-break", () => {
  function makeWorkerDir(ticket) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("storm-break: removeLabel not called after threshold consecutive failures within cooldown", () => {
    makeWorkerDir("CTL-S1");
    let calls = 0;
    const ws = {
      removeLabel: () => { calls++; return { removed: false, reason: "auth-error" }; },
    };
    const THRESHOLD = Number(process.env.REMOVAL_ESCALATION_THRESHOLD) || 3;
    const now = () => Date.now();
    // Drive to threshold
    for (let i = 0; i < THRESHOLD; i++) {
      clearStalledLabel(orchDir, "CTL-S1", "needs-human", ws, { now });
    }
    const callsAtThreshold = calls;
    // Additional ticks within cooldown — removeLabel should NOT be called again
    clearStalledLabel(orchDir, "CTL-S1", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S1", "needs-human", ws, { now });
    expect(calls).toBe(callsAtThreshold); // storm stopped
  });

  test("self-heal: two failures then success resets counter, no escalation", () => {
    makeWorkerDir("CTL-S2");
    let callCount = 0;
    const responses = [
      { removed: false, reason: "transient" },
      { removed: false, reason: "transient" },
      { removed: true },
    ];
    const ws = { removeLabel: () => { return responses[callCount++] ?? { removed: true }; } };
    const now = () => Date.now();
    clearStalledLabel(orchDir, "CTL-S2", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S2", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S2", "needs-human", ws, { now }); // success → counter reset
    // After clear, new failures start from zero
    const ws2 = { removeLabel: () => { calls2++; return { removed: false, reason: "transient" }; } };
    let calls2 = 0;
    clearStalledLabel(orchDir, "CTL-S2", "needs-human", ws2, { now });
    expect(calls2).toBe(1); // fresh start — not immediately backed off
  });

  test("counter resets after success, subsequent failures start fresh", () => {
    makeWorkerDir("CTL-S3");
    const THRESHOLD = Number(process.env.REMOVAL_ESCALATION_THRESHOLD) || 3;
    let phase = "fail";
    let failCalls = 0;
    const ws = {
      removeLabel: () => {
        if (phase === "fail") { failCalls++; return { removed: false, reason: "transient" }; }
        return { removed: true };
      },
    };
    const now = () => Date.now();
    // Two failures then success
    clearStalledLabel(orchDir, "CTL-S3", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S3", "needs-human", ws, { now });
    phase = "succeed";
    clearStalledLabel(orchDir, "CTL-S3", "needs-human", ws, { now });
    // Now re-fail — count starts at 1 not 2 (the prior two were reset)
    phase = "fail";
    failCalls = 0;
    for (let i = 0; i < THRESHOLD - 1; i++) {
      clearStalledLabel(orchDir, "CTL-S3", "needs-human", ws, { now });
    }
    // Haven't reached threshold yet — still calling removeLabel
    expect(failCalls).toBe(THRESHOLD - 1);
  });

  test("transient tolerated under threshold: two failures then success → no storm-break", () => {
    makeWorkerDir("CTL-S4");
    const workerDir = join(orchDir, "workers", "CTL-S4");
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    let calls = 0;
    const responses = [
      { removed: false, reason: "transient" },
      { removed: false, reason: "transient" },
      { removed: true },
    ];
    const ws = { removeLabel: () => responses[calls++] ?? { removed: true } };
    const now = () => Date.now();
    clearStalledLabel(orchDir, "CTL-S4", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S4", "needs-human", ws, { now });
    clearStalledLabel(orchDir, "CTL-S4", "needs-human", ws, { now });
    expect(calls).toBe(3); // all three calls went through — marker cleared on 3rd
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });

  test("never throws even if counter-file write errors (fail-open)", () => {
    makeWorkerDir("CTL-S5");
    // orchDir points to a file, not dir — writing .removal-failures/ inside it fails
    const badOrchDir = join(orchDir, "workers", "CTL-S5", ".linear-label-needs-human.applied");
    writeFileSync(badOrchDir, ""); // this is a FILE, not a dir
    const ws = { removeLabel: () => ({ removed: false, reason: "transient" }) };
    expect(() => clearStalledLabel(badOrchDir, "CTL-S5", "needs-human", ws, { now: () => Date.now() })).not.toThrow();
  });
});

// ─── CTL-1241: beliefOwnsNeedsHuman + labelNeedsHumanUnlessBeliefOwner ────────
describe("beliefOwnsNeedsHuman (CTL-1241)", () => {
  test("returns true when CATALYST_INTENTS_ENFORCE=1", () => {
    expect(beliefOwnsNeedsHuman({ CATALYST_INTENTS_ENFORCE: "1" })).toBe(true);
  });

  test("returns false when CATALYST_INTENTS_ENFORCE is unset", () => {
    expect(beliefOwnsNeedsHuman({})).toBe(false);
  });

  test("returns false when CATALYST_INTENTS_ENFORCE=0", () => {
    expect(beliefOwnsNeedsHuman({ CATALYST_INTENTS_ENFORCE: "0" })).toBe(false);
  });

  test("returns false for any non-'1' value", () => {
    expect(beliefOwnsNeedsHuman({ CATALYST_INTENTS_ENFORCE: "true" })).toBe(false);
    expect(beliefOwnsNeedsHuman({ CATALYST_INTENTS_ENFORCE: "" })).toBe(false);
  });

  test("defaults to process.env when env is omitted", () => {
    const prev = process.env.CATALYST_INTENTS_ENFORCE;
    process.env.CATALYST_INTENTS_ENFORCE = "1";
    try {
      expect(beliefOwnsNeedsHuman()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_INTENTS_ENFORCE;
      else process.env.CATALYST_INTENTS_ENFORCE = prev;
    }
  });
});

describe("labelNeedsHumanUnlessBeliefOwner (CTL-1241)", () => {
  function makeWS() {
    const calls = [];
    return {
      applyLabel: (args) => { calls.push(args); return { applied: true }; },
      calls,
    };
  }

  // ⛔ CTL-2159: this used to assert `ws.calls[0]` was
  // `{ ticket, label: "needs-human" }`. The chokepoint no longer writes a Linear
  // label at all — it publishes through the CTL-2158 classifier. The surviving
  // property is: enforcement OFF still PUBLISHES (no deferral log), and nothing
  // reaches the Linear write seam.
  test("with enforcement OFF: publishes, and writes NO Linear label", () => {
    const ws = makeWS();
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    const deferred = [];
    const published = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-1", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
      site: "test-site",
      log: { info: (obj) => deferred.push(obj) },
    });
    expect(ws.calls.length).toBe(0);
    expect(published).toBe(true);
    expect(deferred.length).toBe(0);
    // POSITIVE CONTROL: the same seam DOES record a call when one is made, so the
    // zero above is a real absence and not an unwired spy.
    ws.applyLabel({ ticket: "CTL-1", label: "queued" });
    expect(ws.calls.length).toBe(1);
  });

  test("with enforcement ON: does NOT call labelOnce, records deferral", () => {
    const ws = makeWS();
    const deferred = [];
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-2", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "1" },
      site: "test-site",
      log: { info: (obj, _msg) => deferred.push(obj) },
    });
    expect(ws.calls.length).toBe(0); // no labelOnce call
    expect(deferred.length).toBe(1);
    expect(deferred[0]).toMatchObject({ ticket: "CTL-2", site: "test-site" });
  });

  test("with enforcement unset: publishes (default OFF), still no Linear label", () => {
    const ws = makeWS();
    mkdirSync(join(orchDir, "workers", "CTL-3"), { recursive: true });
    const published = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-3", ws, {
      env: { CATALYST_ESCALATION_ASK: "off" },
      site: "test-site",
      log: { info: () => {} },
    });
    expect(published).toBe(true);
    expect(ws.calls.length).toBe(0); // CTL-2159
  });

  // CTL-764 finding 8: the return value gates the caller's worker.transition emission
  // — a fresh apply is `true`; a no-op (persisted marker / belief deferral) is `false`.
  test("CTL-764 finding 8 — returns true on a fresh apply (a label write happened)", () => {
    const ws = makeWS();
    mkdirSync(join(orchDir, "workers", "CTL-8A"), { recursive: true });
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-8A", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      log: { info: () => {} },
    });
    expect(wrote).toBe(true);
  });

  test("CTL-764 finding 8 — returns false on a persisted marker (labelOnce no-op after restart)", () => {
    const ws = makeWS();
    const dir = join(orchDir, "workers", "CTL-8B");
    mkdirSync(dir, { recursive: true });
    // A needs-human already applied this lifetime — the once-marker persists on disk.
    writeFileSync(join(dir, ".linear-label-needs-human.applied"), "");
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-8B", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      log: { info: () => {} },
    });
    expect(wrote).toBe(false);
    expect(ws.calls.length).toBe(0); // labelOnce short-circuited on the marker — no write
  });

  test("CTL-764 finding 8 — returns false when deferring to the belief owner", () => {
    const ws = makeWS();
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-8C", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "1" },
      log: { info: () => {} },
    });
    expect(wrote).toBe(false);
  });

  // CTL-764 finding C: the return must reflect a CONFIRMED apply, not a bare first
  // attempt. labelOnce returns true for any first write attempt — including outcomes
  // where applyLabel reported applied:false — so gating a worker.transition on the raw
  // labelOnce boolean records a needs-human escalation that never actually landed.
  // ⛔ CTL-2159: finding C's rate-limited case no longer EXISTS as written. It
  // asserted that a Linear 429 on the label write made the return false; there is
  // no label write to rate-limit. The property that replaces it is stronger: the
  // publish verdict is decided by the CLASS, so a Linear write seam that would
  // have failed is never even consulted — one fewer shared-quota call per stall.
  test("CTL-2159 — a would-be-failing Linear seam is never consulted", () => {
    const calls = [];
    const ws = {
      applyLabel: (args) => {
        calls.push(args);
        return { applied: false, reason: "rate-limited" };
      },
    };
    mkdirSync(join(orchDir, "workers", "CTL-C1"), { recursive: true });
    const published = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-C1", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
      log: { info: () => {} },
    });
    expect(calls.length).toBe(0);
    expect(published).toBe(true);
  });

  // ⛔ CTL-2159: the exclusive-conflict case is gone with the label — the
  // `worker-status` group can no longer conflict on a member that is not applied.
  // `.skipped` survives for the ONE remaining terminal failure (an ask that can
  // never land); that case is pinned in escalation-publish.test.mjs.
  test("CTL-2159 — an exclusive-conflict seam no longer writes .skipped (nothing conflicts)", () => {
    const ws = { applyLabel: () => ({ applied: false, reason: "exclusive-conflict" }) };
    mkdirSync(join(orchDir, "workers", "CTL-C2"), { recursive: true });
    const published = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-C2", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
      log: { info: () => {} },
    });
    expect(published).toBe(true);
    expect(
      existsSync(join(orchDir, "workers", "CTL-C2", ".linear-label-needs-human.skipped"))
    ).toBe(false);
    // POSITIVE CONTROL: the publish DID leave its once-marker, so the assertion
    // above is about `.skipped` specifically, not about nothing having happened.
    expect(
      existsSync(join(orchDir, "workers", "CTL-C2", ".linear-label-needs-human.applied"))
    ).toBe(true);
  });

  test("finding C — returns true ONLY on a confirmed applied:true", () => {
    const ws = { applyLabel: () => ({ applied: true }) };
    mkdirSync(join(orchDir, "workers", "CTL-C3"), { recursive: true });
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-C3", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      log: { info: () => {} },
    });
    expect(wrote).toBe(true);
  });
});

// ─── CTL-1605: terminal-aware worker-status chokepoint ───

describe("resolveAndApplyWorkerStatusLabel", () => {
  test("WORKER_STATUS_LABELS is the frozen group source-of-truth", () => {
    expect(Object.isFrozen(WORKER_STATUS_LABELS)).toBe(true);
    expect(new Set(WORKER_STATUS_LABELS)).toEqual(
      new Set(["needs-human", "needs-input", "blocked", "queued", "waiting"])
    );
  });

  test("terminal → clears every present label, evicts, no apply", () => {
    const removed = [];
    const evicted = [];
    const applyDesired = mock(() => {});
    const writeStatus = {
      removeLabel: (t, l) => {
        removed.push(l);
        return { removed: true };
      },
      applyLabel: mock(() => {}),
    };
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-9", {
      desired: "blocked",
      currentLabels: ["blocked", "needs-human"],
      isTerminal: () => ({ terminal: true, reason: "linear-terminal", state: "Done" }),
      writeStatus,
      evictWorkerDir: (t) => {
        evicted.push(t);
        return true;
      },
      applyDesired,
    });
    expect(res).toMatchObject({ terminal: true, evicted: true });
    expect(new Set(removed)).toEqual(new Set(["blocked", "needs-human"]));
    expect(applyDesired).not.toHaveBeenCalled();
    expect(evicted).toEqual(["CTL-9"]);
    expect(writeStatus.applyLabel).not.toHaveBeenCalled();
  });

  test("non-terminal → invokes applyDesired, no clear, no evict", () => {
    const applyDesired = mock(() => {});
    const evict = mock(() => true);
    const writeStatus = {
      removeLabel: mock(() => ({ removed: true })),
      applyLabel: mock(() => {}),
    };
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-10", {
      desired: "blocked",
      currentLabels: [],
      isTerminal: () => ({ terminal: false }),
      writeStatus,
      evictWorkerDir: evict,
      applyDesired,
    });
    expect(res).toMatchObject({ terminal: false });
    expect(applyDesired).toHaveBeenCalledTimes(1);
    expect(evict).not.toHaveBeenCalled();
    expect(writeStatus.removeLabel).not.toHaveBeenCalled();
  });

  test("terminal but no worker-status label present → evicts, zero removeLabel", () => {
    const writeStatus = {
      removeLabel: mock(() => ({ removed: true })),
      applyLabel: mock(() => {}),
    };
    const evict = mock(() => true);
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-11", {
      desired: null,
      currentLabels: ["some-unrelated-label"],
      isTerminal: () => ({ terminal: true, state: "Canceled" }),
      writeStatus,
      evictWorkerDir: evict,
      applyDesired: mock(() => {}),
    });
    expect(res.terminal).toBe(true);
    expect(writeStatus.removeLabel).not.toHaveBeenCalled();
    expect(evict).toHaveBeenCalledTimes(1);
  });

  test("isTerminal throws → fail-safe NOT-terminal, applyDesired runs", () => {
    const applyDesired = mock(() => {});
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-12", {
      desired: "queued",
      currentLabels: [],
      isTerminal: () => {
        throw new Error("linear 400");
      },
      writeStatus: { removeLabel: mock(() => ({ removed: true })), applyLabel: mock(() => {}) },
      evictWorkerDir: mock(() => true),
      applyDesired,
    });
    expect(res.terminal).toBe(false);
    expect(applyDesired).toHaveBeenCalledTimes(1);
  });

  // ─── CTL-1605 Codex thread (scheduler.mjs:5518) — onTerminalCleared now fires
  // EXACTLY ONCE per call with the AGGREGATE outcome across every present
  // worker-status label, never once per label. The old per-label firing let a
  // single confirmed removal on a multi-label ticket report a clear even when a
  // sibling label (e.g. the sticky needs-human) never confirmed removal. ───

  test("terminal clear, all present labels confirm → onTerminalCleared fires ONCE with null", () => {
    const cleared = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-13", {
      desired: null,
      currentLabels: ["queued", "needs-human"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: { removeLabel: () => ({ removed: true }), applyLabel: mock(() => {}) },
      evictWorkerDir: () => true,
      onTerminalCleared: (arg) => cleared.push(arg),
      applyDesired: mock(() => {}),
    });
    expect(cleared).toEqual([null]);
  });

  test("single label confirmed → onTerminalCleared fires ONCE with null (backward compat)", () => {
    const cleared = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-13b", {
      desired: null,
      currentLabels: ["queued"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: { removeLabel: () => ({ removed: true }), applyLabel: mock(() => {}) },
      evictWorkerDir: () => true,
      onTerminalCleared: (arg) => cleared.push(arg),
      applyDesired: mock(() => {}),
    });
    expect(cleared).toEqual([null]);
  });

  test("async removeLabel resolving removed:true → onTerminalCleared fires once on resolve, not eagerly", async () => {
    const cleared = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-14", {
      desired: null,
      currentLabels: ["blocked"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: () => Promise.resolve({ removed: true }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: () => true,
      onTerminalCleared: (arg) => cleared.push(arg),
      applyDesired: mock(() => {}),
    });
    // NOT fired synchronously off the Promise object.
    expect(cleared).toEqual([]);
    // Extra hop vs the pre-fix version: the aggregate fire now runs off
    // Promise.all(outcomes).then(...), one microtask hop past the per-label settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toEqual([null]);
  });

  test("async removeLabel resolving removed:false → onTerminalCleared fires once with the surviving label, never null", async () => {
    const cleared = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-15", {
      desired: null,
      currentLabels: ["blocked"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: () => Promise.resolve({ removed: false, reason: "rate-limited" }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: () => true,
      onTerminalCleared: (arg) => cleared.push(arg),
      applyDesired: mock(() => {}),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toEqual(["blocked"]);
  });

  test("multi-label ticket, needs-human backoff-skipped + blocked confirmed → onTerminalCleared fires ONCE with \"needs-human\", never null", () => {
    const workerDir = join(orchDir, "workers", "CTL-13c");
    mkdirSync(workerDir, { recursive: true });
    const now = 5_000_000;
    const THRESHOLD = Number(process.env.REMOVAL_ESCALATION_THRESHOLD) || 3;
    for (let i = 0; i < THRESHOLD; i++) {
      recordRemovalFailure(orchDir, "CTL-13c", "needs-human", "auth-error", now);
    }
    const cleared = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-13c", {
      desired: null,
      // DISPOSITIONS precedence order is needs-human, needs-input, blocked, queued —
      // "blocked" outranks "needs-human" numerically LOWER index wins (needs-human is
      // index 0, the highest precedence), so with needs-human surviving it must win
      // over blocked as the reported survivor regardless of iteration order.
      currentLabels: ["blocked", "needs-human"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: (t, l) => (l === "blocked" ? { removed: true } : { removed: true }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: () => true,
      onTerminalCleared: (arg) => cleared.push(arg),
      applyDesired: mock(() => {}),
      now: () => now,
    });
    // needs-human is in CTL-1078 backoff → its removal is skipped (unconfirmed);
    // blocked confirms. Aggregate must report the surviving "needs-human", never null.
    expect(cleared).toEqual(["needs-human"]);
  });

  // ─── CTL-1605 review finding (label-guard.mjs:519) — eviction gated on
  // CONFIRMED removal of every present label, not merely on the removals being
  // ISSUED. Retry-loss: STEP A / J3 / J4 all key their candidate sets off
  // workers/<T>/ existing on disk — evicting on an unconfirmed/failed removal
  // destroys the only retry record and strands the stale Linear label forever. ───

  test("async removals ALL confirmed → evict is DEFERRED past the call (not synchronous) then fires once settled", async () => {
    let resolveBlocked, resolveQueued;
    const evicted = [];
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-16", {
      desired: null,
      currentLabels: ["blocked", "queued"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: (t, l) =>
          l === "blocked"
            ? new Promise((r) => { resolveBlocked = r; })
            : new Promise((r) => { resolveQueued = r; }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: (t) => { evicted.push(t); return true; },
      applyDesired: mock(() => {}),
    });
    // Not every present label settled synchronously → evict cannot be decided yet.
    expect(res.evicted).toBe(false);
    expect(evicted).toEqual([]);
    resolveBlocked({ removed: true });
    resolveQueued({ removed: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Only NOW — once every present label's removal is CONFIRMED — does eviction fire.
    expect(evicted).toEqual(["CTL-16"]);
  });

  test("async removals where ONE fails (removed:false) → evict NEVER fires, even after all settle", async () => {
    const evicted = [];
    resolveAndApplyWorkerStatusLabel(orchDir, "CTL-17", {
      desired: null,
      currentLabels: ["blocked", "queued"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: (t, l) =>
          l === "blocked"
            ? Promise.resolve({ removed: true })
            : Promise.resolve({ removed: false, reason: "rate-limited" }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: (t) => { evicted.push(t); return true; },
      applyDesired: mock(() => {}),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // One label never confirmed removed → the worker dir stays (the only retry
    // record for the still-attached label) instead of being evicted underneath it.
    expect(evicted).toEqual([]);
  });

  test("sync removals where ONE fails (removed:false) → evict withheld synchronously (evicted:false)", () => {
    const evicted = [];
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-18", {
      desired: null,
      currentLabels: ["blocked", "queued"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: (t, l) => (l === "blocked" ? { removed: true } : { removed: false, reason: "transient" }),
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: (t) => { evicted.push(t); return true; },
      applyDesired: mock(() => {}),
    });
    expect(res.evicted).toBe(false);
    expect(evicted).toEqual([]);
  });

  test("needs-human in CTL-1078 backoff (unconfirmed) → evict withheld even though the removal was never even attempted", () => {
    const workerDir = join(orchDir, "workers", "CTL-19");
    mkdirSync(workerDir, { recursive: true });
    const now = 5_000_000;
    // Drive clearStalledLabel's removal-failure counter to the backoff threshold.
    const THRESHOLD = Number(process.env.REMOVAL_ESCALATION_THRESHOLD) || 3;
    for (let i = 0; i < THRESHOLD; i++) {
      recordRemovalFailure(orchDir, "CTL-19", "needs-human", "auth-error", now);
    }
    const evicted = [];
    let removeLabelCalls = 0;
    const res = resolveAndApplyWorkerStatusLabel(orchDir, "CTL-19", {
      desired: null,
      currentLabels: ["needs-human"],
      isTerminal: () => ({ terminal: true, state: "Done" }),
      writeStatus: {
        removeLabel: () => { removeLabelCalls++; return { removed: true }; },
        applyLabel: mock(() => {}),
      },
      evictWorkerDir: (t) => { evicted.push(t); return true; },
      applyDesired: mock(() => {}),
      now: () => now,
    });
    // Backoff short-circuits BEFORE removeLabel is ever called (CTL-1078 storm-break).
    expect(removeLabelCalls).toBe(0);
    // A backoff-skip is not a confirmed removal → evict must stay withheld.
    expect(res.evicted).toBe(false);
    expect(evicted).toEqual([]);
  });
});

// ─── CTL-1609: explanation-required label chokepoint (Phase 1, Gap 2) ────────

describe("labelNeedsHumanUnlessBeliefOwner — explanation threading (CTL-1609)", () => {
  const RECOVERY_PASS_SIG = (orchDir, ticket) =>
    join(orchDir, "workers", ticket, "phase-recovery-pass.json");

  function makeAppliedWS() {
    return { applyLabel: () => ({ applied: true }) };
  }
  function makeRateLimitedWS() {
    return { applyLabel: () => ({ applied: false, reason: "rate-limited" }) };
  }

  test("explanation coerced and written on confirmed apply", () => {
    const workerDir = join(orchDir, "workers", "CTL-E1");
    mkdirSync(workerDir, { recursive: true });
    const warns = [];
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E1", makeAppliedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      site: "dispatch-failures",
      log: { info: () => {}, warn: (obj) => warns.push(obj) },
      explanation: {
        problem: "dispatch failed 8×",
        call_to_action: "authorize retry of CTL-E1 or cancel",
      },
    });
    expect(wrote).toBe(true);
    const sig = JSON.parse(readFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E1"), "utf8"));
    // ⛔ CTL-2159: was `status:"needs-human"` — the last writer of that value.
    // CTL-1552 already normalized every other escalation to `stalled`; this one
    // now agrees, and carries the CTL-2158 class as the durable verdict.
    expect(sig.status).toBe("stalled");
    expect(typeof sig.stallClass).toBe("string");
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(sig.explanation.call_to_action).toBe("authorize retry of CTL-E1 or cancel");
    // No absent-warn because explanation was supplied
    expect(warns.some((w) => w.event === "escalation.explanation-absent")).toBe(false);
  });

  // ⛔ CTL-2159 — THE HEADLINE INVERSION. This test used to REQUIRE the degrade:
  // "no explanation supplied → degraded coerce … signal still written", i.e. it
  // pinned the manufacture of a human decision out of nothing. That template
  // ("priority call the agent cannot make unilaterally") is what turned ONE
  // provider outage into 37 separate per-ticket decisions. The property is now
  // its exact opposite: an unexplained stall gets NO explanation at all, and the
  // class is what is recorded instead.
  test("⛔ no explanation supplied → NOTHING is manufactured; the class is recorded", () => {
    const workerDir = join(orchDir, "workers", "CTL-E2");
    mkdirSync(workerDir, { recursive: true });
    const warns = [];
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E2", makeAppliedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
      site: "terminal-sweep",
      log: { info: () => {}, warn: (obj) => warns.push(obj) },
      // no explanation
    });
    expect(wrote).toBe(true);
    const sig = JSON.parse(readFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E2"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.explanation).toBeUndefined();
    // POSITIVE CONTROL: the signal WAS written — the absent explanation above is a
    // deliberate absence, not a write that silently failed.
    expect(sig.stallClass).toBeTruthy();
  });

  // ⛔ CTL-2159: a rate-limited LABEL write no longer exists, so this scenario is
  // re-pointed at the surviving one — a Linear seam that would fail is never
  // consulted, and the publish lands anyway. That is the point: a shared-quota
  // 429 can no longer decide whether a stalled ticket is recorded.
  test("CTL-2159 — a rate-limited Linear seam neither blocks nor is called", () => {
    const workerDir = join(orchDir, "workers", "CTL-E3");
    mkdirSync(workerDir, { recursive: true });
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E3", makeRateLimitedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
      site: "dispatch-failures",
      log: { info: () => {}, warn: () => {} },
      explanation: { problem: "failed", call_to_action: "retry CTL-E3 or cancel" },
    });
    expect(wrote).toBe(true);
    expect(existsSync(RECOVERY_PASS_SIG(orchDir, "CTL-E3"))).toBe(true);
  });

  test("belief-owner deferral (CATALYST_INTENTS_ENFORCE=1) writes nothing", () => {
    const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E4", makeAppliedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "1" },
      site: "terminal-sweep",
      log: { info: () => {}, warn: () => {} },
      explanation: { problem: "stuck", call_to_action: "retry CTL-E4 or close it" },
    });
    expect(wrote).toBe(false);
    expect(existsSync(RECOVERY_PASS_SIG(orchDir, "CTL-E4"))).toBe(false);
  });

  test("invalid/garbage explanation never throws — coerced object still written", () => {
    const workerDir = join(orchDir, "workers", "CTL-E5");
    mkdirSync(workerDir, { recursive: true });
    expect(() =>
      labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E5", makeAppliedWS(), {
        env: { CATALYST_INTENTS_ENFORCE: "0" },
        site: "dispatch-failures",
        log: { info: () => {}, warn: () => {} },
        explanation: { problem: 123 }, // garbage type
      })
    ).not.toThrow();
    const sig = JSON.parse(readFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E5"), "utf8"));
    expect(sig.status).toBe("stalled"); // CTL-2159
    // The garbage explanation is passed through verbatim rather than coerced into
    // a manufactured decision — CTL-2159 removed the coerce from this path.
    expect(sig.explanation).toBeTruthy();
  });

  test("no-overwrite guard: richer pre-existing explanation is preserved", () => {
    const workerDir = join(orchDir, "workers", "CTL-E6");
    mkdirSync(workerDir, { recursive: true });
    // Write a rich (non-degraded) explanation already on disk
    const richSig = {
      ticket: "CTL-E6",
      status: "needs-human",
      needsHumanSince: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      phase: "recovery-pass",
      explanation: {
        escalation_type: "authorization",
        problem: "recovery attempts exhausted (rich signal)",
        call_to_action: "authorize another recovery cycle for CTL-E6",
        recommendation: "inspect the last recovery-pass session",
        risk: "ticket rots silently without action",
        why_asking: "risk-authority gate",
        could_higher_tier_resolve: false,
        authorize_label: "retry CTL-E6",
      },
    };
    writeFileSync(
      RECOVERY_PASS_SIG(orchDir, "CTL-E6"),
      JSON.stringify(richSig)
    );
    // Now call the chokepoint with a thin explanation — should not overwrite
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E6", makeAppliedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      site: "attempts-exhausted",
      log: { info: () => {}, warn: () => {} },
      explanation: { human_question: "see recovery-pass escalation brief" },
    });
    const sig = JSON.parse(readFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E6"), "utf8"));
    // Rich explanation preserved — call_to_action unchanged
    expect(sig.explanation.call_to_action).toBe("authorize another recovery cycle for CTL-E6");
    expect(sig.explanation.degraded).toBeUndefined();
  });

  test("no-overwrite guard: degraded prior IS overwritten by richer explanation", () => {
    const workerDir = join(orchDir, "workers", "CTL-E7");
    mkdirSync(workerDir, { recursive: true });
    // Write a degraded signal (the prior call had no explanation)
    const degradedSig = {
      ticket: "CTL-E7",
      status: "needs-human",
      needsHumanSince: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      phase: "recovery-pass",
      explanation: { escalation_type: "authorization", degraded: true },
    };
    writeFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E7"), JSON.stringify(degradedSig));
    // Call chokepoint with a richer, non-degraded explanation — SHOULD overwrite
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-E7", makeAppliedWS(), {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      site: "dispatch-failures",
      log: { info: () => {}, warn: () => {} },
      explanation: {
        problem: "richer replacement for CTL-E7",
        call_to_action: "resolve the dispatch failure for CTL-E7",
      },
    });
    const sig = JSON.parse(readFileSync(RECOVERY_PASS_SIG(orchDir, "CTL-E7"), "utf8"));
    // Guard allowed the overwrite — new problem/call_to_action from the second call are present.
    // coerceExplanation always sets degraded:true, so the written signal is still degraded,
    // but the content is the richer one (proving the guard did NOT block the write).
    expect(sig.explanation.problem).toBe("richer replacement for CTL-E7");
    expect(sig.explanation.call_to_action).toBe("resolve the dispatch failure for CTL-E7");
  });
});

// ─── CTL-1609 (Codex P1): live recovery-pass worker guard ─────────────────────
//
// phase-recovery-pass.json is not only an explanation carrier — it is the
// recovery-pass worker's own status record, and `dispatched`/`running` is exactly
// what the liveness probes read (delegate-queue's recoveryPassWorkerLive, the SDK
// occupancy accounting). Stamping `needs-human` over a live worker makes it
// invisible: it stops deduping a re-enqueue (double-dispatch) and drops out of
// capacity accounting. Reachable in normal operation — a sibling phase can fail
// while the recovery-pass worker is still running.
describe("labelNeedsHumanUnlessBeliefOwner — live recovery-pass worker guard (CTL-1609)", () => {
  const SIG = (ticket) => join(orchDir, "workers", ticket, "phase-recovery-pass.json");

  function seedSignal(ticket, status) {
    const workerDir = join(orchDir, "workers", ticket);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      SIG(ticket),
      JSON.stringify({ ticket, status, phase: "recovery-pass", bg_job_id: "job-live-1" })
    );
  }

  function applyWith(ticket) {
    return labelNeedsHumanUnlessBeliefOwner(
      orchDir,
      ticket,
      { applyLabel: () => ({ applied: true }) },
      {
        env: { CATALYST_INTENTS_ENFORCE: "0" },
        site: "terminal-sweep",
        log: { info: () => {}, warn: () => {} },
        explanation: { problem: "sibling phase failed", call_to_action: "review" },
      }
    );
  }

  for (const status of ["dispatched", "running"]) {
    test(`does NOT overwrite a live '${status}' recovery-pass signal`, () => {
      seedSignal(`CTL-LW-${status}`, status);
      const wrote = applyWith(`CTL-LW-${status}`);

      // The label itself still applies — only the signal-file mutation is skipped.
      expect(wrote).toBe(true);
      const sig = JSON.parse(readFileSync(SIG(`CTL-LW-${status}`), "utf8"));
      expect(sig.status).toBe(status); // live worker's record preserved verbatim
      expect(sig.bg_job_id).toBe("job-live-1");
      expect(sig.explanation).toBeUndefined();
    });
  }

  test("still writes when the prior signal is a terminal/non-live status", () => {
    seedSignal("CTL-LW-done", "done");
    const wrote = applyWith("CTL-LW-done");

    expect(wrote).toBe(true);
    const sig = JSON.parse(readFileSync(SIG("CTL-LW-done"), "utf8"));
    // ⛔ CTL-2159: the prior status is PRESERVED (was clobbered to "needs-human").
    // Publishing no longer depends on a Linear call, so an unconditional overwrite
    // would newly rewrite terminal records — including the yield-expiry sweep's
    // `failed` + failureReason — on every escalation.
    expect(sig.status).toBe("done");
    expect(sig.stallClass).toBeTruthy(); // the escalation's real contribution
    expect(sig.explanation.call_to_action).toBe("review");
  });

  test("still writes when there is no prior signal at all", () => {
    mkdirSync(join(orchDir, "workers", "CTL-LW-none"), { recursive: true });
    const wrote = applyWith("CTL-LW-none");

    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(SIG("CTL-LW-none"), "utf8")).status).toBe("stalled"); // CTL-2159
  });
});

// ─── CTL-2056: escalation event emit seam in labelNeedsHumanUnlessBeliefOwner ─

describe("labelNeedsHumanUnlessBeliefOwner — CTL-2056 escalation emit", () => {
  function applyAndRecord({
    ticket = "CTL-2056",
    explanation = { type: "authorization", problem: "attempts exhausted", call_to_action: "check" },
    site = "scheduler",
    applyResult = { applied: true },
  } = {}) {
    const emitCalls = [];
    const emitEscalation = (t, meta) => emitCalls.push({ ticket: t, meta });
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    const ws = { applyLabel: () => applyResult };
    labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, ws, {
      site,
      explanation,
      emitEscalation,
    });
    return emitCalls;
  }

  test("emits exactly one escalation event on a CONFIRMED apply", () => {
    const calls = applyAndRecord();
    expect(calls.length).toBe(1);
    expect(calls[0].ticket).toBe("CTL-2056");
    expect(calls[0].meta.site).toBe("scheduler");
    expect(calls[0].meta.reason).toBe("attempts exhausted");
  });

  test("emits NOTHING when deferred to belief owner (CATALYST_INTENTS_ENFORCE=1)", () => {
    const emitCalls = [];
    const emitEscalation = (t, meta) => emitCalls.push({ ticket: t, meta });
    mkdirSync(join(orchDir, "workers", "CTL-D1"), { recursive: true });
    const ws = { applyLabel: () => ({ applied: true }) };
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-D1", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "1" },
      emitEscalation,
    });
    expect(emitCalls.length).toBe(0);
  });

  test("emits NOTHING on a marker-guarded no-op (ran:false — .applied already exists)", () => {
    const emitCalls = [];
    const emitEscalation = (t, meta) => emitCalls.push({ ticket: t, meta });
    mkdirSync(join(orchDir, "workers", "CTL-NOP"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "CTL-NOP", ".linear-label-needs-human.applied"), "");
    const ws = { applyLabel: () => ({ applied: true }) };
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-NOP", ws, { emitEscalation });
    expect(emitCalls.length).toBe(0);
  });

  // ⛔ CTL-2159: "a failed apply" is no longer reachable — applyLabel is never
  // called for this label, so a Linear failure cannot suppress the escalation
  // event. What DOES suppress it is the marker no-op and the belief deferral,
  // both pinned above. Re-pointed at the surviving property.
  test("CTL-2159 — a Linear apply result no longer decides whether the event fires", () => {
    const calls = applyAndRecord({ applyResult: { applied: false, reason: "rate-limited" } });
    expect(calls.length).toBe(1);
    // The class rides on the event so the fleet alert can group by condition.
    expect(typeof calls[0].meta.stallClass).toBe("string");
  });

  test("a throwing emitEscalation seam never blocks the label application (fail-open)", () => {
    mkdirSync(join(orchDir, "workers", "CTL-THROW"), { recursive: true });
    const ws = { applyLabel: () => ({ applied: true }) };
    // Must not throw even when the emit seam throws.
    expect(() =>
      labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-THROW", ws, {
        emitEscalation: () => { throw new Error("emit boom"); },
      })
    ).not.toThrow();
    // The .applied marker must still be written (label application succeeded).
    expect(existsSync(join(orchDir, "workers", "CTL-THROW", ".linear-label-needs-human.applied"))).toBe(true);
  });
});

// ─── The escalation's fresh-signal status derives from the stall CLASS ────────
//
// ⛔ THE DEFECT THIS PINS. Publishing an escalation no longer depends on a Linear
// call, so it now CREATES phase-recovery-pass.json on tickets that never had one.
// Stamping the terminal `stalled` there made isTicketInFlight veto the ticket, and
// the escalation fires at DISPATCH_FAILURE_ESCALATION_THRESHOLD (3) — so every
// retry loop behind it silently ended at 3 instead of its own ceiling
// (CIRCUIT_BREAKER_THRESHOLD 8, getMaxDispatchRetries 5), with no log line on
// ticks 4-8. A SYSTEM stall is retry-with-backoff by definition; only ASK / MOOT /
// HELD stop the work.
describe("labelNeedsHumanUnlessBeliefOwner — fresh-signal status splits by stall class", () => {
  const SIG = (ticket) => join(orchDir, "workers", ticket, "phase-recovery-pass.json");

  function escalate(ticket, reason) {
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    return labelNeedsHumanUnlessBeliefOwner(
      orchDir,
      ticket,
      { applyLabel: () => ({ applied: true }) },
      {
        env: { CATALYST_INTENTS_ENFORCE: "0", CATALYST_ESCALATION_ASK: "off" },
        site: "dispatch-failures",
        reason,
        log: { info: () => {}, warn: () => {} },
      }
    );
  }

  test("a SYSTEM stall gets the RETRYABLE status, and the class is on disk", () => {
    expect(escalate("CTL-SYS", "dispatch-circuit-breaker:3")).toBe(true);
    const sig = JSON.parse(readFileSync(SIG("CTL-SYS"), "utf8"));
    expect(sig.status).toBe(RETRYABLE_STALL_STATUS);
    expect(sig.stallClass).toBe("system");
  });

  test("CONTROL: an unclassifiable stall keeps the TERMINAL status", () => {
    // Same call, same shape, only the reason differs — so the assertion above is
    // measuring the class and not just "whatever this function writes".
    expect(escalate("CTL-HELD", "wibble-frobnicator-misaligned")).toBe(true);
    const sig = JSON.parse(readFileSync(SIG("CTL-HELD"), "utf8"));
    expect(sig.status).toBe(TERMINAL_STALL_STATUS);
    expect(sig.stallClass).toBe("held");
  });

  test("a genuine human gate keeps the TERMINAL status", () => {
    expect(escalate("CTL-ASK", "design-signoff-gate")).toBe(true);
    expect(JSON.parse(readFileSync(SIG("CTL-ASK"), "utf8")).status).toBe(TERMINAL_STALL_STATUS);
  });

  test("⛔ THE PROPERTY: the retryable status does not stop dispatch; the terminal one does", () => {
    // isTicketInFlight is the reader whose veto truncated the retry budget. It sees
    // the recovery-pass signal as an unknown (never-superseded) phase, so its status
    // decides the ticket's fate directly.
    expect(isTicketInFlight({ research: "done", "recovery-pass": RETRYABLE_STALL_STATUS })).toBe(true);
    expect(isTicketInFlight({ research: "done", "recovery-pass": TERMINAL_STALL_STATUS })).toBe(false);
  });

  test("a PRIOR status still wins over both — the escalation contributes the CLASS", () => {
    mkdirSync(join(orchDir, "workers", "CTL-PRIOR"), { recursive: true });
    writeFileSync(
      SIG("CTL-PRIOR"),
      JSON.stringify({ ticket: "CTL-PRIOR", status: "failed", phase: "recovery-pass" })
    );
    expect(escalate("CTL-PRIOR", "dispatch-circuit-breaker:3")).toBe(true);
    const sig = JSON.parse(readFileSync(SIG("CTL-PRIOR"), "utf8"));
    expect(sig.status).toBe("failed"); // the yield-expiry sweep's record is not rewritten
    expect(sig.stallClass).toBe("system");
  });
});
