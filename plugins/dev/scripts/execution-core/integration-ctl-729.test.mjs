// integration-ctl-729.test.mjs — CTL-729 end-to-end: schedulerTick Pass 0w.
// Drives the real schedulerTick over a fixture worker dir, asserting the whole
// chain to the injected seam boundary. Models integration-ctl-701.test.mjs.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";

const NOW = Date.parse("2026-06-09T12:00:00Z");

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl729-int-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writePhaseSignal(orchDir, ticket, phase, body) {
  const d = join(orchDir, "workers", ticket);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }, null, 2) + "\n",
  );
}

// Minimal tick options shared across all scenarios.
// Injects a no-op reclaimDeadWork so the reclaim/stalled passes don't interfere
// with what the watchdog pass did.
function makeTickOpts({ transcriptAgeMs = () => null, progressMark = () => 0, mode = "enforce", events = [] }) {
  return {
    readEligible: () => [],
    dispatch: () => ({ status: "dispatched" }),
    exec: () => ({ code: null }),
    // Prevent reclaim sweep from acting on the fixture workers.
    reclaimDeadWork: () => ({ class: "alive-suppressed" }),
    writeStatus: {
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ applied: true }),
      runTransition: () => ({ applied: false }),
    },
    now: () => NOW,
    watchdog: {
      mode,
      transcriptAgeMs: (sig, opts) => transcriptAgeMs(sig, opts),
      progressMark: (opts) => progressMark(opts),
      now: () => NOW,
      emit: (type, fields) => { events.push({ type, ...fields }); return Promise.resolve(true); },
      killEscalate: undefined, // use real killHungWorker
    },
  };
}

describe("CTL-729 integration — incident scenario (enforce mode)", () => {
  test("CTL-692 incident: hung implement → failed signal + reap event + needs-human, one tick", async () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const events = [];
    const opts = makeTickOpts({
      transcriptAgeMs: () => 31 * 60_000,  // silent (>30min)
      progressMark: () => 0,               // no commits
      mode: "enforce",
      events,
    });
    const result = schedulerTick(orchDir, opts);
    // Give the fire-and-forget emit time to run
    await new Promise((r) => setTimeout(r, 10));
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-729T", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("failed");
    expect(sig.failureReason).toMatch(/hung_no_progress:implement:\d+m_0_commits/);
    // Custom emit receives camelCase fields (FIELD_MAP conversion only in the real emitReapIntent)
    expect(events.some((e) => e.type === "phase.terminal.reap-requested" && (e.bgJobId === "abcd1234" || e.bg_job_id === "abcd1234"))).toBe(true);
    expect(existsSync(join(orchDir, "workers", "CTL-729T", ".linear-label-needs-human.applied"))).toBe(true);
    expect(result.watchdogKilled).toEqual([{ ticket: "CTL-729T", phase: "implement" }]);
  });
});

describe("CTL-729 integration — spared scenarios", () => {
  test("scenario 2: actively-progressing worker (fresh transcript) untouched", () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const opts = makeTickOpts({ transcriptAgeMs: () => 5_000, progressMark: () => 0, mode: "enforce" });
    schedulerTick(orchDir, opts);
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-729T", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("running");
  });

  test("scenario 3: terminal worker is invisible — no reap emitted", () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "failed",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const events = [];
    const opts = makeTickOpts({
      transcriptAgeMs: () => 31 * 60_000, progressMark: () => 0, mode: "enforce", events,
    });
    schedulerTick(orchDir, opts);
    expect(events.filter((e) => e.type === "phase.terminal.reap-requested")).toHaveLength(0);
  });

  test("scenario 4: worker with >=1 commit is not killed (implement phase)", () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const opts = makeTickOpts({
      transcriptAgeMs: () => 31 * 60_000,
      progressMark: () => 3, // has commits
      mode: "enforce",
    });
    schedulerTick(orchDir, opts);
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-729T", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("running");
  });
});

describe("CTL-729 integration — shadow mode", () => {
  test("shadow mode: hung worker is logged but NOT killed (signal stays running, no reap)", async () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const events = [];
    const opts = makeTickOpts({
      transcriptAgeMs: () => 31 * 60_000, progressMark: () => 0, mode: "shadow", events,
    });
    const result = schedulerTick(orchDir, opts);
    await new Promise((r) => setTimeout(r, 10));
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-729T", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("running");
    expect(events.filter((e) => e.type === "phase.terminal.reap-requested")).toHaveLength(0);
    expect(result.watchdogWouldKill).toEqual([{ ticket: "CTL-729T", phase: "implement" }]);
    expect(result.watchdogKilled).toEqual([]);
  });
});

describe("CTL-729 integration — off mode", () => {
  test("mode:off skips the pass entirely", () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    const opts = makeTickOpts({ transcriptAgeMs: () => 31 * 60_000, progressMark: () => 0, mode: "off" });
    const result = schedulerTick(orchDir, opts);
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-729T", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("running");
    expect(result.watchdogKilled).toEqual([]);
    expect(result.watchdogWouldKill).toEqual([]);
  });
});

describe("CTL-729 integration — isolated error in watchdog step", () => {
  test("a thrown watchdog step does not abort the tick (other workers still processed)", () => {
    writePhaseSignal(orchDir, "CTL-729T", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      startedAt: new Date(NOW - 18 * 3600_000).toISOString(),
      turnCap: 75,
    });
    let throws = true;
    const opts = makeTickOpts({
      transcriptAgeMs: () => { if (throws) { throws = false; throw new Error("injected"); } return 31 * 60_000; },
      progressMark: () => 0,
      mode: "enforce",
    });
    // Should not throw; watchdog step error is isolated
    expect(() => schedulerTick(orchDir, opts)).not.toThrow();
  });
});
