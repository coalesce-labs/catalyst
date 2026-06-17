// reap-intent.test.mjs — emitter unit tests (CTL-649 Phase 4).
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SCRATCH;
let LOG_PATH;

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "reap-intent-"));
  const yyyymm = new Date().toISOString().slice(0, 7);
  LOG_PATH = join(SCRATCH, "events", `${yyyymm}.jsonl`);
  process.env.CATALYST_DIR = SCRATCH;
});

async function freshModule() {
  // getEventLogPath reads CATALYST_DIR at call time (config.mjs), so
  // re-import isn't strictly required — but ?cb forces a fresh module
  // in case any constants get captured at module load.
  return await import(`./reap-intent.mjs?cb=${Date.now()}-${Math.random()}`);
}

describe("emitReapIntent", () => {
  it("appends a well-formed line to the event log", async () => {
    const { emitReapIntent } = await freshModule();
    const ok = await emitReapIntent("phase.yield.reap-requested", {
      ticket: "CTL-999",
      phase: "implement",
      bgJobId: "abc12345",
      reason: "duplicate-of-canonical",
    });
    expect(ok).toBe(true);
    expect(existsSync(LOG_PATH)).toBe(true);
    const last = readFileSync(LOG_PATH, "utf8").trim().split("\n").pop();
    const parsed = JSON.parse(last);
    expect(parsed.event).toBe("phase.yield.reap-requested");
    expect(parsed.ticket).toBe("CTL-999");
    expect(parsed.bg_job_id).toBe("abc12345");
    expect(parsed.reason).toBe("duplicate-of-canonical");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("rejects unknown event types", async () => {
    const { emitReapIntent } = await freshModule();
    await expect(emitReapIntent("bogus.event", {})).rejects.toThrow(/unknown/);
  });

  it("exposes REAP_INTENT_TYPES with 25 entries", async () => {
    const { REAP_INTENT_TYPES } = await freshModule();
    expect(REAP_INTENT_TYPES.length).toBe(25); // +2 for CTL-1242 J4 (janitor.signals.gc, janitor.would.gc)
    expect(REAP_INTENT_TYPES).toContain("phase.yield.reap-requested");
    expect(REAP_INTENT_TYPES).toContain("pr.merged.cleanup-requested");
    expect(REAP_INTENT_TYPES).toContain("orphans.reap-requested");
    expect(REAP_INTENT_TYPES).toContain("jobs.gc.swept"); // CTL-1165 D3
    expect(REAP_INTENT_TYPES).toContain("worktree.cleanup-deferred"); // CTL-791
    // CTL-1165 D2: the orphan child-process reaper vocabulary.
    expect(REAP_INTENT_TYPES).toContain("procOrphans.reap-requested");
    expect(REAP_INTENT_TYPES).toContain("procOrphans.reaped");
    expect(REAP_INTENT_TYPES).toContain("procOrphans.would-reap");
    expect(REAP_INTENT_TYPES).toContain("procOrphans.spared");
    // CTL-1004 stall-janitor (shadow-first) event vocabulary.
    expect(REAP_INTENT_TYPES).toContain("janitor.worktree.deferred");
    expect(REAP_INTENT_TYPES).toContain("janitor.would.reap-request");
    expect(REAP_INTENT_TYPES).toContain("janitor.would.kill-intent");
    expect(REAP_INTENT_TYPES).toContain("janitor.would.defer");
    // CTL-1005 J3 stall-clear vocabulary (the types CTL-1005 added to the
    // emitter but forgot to register here — every J3 verdict threw at the
    // emitter and was silently lost: CTL-1004/CTL-1056).
    expect(REAP_INTENT_TYPES).toContain("janitor.stall.cleared");
    expect(REAP_INTENT_TYPES).toContain("janitor.would.clear");
    // CTL-1242 J4 terminal/merged signal dir GC vocabulary.
    expect(REAP_INTENT_TYPES).toContain("janitor.signals.gc");
    expect(REAP_INTENT_TYPES).toContain("janitor.would.gc");
  });

  // CTL-1004/CTL-1056 regression guard: every event type the stall-janitor
  // EMITS must be registered in the reap-intent vocabulary, else emitReapIntent
  // throws "unknown reap-intent event type" and the verdict is silently dropped.
  // Enumerated from the SINGLE-SOURCE-OF-TRUTH constant both modules import.
  it("registers every JANITOR_EVENT_TYPES member in REAP_INTENT_TYPES (no drift)", async () => {
    const { REAP_INTENT_TYPES } = await freshModule();
    const { JANITOR_EVENT_TYPES } = await import(
      `./janitor-event-types.mjs?cb=${Date.now()}-${Math.random()}`
    );
    const missing = JANITOR_EVENT_TYPES.filter((t) => !REAP_INTENT_TYPES.includes(t));
    expect(missing).toEqual([]);
  });

  it("accepts the J3 janitor.stall.cleared + janitor.would.clear types end-to-end (CTL-1005)", async () => {
    const { emitReapIntent } = await freshModule();
    for (const type of ["janitor.stall.cleared", "janitor.would.clear"]) {
      const ok = await emitReapIntent(type, {
        ticket: "CTL-1005",
        phase: "implement",
        reason: "prior-artifact-now-complete",
      });
      expect(ok).toBe(true);
      const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
      expect(last.event).toBe(type);
      expect(last.ticket).toBe("CTL-1005");
    }
  });

  it("accepts jobs.gc.swept end-to-end (CTL-1165 D3)", async () => {
    const { emitReapIntent, REAP_INTENT_TYPES } = await freshModule();
    expect(REAP_INTENT_TYPES).toContain("jobs.gc.swept");
    const ok = await emitReapIntent("jobs.gc.swept", { reclaimed: 3 });
    expect(ok).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("jobs.gc.swept");
    expect(last.reclaimed).toBe(3);
  });

  it("accepts the procOrphans.* types end-to-end with pid/command fields (CTL-1165 D2)", async () => {
    const { emitReapIntent, REAP_INTENT_TYPES } = await freshModule();
    for (const type of [
      "procOrphans.reap-requested",
      "procOrphans.reaped",
      "procOrphans.would-reap",
      "procOrphans.spared",
    ]) {
      expect(REAP_INTENT_TYPES).toContain(type);
      const ok = await emitReapIntent(type, {
        pid: 4242,
        command: "node",
        reason: "orphan-node-under-worktree",
      });
      expect(ok).toBe(true);
      const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
      expect(last.event).toBe(type);
      expect(last.pid).toBe(4242);
      expect(last.command).toBe("node");
    }
  });

  it("accepts phase.terminal.reap-requested (CTL-695)", async () => {
    const { emitReapIntent, REAP_INTENT_TYPES } = await freshModule();
    expect(REAP_INTENT_TYPES).toContain("phase.terminal.reap-requested");
    const ok = await emitReapIntent("phase.terminal.reap-requested", {
      ticket: "CTL-695",
      phase: "monitor-deploy",
      bgJobId: "abcd1234",
      reason: "ctl-695-terminal-worker",
    });
    expect(ok).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("phase.terminal.reap-requested");
    expect(last.bg_job_id).toBe("abcd1234");
  });

  it("accepts phase.reclaim.reap-requested (CTL-661 hole #3)", async () => {
    const { emitReapIntent } = await freshModule();
    const ok = await emitReapIntent("phase.reclaim.reap-requested", {
      ticket: "CTL-661",
      phase: "implement",
      bgJobId: "abc12345",
      reason: "ctl-661-reclaim-happy-path",
    });
    expect(ok).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("phase.reclaim.reap-requested");
    expect(last.bg_job_id).toBe("abc12345");
  });

  it("accepts phase.reconcile.reap-requested with canonical/dominant fields (CTL-661 hole #4)", async () => {
    const { emitReapIntent } = await freshModule();
    const ok = await emitReapIntent("phase.reconcile.reap-requested", {
      ticket: "CTL-661",
      phase: "verify",
      bgJobId: "bbbb2222",
      canonicalBgJobId: "aaaa1111",
      dominantPhase: "verify",
      reason: "ctl-661-one-worker-per-ticket",
    });
    expect(ok).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("phase.reconcile.reap-requested");
    expect(last.canonical_bg_job_id).toBe("aaaa1111");
    expect(last.dominant_phase).toBe("verify");
  });

  it("camelCase keys map to snake_case JSON fields", async () => {
    const { emitReapIntent } = await freshModule();
    await emitReapIntent("phase.supersede.reap-requested", {
      ticket: "CTL-1",
      phase: "verify",
      bgJobId: "deadbeef",
      worktreePath: "/wt/CTL-1",
      dominantPhase: "implement",
    });
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.bg_job_id).toBe("deadbeef");
    expect(last.worktree_path).toBe("/wt/CTL-1");
    expect(last.dominant_phase).toBe("implement");
  });

  it("drops null / undefined / empty values", async () => {
    const { emitReapIntent } = await freshModule();
    await emitReapIntent("phase.yield.reap-requested", {
      ticket: "CTL-1",
      phase: "implement",
      bgJobId: "abc",
      reason: null,
      worktreePath: "",
    });
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last).not.toHaveProperty("reason");
    expect(last).not.toHaveProperty("worktree_path");
  });

  it("returns false (never throws) when the event log is unwritable", async () => {
    // Make a parent path component a regular file so mkdirSync(events) fails
    // with ENOTDIR. Producers rely on this false return to fall back to an
    // inline reap rather than crashing the sweep mid-flight.
    const blocker = join(SCRATCH, "notdir");
    writeFileSync(blocker, "x");
    process.env.CATALYST_DIR = blocker; // events/ would have to live under a file
    const { emitReapIntent } = await freshModule();
    const ok = await emitReapIntent("phase.abort.reap-requested", {
      ticket: "CTL-1",
      phase: "implement",
      bgJobId: "abc12345",
    });
    expect(ok).toBe(false);
  });
});
