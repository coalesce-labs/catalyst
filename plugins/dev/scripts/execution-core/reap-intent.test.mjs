// reap-intent.test.mjs — emitter unit tests (CTL-649 Phase 4).
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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

  it("exposes REAP_INTENT_TYPES with 8 entries", async () => {
    const { REAP_INTENT_TYPES } = await freshModule();
    expect(REAP_INTENT_TYPES.length).toBe(8);
    expect(REAP_INTENT_TYPES).toContain("phase.yield.reap-requested");
    expect(REAP_INTENT_TYPES).toContain("pr.merged.cleanup-requested");
    expect(REAP_INTENT_TYPES).toContain("orphans.reap-requested");
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
});
