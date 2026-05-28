// CTL-705 end-to-end integration tests — global priority+stage sort + preemption.
//
// Exercises the full preemption + resume loop through schedulerTick with
// injected seams (killBgJob, dispatch, liveBackgroundCount, resolveSession, now).
// Two scenarios cover the acceptance criteria from the plan:
//   1. maxParallel=2, 2 Low in-flight, 1 Urgent queued → CTL-2 (lower stage)
//      preempted on tick 2; re-dispatched with --resume-session on tick 3.
//   2. Only in-flight worker is at monitor-deploy → no preemption.
//
// Run: cd plugins/dev/scripts/execution-core && bun test integration-ctl-705.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick, __resetForTests, writeWorkerPriority } from "./scheduler.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl705-int-"));
  if (!catalystDir.startsWith(tmpdir())) {
    throw new Error(`integration test refused: catalystDir not under tmpdir: ${catalystDir}`);
  }
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  orchDir = join(catalystDir, "orch");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  __resetForTests();
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function seedWorker(ticket, phase, priority, startedAtMs, bgJobId, createdAt) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date(startedAtMs).toISOString();
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status: "running", bg_job_id: bgJobId, startedAt })
  );
  writeWorkerPriority(orchDir, ticket, { priority, createdAt: createdAt ?? "2026-05-01T00:00:00Z" });
}

function readSignal(ticket, phase) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function makeKillStub() {
  const calls = [];
  const fn = (args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

// dispatch that writes a real signal file so verifyDispatched passes
function makeRealDispatch() {
  const calls = [];
  const fn = ({ orchDir: od, ticket, phase, resumeSession }) => {
    calls.push({ ticket, phase, resumeSession });
    const dir = join(od, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "dispatched", bg_job_id: "new-bg-" + ticket })
    );
    return { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

const noopReclaim = () => "noop";

describe("CTL-705 acceptance scenario — preemption + resume", () => {
  test("Tick 1+2+3: Urgent queued + 2 Low in-flight → CTL-2 preempted (tick 2), resumed (tick 3)", () => {
    const T0 = 200_000;
    // Two Low (priority 4) in-flight workers, both >60s old
    seedWorker("CTL-1", "verify", 4, T0 - 90_000, "bg-1"); // verify = stage 5
    seedWorker("CTL-2", "research", 4, T0 - 90_000, "bg-2"); // research = stage 1 — lowest

    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const kill = makeKillStub();

    const baseOpts = {
      readEligible: () => [{ identifier: "CTL-9", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
      reclaimDeadWork: noopReclaim,
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {}, applyLabel: () => {} },
    };

    // Tick 1 (T0): first observation — hysteresis window opens, no preemption
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: makeRealDispatch(), // would dispatch CTL-9 if slot free — but slots are full
      liveBackgroundCount: () => 2,
      now: () => T0,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
    expect(readSignal("CTL-2", "research")?.status).toBe("running"); // not yet preempted

    // Tick 2 (T0+35s): hysteresis window passed → CTL-2 preempted
    const dispatch2 = makeRealDispatch();
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: dispatch2,
      liveBackgroundCount: () => 2, // still saturated
      now: () => T0 + 35_000,
      killBgJob: kill,
    });
    expect(kill.calls.map((c) => c.bgJobId)).toContain("bg-2"); // CTL-2 stopped
    expect(kill.calls.map((c) => c.bgJobId)).not.toContain("bg-1"); // CTL-1 not stopped
    const preemptedSig = readSignal("CTL-2", "research");
    expect(preemptedSig?.status).toBe("preempted");
    expect(preemptedSig?.parkedFrom).toBe("research");

    // Verify the event log contains a preemption event for CTL-2
    const now2 = new Date();
    const ym = `${now2.getUTCFullYear()}-${String(now2.getUTCMonth() + 1).padStart(2, "0")}`;
    const eventLog = readFileSync(join(catalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const preemptEvent = eventLog.find(
      (e) => e.attributes?.["event.name"] === "phase.research.preempted.CTL-2"
    );
    expect(preemptEvent).toBeDefined();

    // Tick 3: slot frees (liveCount drops to 1) → CTL-2 resumed with --resume-session
    const dispatch3 = makeRealDispatch();
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: dispatch3,
      liveBackgroundCount: () => 1, // one slot free
      now: () => T0 + 36_000,
      killBgJob: makeKillStub(),
      resolveSession: () => "resume-uuid-ctL2", // injectable — returns a valid resume UUID
    });
    const resumeCall = dispatch3.calls.find((c) => c.ticket === "CTL-2");
    expect(resumeCall).toBeDefined();
    expect(resumeCall.phase).toBe("research"); // parkedFrom
    expect(resumeCall.resumeSession).toBe("resume-uuid-ctL2");

    // CTL-2 signal should no longer be "preempted" (dispatched by resume sweep)
    const resumedSig = readSignal("CTL-2", "research");
    expect(resumedSig?.status).toBe("dispatched");

    // resumed-after-preemption event in log
    const eventLog3 = readFileSync(join(catalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const resumeEvent = eventLog3.find(
      (e) => e.attributes?.["event.name"] === "phase.research.resumed-after-preemption.CTL-2"
    );
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent.body.payload.resume_session).toBe("resume-uuid-ctL2");
  });
});

describe("CTL-705 reclaim-guard scenario — real reclaimDeadWork, no stub", () => {
  // The acceptance scenario above injects reclaimDeadWork: noopReclaim, which
  // masks the reclaim-guard regression entirely. This test deliberately does
  // NOT stub reclaimDeadWork (schedulerTick falls back to the real
  // reclaimDeadWorkIfPossible from recovery.mjs), so the guard is the only thing
  // standing between a parked-with-dead-bg signal and a false revive.
  function seedPreempted(ticket, phase, bgJobId, priority) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({
        ticket,
        phase,
        status: "preempted",
        parkedFrom: phase,
        bg_job_id: bgJobId, // a now-dead bg job — what classifyWorker would treat as dead
        attentionReason: "preempted-by-priority",
      })
    );
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: "2026-05-01T00:00:00Z" });
  }

  test("parked-with-dead-bg signal is NOT revived by the real reclaim sweep; only the resume sweep re-dispatches it", () => {
    const T0 = 200_000;
    // CTL-Park is the ONLY in-flight worker, parked at research with a dead
    // bg_job_id. It is the only signal the real reclaim sweep would iterate.
    seedPreempted("CTL-Park", "research", "bg-park-dead", 4);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));

    const writeStatus = { applyPhaseStatus: () => {}, applyTerminalDone: () => {}, applyLabel: () => {} };

    // Tick A — saturated (liveBackgroundCount=1). The resume sweep (1.5) sees 0
    // free slots and skips. With NO reclaim stub, the real reclaim sweep runs
    // first; without the CTL-705 guard it would route the parked-dead-bg signal
    // through the death trigger and revive it (a duplicate spawn). The guard
    // makes the parked signal untouched.
    const dispatchA = makeRealDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      // reclaimDeadWork intentionally omitted → real reclaimDeadWorkIfPossible
      dispatch: dispatchA,
      liveBackgroundCount: () => 1,
      now: () => T0,
      killBgJob: makeKillStub(),
      writeStatus,
    });
    // The parked signal must be untouched — no revive, no advancement, status
    // still "preempted", bg_job_id unchanged.
    const afterA = readSignal("CTL-Park", "research");
    expect(afterA?.status).toBe("preempted");
    expect(afterA?.bg_job_id).toBe("bg-park-dead");
    expect(dispatchA.calls.find((c) => c.ticket === "CTL-Park")).toBeUndefined();

    // Tick B — a slot frees (liveBackgroundCount=0). NOW the resume sweep owns
    // the re-dispatch (not the reclaim sweep), at parkedFrom=research.
    const dispatchB = makeRealDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      // reclaimDeadWork still omitted → real reclaim
      dispatch: dispatchB,
      liveBackgroundCount: () => 0,
      now: () => T0 + 1_000,
      killBgJob: makeKillStub(),
      resolveSession: () => null, // cold re-dispatch (no --resume-session)
      writeStatus,
    });
    const resumeCall = dispatchB.calls.find((c) => c.ticket === "CTL-Park");
    expect(resumeCall).toBeDefined();
    expect(resumeCall.phase).toBe("research"); // re-dispatched at parkedFrom
    expect(readSignal("CTL-Park", "research")?.status).toBe("dispatched");
  });
});

describe("CTL-705 guard scenario — monitor-deploy not preemptable", () => {
  test("Only in-flight worker at monitor-deploy → no preemption even with Urgent queued", () => {
    const T0 = 200_000;
    seedWorker("CTL-MD", "monitor-deploy", 4, T0 - 90_000, "bg-md");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();

    const baseOpts = {
      readEligible: () => [{ identifier: "CTL-9", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
      reclaimDeadWork: noopReclaim,
      liveBackgroundCount: () => 1, // saturated
      now: () => T0 + 35_000, // past hysteresis
      killBgJob: kill,
    };

    // Two ticks — first to open hysteresis, second to confirm no preemption
    schedulerTick(orchDir, { ...baseOpts, now: () => T0 });
    schedulerTick(orchDir, { ...baseOpts, now: () => T0 + 35_000 });

    expect(kill.calls).toHaveLength(0); // monitor-deploy is non-preemptable
    expect(readSignal("CTL-MD", "monitor-deploy")?.status).toBe("running"); // unchanged
  });
});
