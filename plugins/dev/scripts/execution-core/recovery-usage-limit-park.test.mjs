import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reclaimDeadWorkIfPossible } from "./recovery.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

function scenario({ writeSignal = true, detail = "You've hit your weekly limit · resets Aug 10 at 1pm (America/Chicago)" } = {}) {
  const orchDir = mkdtempSync(join(tmpdir(), "cat58-park-"));
  dirs.push(orchDir);
  const ticket = "CAT-58";
  const phase = "implement";
  const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  if (writeSignal) {
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    writeFileSync(signalPath, JSON.stringify({ ticket, phase, status: "running", bg_job_id: "job-58" }));
  }
  const signal = {
    ticket,
    phase,
    status: "running",
    liveness: { kind: "bg", value: "job-58" },
    signalPath,
    raw: { ticket, phase, status: "running", bg_job_id: "job-58" },
  };
  const appendUsageLimitEvent = recorder(undefined);
  const parkLaneFn = recorder(undefined);
  const applyStalledLabel = recorder({ applied: true });
  const resetsAt = "2026-08-10T18:00:00.000Z";
  const opts = {
    repoRoot: "/repo",
    jobLifecycle: () => "dead-gone",
    probes: { implement: () => false },
    detectUsageLimit: () => ({ blocked: true, resetsAt, resetSource: "detail", source: "timeline", detail }),
    appendUsageLimitEvent,
    parkLaneFn,
    recordDispatchFailureFn: recorder(undefined),
    applyStalledLabel,
    killBgJob: recorder(undefined),
    emitReapIntent: () => Promise.resolve(),
    now: () => Date.parse("2026-08-08T18:00:00.000Z"),
  };
  return { orchDir, ticket, phase, signalPath, signal, opts, appendUsageLimitEvent, parkLaneFn, applyStalledLabel };
}

describe("reclaimDeadWorkIfPossible — CAT-58 usage-limit park", () => {
  test("the park writes the operator explanation onto the phase signal", () => {
    const s = scenario();
    expect(reclaimDeadWorkIfPossible(s.orchDir, s.signal, s.opts)).toBe("usage-limit-parked");
    const persisted = JSON.parse(readFileSync(s.signalPath, "utf8"));
    expect(persisted.failureReason).toBe("usage-limit-blocked");
    expect(persisted.usageLimitExplanation.observed.likely_cause).toBe("account-usage-limit");
    expect(persisted.usageLimitExplanation.problem).toMatch(/usage limit is exhausted/i);
    expect(persisted.usageLimitExplanation.call_to_action).toMatch(/codex-exec/);
    expect(persisted.status).toBe("failed");
    expect(s.applyStalledLabel.calls).toHaveLength(0);
  });

  test("the emitted event input carries the operator-facing explanation", () => {
    const s = scenario();
    reclaimDeadWorkIfPossible(s.orchDir, s.signal, s.opts);
    const [envelope] = s.appendUsageLimitEvent.calls[0];
    expect(envelope.explanation.problem).toMatch(/usage limit/i);
    expect(envelope.explanation.call_to_action).toBeTruthy();
    expect(envelope.quota.resetsAt).toBeTruthy();
  });

  test("a signal-write failure still parks the lane and returns the outcome", () => {
    const s = scenario({ writeSignal: false });
    expect(reclaimDeadWorkIfPossible(s.orchDir, s.signal, s.opts)).toBe("usage-limit-parked");
    expect(s.parkLaneFn.calls).toHaveLength(1);
  });

  test("the park path does not write phase-recovery-pass.json", () => {
    const s = scenario();
    reclaimDeadWorkIfPossible(s.orchDir, s.signal, s.opts);
    expect(existsSync(join(s.orchDir, "workers", s.ticket, "phase-recovery-pass.json"))).toBe(false);
  });
});
