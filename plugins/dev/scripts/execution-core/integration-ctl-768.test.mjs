// CTL-768 end-to-end integration tests — park → stop → free slot → new work → revive.
//
// Exercises the full held-stop + revive-with-resume loop through schedulerTick
// and handleCommentWake with injected seams (livenessForHeld, killBgJob,
// dispatch, liveBackgroundCount, resolveSession, now).
//
// Run: cd plugins/dev/scripts/execution-core && bun test integration-ctl-768.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  schedulerTick,
  __resetForTests,
  writeWorkerPriority,
  holdStopCooldownPath,
  recordHoldStop,
  inHoldStopCooldown,
} from "./scheduler.mjs";
import { handleCommentWake } from "./daemon.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl768-int-"));
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

// Seed a needs-input worker signal (stopped process that parked waiting for human)
function seedNeedsInput(orchDir, ticket, phase, bgJobId) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status: "needs-input", bg_job_id: bgJobId })
  );
  writeWorkerPriority(orchDir, ticket, { priority: 2, createdAt: "2026-05-01T00:00:00Z" });
}

// Seed a queued ticket in the eligible set.
// getEligibleDir() resolves to <CATALYST_DIR>/execution-core/eligible (config.mjs),
// so write there — not under orchDir — to match what schedulerTick reads.
function seedQueued(_orchDir, ticket) {
  const eligibleDir = join(catalystDir, "execution-core", "eligible");
  mkdirSync(eligibleDir, { recursive: true });
  // Write an eligible-set projection file that the scheduler can read
  const prefix = ticket.split("-")[0]; // e.g. "CTL"
  writeFileSync(
    join(eligibleDir, `${prefix}.json`),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      tickets: [{ identifier: ticket, priority: 2, createdAt: "2026-05-01T00:00:00Z" }],
    })
  );
}

// Read a signal file
function readSig(orchDir, ticket, phase) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const noopReclaim = () => "noop";

describe("CTL-768 acceptance scenario — park → stop → free slot → new work → revive", () => {
  test("idle needs-input worker stopped (tick 1), slot frees (tick 2), revives on comment", async () => {
    // Seed: one needs-input worker (held1234) + one queued new-work ticket CTL-2
    seedNeedsInput(orchDir, "CTL-1", "implement", "held1234");
    seedQueued(orchDir, "CTL-2");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));

    // Tick 1: liveCount=1 (worker still alive at count time) → stop fires, freeSlots stays 0.
    const kill = [];
    const dispatched1 = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1, maxParallel: 1,
      livenessForHeld: () => "idle",
      killBgJob: ({ bgJobId }) => kill.push(bgJobId),
      // dispatch receives a single args object: { orchDir, ticket, phase, ... }
      dispatch: (args) => { dispatched1.push(args.ticket); return { code: 0, stdout: "", stderr: "" }; },
      verifyDispatched: () => ({ ok: true }), // CTL-611: no real signal file written
      reclaimDeadWork: noopReclaim,
      now: () => 1_000,
    });
    expect(kill).toEqual(["held1234"]);
    expect(dispatched1).not.toContain("CTL-2");          // heldStopCount blocked double-fill
    const sig1 = readSig(orchDir, "CTL-1", "implement");
    expect(sig1.stoppedForHold).toBe(true);
    expect(sig1.bg_job_id).toBe("held1234");             // preserved
    expect(existsSync(holdStopCooldownPath(orchDir, "CTL-1", "implement"))).toBe(true);

    // Tick 2: snapshot reflects the stop (liveCount=0) → freeSlots=1 → CTL-2 dispatches.
    const dispatched2 = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 0, maxParallel: 1,
      livenessForHeld: () => "absent",
      // dispatch receives a single args object: { orchDir, ticket, phase, ... }
      dispatch: (args) => { dispatched2.push(args.ticket); return { code: 0, stdout: "", stderr: "" }; },
      verifyDispatched: () => ({ ok: true }), // CTL-611: no real signal file written
      reclaimDeadWork: noopReclaim,
      now: () => 31_000,
    });
    expect(dispatched2).toContain("CTL-2");

    // Comment arrives → revive CTL-1 with --resume.
    const revive = [];
    await handleCommentWake({ ticket: "CTL-1" }, {
      orchDir,
      dispatch: (d, t, p, opts) => revive.push({ p, opts }),
      removeLabel: async () => {},
      resolveSession: () => "uuid-resume",
    });
    expect(revive).toHaveLength(1);
    expect(revive[0].opts.resumeSession).toBe("uuid-resume");
    const sig2 = readSig(orchDir, "CTL-1", "implement");
    expect(sig2.status).toBe("stalled");
    expect(sig2.stoppedForHold).toBe(false);
    expect(inHoldStopCooldown(orchDir, "CTL-1", "implement", 32_000)).toBe(false); // cleared
  });
});

describe("CTL-768 guard scenario — already-stopped worker not double-stopped", () => {
  test("cooldown guard prevents double-stop on next tick", () => {
    // Worker was stopped this tick; on next tick with stale snapshot, cooldown guards it.
    seedNeedsInput(orchDir, "CTL-1", "implement", "held1234");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));

    // First stop
    const kill1 = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1, livenessForHeld: () => "idle",
      killBgJob: ({ bgJobId }) => kill1.push(bgJobId),
      reclaimDeadWork: noopReclaim, now: () => 1_000,
    });
    expect(kill1).toHaveLength(1);

    // Second tick within cooldown window — even if snapshot says "idle" again
    const kill2 = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1, livenessForHeld: () => "idle",
      killBgJob: ({ bgJobId }) => kill2.push(bgJobId),
      reclaimDeadWork: noopReclaim, now: () => 31_000,  // 30s later, still within 90s window
    });
    expect(kill2).toHaveLength(0);  // cooldown guard blocked double-stop
  });
});
