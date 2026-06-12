// watchdog-action.test.mjs — CTL-729 Phase 4 tests.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killHungWorker } from "./watchdog-action.mjs";

const T = "CTL-729";
const PHASE = "implement";

function recorder(rv) {
  const fn = (...a) => { fn.calls.push(a); return rv; };
  fn.calls = [];
  return fn;
}

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl729-action-"));
  mkdirSync(join(orchDir, "workers", T), { recursive: true });
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writeSignal(status, extra = {}) {
  const flat = {
    ticket: T, phase: PHASE, status,
    startedAt: "2026-06-09T00:00:00Z",
    bg_job_id: "abcd1234",
    worktreePath: "/wt/CTL-729",
    ...extra,
  };
  writeFileSync(join(orchDir, "workers", T, `phase-${PHASE}.json`), JSON.stringify(flat, null, 2) + "\n");
  return { ticket: T, phase: PHASE, status, raw: flat };
}

describe("killHungWorker — escalated path", () => {
  test("rewrites signal to status:failed with hung reason; atomic (no .tmp left); preserves fields", async () => {
    const sig = writeSignal("running");
    const r = await killHungWorker(orchDir, T, sig, {
      elapsedMin: 1080, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)),
      now: () => 1_000_000,
    });
    const onDisk = JSON.parse(readFileSync(join(orchDir, "workers", T, `phase-${PHASE}.json`), "utf8"));
    expect(onDisk.status).toBe("failed");
    expect(onDisk.failureReason).toBe(`hung_no_progress:${PHASE}:1080m_0_commits`);
    expect(onDisk.failedAt).toBeTruthy();
    expect(onDisk.bg_job_id).toBe("abcd1234");
    expect(onDisk.worktreePath).toBe("/wt/CTL-729");
    expect(existsSync(`${join(orchDir, "workers", T, `phase-${PHASE}.json`)}.tmp.${process.pid}`)).toBe(false);
    expect(r.outcome).toBe("escalated");
  });

  test("emits phase.terminal.reap-requested carrying bg_job_id", async () => {
    const emit = recorder(Promise.resolve(true));
    await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1080, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit, now: () => 1,
    });
    const [evt, fields] = emit.calls[0];
    expect(evt).toBe("phase.terminal.reap-requested");
    expect(fields.bgJobId).toBe("abcd1234");
    expect(fields.ticket).toBe(T);
    expect(fields.reason).toMatch(/hung_no_progress/);
  });

  test("creates .linear-label-needs-human.applied marker", async () => {
    await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1080, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)),
      now: () => 1,
    });
    expect(existsSync(join(orchDir, "workers", T, ".linear-label-needs-human.applied"))).toBe(true);
  });

  test("CTL-729 coverage: writes the .escalation-cooldowns marker carrying the hung_no_progress reason", async () => {
    // recordEscalation runs on every escalate path (label-guard.mjs); a regression
    // dropping the call would otherwise pass all the other assertions here. Guard
    // the marker + its failureReason so the cooldown that throttles re-escalation
    // (CTL-638) is provably written.
    await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1080, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)),
      now: () => 1_700_000,
    });
    const marker = join(orchDir, ".escalation-cooldowns", `${T}-${PHASE}.json`);
    expect(existsSync(marker)).toBe(true);
    const envelope = JSON.parse(readFileSync(marker, "utf8"));
    expect(envelope.reason).toBe(`hung_no_progress:${PHASE}:1080m_0_commits`);
    expect(envelope.escalatedAt).toBe(1_700_000);
  });
});

describe("killHungWorker — already-terminal guard", () => {
  test("raced-to-terminal: on-disk already failed → already-terminal, no emit/label", async () => {
    const inMem = writeSignal("running");
    // race: another writer flips the on-disk signal terminal
    writeFileSync(
      join(orchDir, "workers", T, `phase-${PHASE}.json`),
      JSON.stringify({ ...inMem.raw, status: "failed" }),
    );
    const emit = recorder(Promise.resolve(true));
    const ws = { applyLabel: recorder({ applied: true }) };
    const r = await killHungWorker(orchDir, T, inMem, {
      elapsedMin: 1080, commitCount: 0, writeStatus: ws, emit, now: () => 1,
    });
    expect(r.outcome).toBe("already-terminal");
    expect(emit.calls.length).toBe(0);
    expect(ws.applyLabel.calls.length).toBe(0);
  });

  test("in-memory signal is already terminal → already-terminal early-return", async () => {
    const sig = writeSignal("failed");
    const emit = recorder(Promise.resolve(true));
    const r = await killHungWorker(orchDir, T, sig, {
      elapsedMin: 1080, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit, now: () => 1,
    });
    expect(r.outcome).toBe("already-terminal");
    expect(emit.calls.length).toBe(0);
  });
});

describe("killHungWorker — bg_job_id absent", () => {
  test("terminal write + label still happen, no reap emitted", async () => {
    const emit = recorder(Promise.resolve(true));
    const ws = { applyLabel: recorder({ applied: true }) };
    const r = await killHungWorker(orchDir, T, writeSignal("running", { bg_job_id: undefined }), {
      elapsedMin: 1080, commitCount: 0, writeStatus: ws, emit, now: () => 1,
    });
    expect(JSON.parse(readFileSync(join(orchDir, "workers", T, `phase-${PHASE}.json`), "utf8")).status).toBe("failed");
    expect(emit.calls.length).toBe(0);
    expect(existsSync(join(orchDir, "workers", T, ".linear-label-needs-human.applied"))).toBe(true);
    expect(r.outcome).toBe("escalated");
  });
});

describe("killHungWorker — revive-budget", () => {
  test("reviveBudget=1: first hit revives, second escalates", async () => {
    const dispatch = recorder({ ok: true });
    const emit = recorder(Promise.resolve(true));
    const r1 = await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1080, commitCount: 0, reviveBudget: 1,
      reviveDispatch: dispatch,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit, now: () => 1,
    });
    expect(r1.outcome).toBe("revived");
    expect(dispatch.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1); // old session reaped
    expect(existsSync(join(orchDir, "workers", T, `.watchdog-revive-${PHASE}.1`))).toBe(true);

    // second call (same ticket) → already used 1 revive → escalate
    const r2 = await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1110, commitCount: 0, reviveBudget: 1,
      reviveDispatch: dispatch,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)), now: () => 9_000_000,
    });
    expect(r2.outcome).toBe("escalated");
    expect(dispatch.calls.length).toBe(1); // no second dispatch
  });

  test("reviveBudget=0 (default): always escalates, never dispatches", async () => {
    const dispatch = recorder({ ok: true });
    const r = await killHungWorker(orchDir, T, writeSignal("running"), {
      elapsedMin: 1080, commitCount: 0, reviveDispatch: dispatch,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)), now: () => 1,
    });
    expect(r.outcome).toBe("escalated");
    expect(dispatch.calls.length).toBe(0);
  });
});

// CTL-1065: structured explanation written to signal on hung-worker kill
import { validateExplanation } from "./escalation-explanation.mjs";

describe("CTL-1065: killHungWorker writes signal.explanation alongside failureReason", () => {
  test("escalated path writes a valid explanation with observed elapsedMin/commitCount/bgJobId", async () => {
    const sig = writeSignal("running");
    await killHungWorker(orchDir, T, sig, {
      elapsedMin: 42, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)),
      now: () => 1_000_000,
    });
    const onDisk = JSON.parse(readFileSync(join(orchDir, "workers", T, `phase-${PHASE}.json`), "utf8"));
    expect(onDisk.failureReason).toContain("hung_no_progress"); // unchanged
    expect(validateExplanation(onDisk.explanation).valid).toBe(true);
    expect(onDisk.explanation.observed.elapsedMin).toBe(42);
    expect(onDisk.explanation.observed.bgJobId).toBe("abcd1234");
  });

  test("already-terminal path does NOT overwrite existing signal", async () => {
    const sig = writeSignal("failed");
    const r = await killHungWorker(orchDir, T, sig, {
      elapsedMin: 42, commitCount: 0,
      writeStatus: { applyLabel: recorder({ applied: true }) },
      emit: recorder(Promise.resolve(true)),
      now: () => 1,
    });
    expect(r.outcome).toBe("already-terminal");
    const onDisk = JSON.parse(readFileSync(join(orchDir, "workers", T, `phase-${PHASE}.json`), "utf8"));
    // explanation was not written (already-terminal early return)
    expect(onDisk.explanation).toBeUndefined();
  });
});
