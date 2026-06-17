// label-guard.test.mjs — labelOnce moved from scheduler (CTL-585) + the new
// escalation cool-down primitives (CTL-638). Run:
//   cd plugins/dev/scripts/execution-core && bun test label-guard.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labelOnce,
  clearStalledLabel,
  inEscalationCooldown,
  recordEscalation,
  escalationCooldownPath,
  ESCALATION_COOLDOWN_MS,
  recordRemovalFailure,
  clearRemovalFailures,
  inRemovalBackoff,
  beliefOwnsNeedsHuman,
  labelNeedsHumanUnlessBeliefOwner,
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

  test("with enforcement OFF: calls labelOnce (legacy behavior unchanged)", () => {
    const ws = makeWS();
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    const deferred = [];
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-1", ws, {
      env: { CATALYST_INTENTS_ENFORCE: "0" },
      site: "test-site",
      log: { info: (obj) => deferred.push(obj) },
    });
    expect(ws.calls.length).toBe(1);
    expect(ws.calls[0]).toMatchObject({ ticket: "CTL-1", label: "needs-human" });
    expect(deferred.length).toBe(0);
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

  test("with enforcement unset: calls labelOnce (default OFF)", () => {
    const ws = makeWS();
    mkdirSync(join(orchDir, "workers", "CTL-3"), { recursive: true });
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-3", ws, {
      env: {},
      site: "test-site",
      log: { info: () => {} },
    });
    expect(ws.calls.length).toBe(1);
  });
});
