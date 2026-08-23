// durable-escalation.test.mjs — TDD tests for the CTL-1643 durable escalation
// store (the GC-surviving orchDir-level record that survives worker-dir removal).
//
// Three helpers:
//   recordDurableEscalation  — write/upsert .escalations/<T>.json under orchDir
//   readDurableEscalations   — scan .escalations/, parse all records, fail-open
//   forgetDurableEscalation  — unlink the record, idempotent, never throws

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mod = await import("./durable-escalation.mjs");
const {
  recordDurableEscalation,
  readDurableEscalations,
  forgetDurableEscalation,
  isHumanFacingEscalationRecord,
} = mod;

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpOrchDir() {
  return mkdtempSync(join(tmpdir(), "ctl-1643-esc-test-"));
}

function escalationPath(orchDir, ticket) {
  return join(orchDir, ".escalations", `${ticket}.json`);
}

// ─── recordDurableEscalation ─────────────────────────────────────────────────

describe("recordDurableEscalation — write/upsert", () => {
  let orchDir;
  beforeEach(() => { orchDir = tmpOrchDir(); });
  afterEach(() => { try { rmSync(orchDir, { recursive: true, force: true }); } catch {} });

  it("writes .escalations/<T>.json with required fields on first call", () => {
    const now = "2026-08-05T10:00:00Z";
    recordDurableEscalation({
      orchDir,
      ticket: "CTL-1643",
      phase: "implement",
      reason: "no-progress",
      labelConfirmed: false,
      source: "scheduler",
      now,
    });
    const rec = JSON.parse(readFileSync(escalationPath(orchDir, "CTL-1643"), "utf8"));
    expect(rec.ticket).toBe("CTL-1643");
    expect(rec.phase).toBe("implement");
    expect(rec.reason).toBe("no-progress");
    expect(rec.labelConfirmed).toBe(false);
    expect(rec.labelAttempts).toBe(1);
    expect(rec.escalatedAt).toBe(now);
    expect(rec.source).toBe("scheduler");
  });

  it("a second call with labelConfirmed:false increments labelAttempts and preserves escalatedAt", () => {
    const t1 = "2026-08-05T10:00:00Z";
    const t2 = "2026-08-05T10:10:00Z";
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: t1 });
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: t2 });
    const rec = JSON.parse(readFileSync(escalationPath(orchDir, "CTL-1643"), "utf8"));
    expect(rec.labelAttempts).toBe(2);
    expect(rec.escalatedAt).toBe(t1); // preserved from first call
    expect(rec.lastTs).toBe(t2);
  });

  it("a call with labelConfirmed:true sets the flag and does NOT increment labelAttempts", () => {
    const t1 = "2026-08-05T10:00:00Z";
    const t2 = "2026-08-05T10:10:00Z";
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: t1 });
    const rec1 = JSON.parse(readFileSync(escalationPath(orchDir, "CTL-1643"), "utf8"));
    expect(rec1.labelAttempts).toBe(1);
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: true, source: "scheduler", now: t2 });
    const rec2 = JSON.parse(readFileSync(escalationPath(orchDir, "CTL-1643"), "utf8"));
    expect(rec2.labelConfirmed).toBe(true);
    expect(rec2.labelAttempts).toBe(1); // did NOT increment
  });

  it("returns the written record (so callers can read labelAttempts)", () => {
    const rec = recordDurableEscalation({
      orchDir,
      ticket: "CTL-1643",
      phase: "implement",
      reason: "no-progress",
      labelConfirmed: false,
      source: "scheduler",
      now: "2026-08-05T10:00:00Z",
    });
    expect(rec.labelAttempts).toBe(1);
    expect(rec.ticket).toBe("CTL-1643");
  });

  it("the record survives removal of workers/<T>/ (GC-survival guarantee)", () => {
    const workerDir = join(orchDir, "workers", "CTL-1643");
    mkdirSync(workerDir, { recursive: true });
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    rmSync(workerDir, { recursive: true, force: true });
    // record still readable
    expect(existsSync(escalationPath(orchDir, "CTL-1643"))).toBe(true);
    const rec = JSON.parse(readFileSync(escalationPath(orchDir, "CTL-1643"), "utf8"));
    expect(rec.ticket).toBe("CTL-1643");
  });

  it("never throws — a failed write (unwritable dir) is a silent no-op", () => {
    // Pass a completely invalid path; must not throw.
    expect(() => {
      recordDurableEscalation({
        orchDir: "/dev/null/cannot-exist",
        ticket: "CTL-1643",
        phase: "implement",
        reason: "no-progress",
        labelConfirmed: false,
        source: "scheduler",
        now: "2026-08-05T10:00:00Z",
      });
    }).not.toThrow();
  });
});

// ─── readDurableEscalations ──────────────────────────────────────────────────

describe("readDurableEscalations — directory scan", () => {
  let orchDir;
  beforeEach(() => { orchDir = tmpOrchDir(); });
  afterEach(() => { try { rmSync(orchDir, { recursive: true, force: true }); } catch {} });

  it("returns all non-empty, parseable records from .escalations/", () => {
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    recordDurableEscalation({ orchDir, ticket: "CTL-1644", phase: "triage", reason: "busy-ceiling-exceeded", labelConfirmed: true, source: "scheduler", now: "2026-08-05T11:00:00Z" });
    const recs = readDurableEscalations(orchDir);
    expect(recs).toHaveLength(2);
    const ids = recs.map((r) => r.ticket).sort();
    expect(ids).toEqual(["CTL-1643", "CTL-1644"]);
  });

  it("absent or empty .escalations/ → [] (never throws)", () => {
    expect(readDurableEscalations(orchDir)).toEqual([]);
    // non-existent orchDir also safe
    expect(readDurableEscalations("/tmp/nonexistent-ctl1643-orch")).toEqual([]);
  });

  it("malformed JSON files are skipped (fail-open)", () => {
    const dir = join(orchDir, ".escalations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CTL-9999.json"), "not-json{{{{");
    // Write a good one
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    const recs = readDurableEscalations(orchDir);
    expect(recs).toHaveLength(1);
    expect(recs[0].ticket).toBe("CTL-1643");
  });

  it("labelConfirmed:false records surface identically to labelConfirmed:true", () => {
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    recordDurableEscalation({ orchDir, ticket: "CTL-1644", phase: "triage", reason: "no-progress", labelConfirmed: true, source: "scheduler", now: "2026-08-05T11:00:00Z" });
    const recs = readDurableEscalations(orchDir);
    expect(recs).toHaveLength(2);
    // both present — the board surfaces them regardless of label confirmation
  });
});

// ─── forgetDurableEscalation ─────────────────────────────────────────────────

describe("forgetDurableEscalation — removal", () => {
  let orchDir;
  beforeEach(() => { orchDir = tmpOrchDir(); });
  afterEach(() => { try { rmSync(orchDir, { recursive: true, force: true }); } catch {} });

  it("removes the .escalations/<T>.json file", () => {
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    expect(existsSync(escalationPath(orchDir, "CTL-1643"))).toBe(true);
    forgetDurableEscalation(orchDir, "CTL-1643");
    expect(existsSync(escalationPath(orchDir, "CTL-1643"))).toBe(false);
  });

  it("after removal, readDurableEscalations yields no entry for the ticket", () => {
    recordDurableEscalation({ orchDir, ticket: "CTL-1643", phase: "implement", reason: "no-progress", labelConfirmed: false, source: "scheduler", now: "2026-08-05T10:00:00Z" });
    recordDurableEscalation({ orchDir, ticket: "CTL-1644", phase: "triage", reason: "busy-ceiling-exceeded", labelConfirmed: true, source: "scheduler", now: "2026-08-05T11:00:00Z" });
    forgetDurableEscalation(orchDir, "CTL-1643");
    const recs = readDurableEscalations(orchDir);
    expect(recs.map((r) => r.ticket)).toEqual(["CTL-1644"]);
  });

  it("is idempotent — calling on an already-absent record never throws", () => {
    expect(() => forgetDurableEscalation(orchDir, "CTL-9999")).not.toThrow();
    expect(() => forgetDurableEscalation("/tmp/nonexistent-ctl1643-orch", "CTL-9999")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-2159 — the durable store is a per-ticket escalation ARTIFACT in its own
// right. board-data.mjs renders every record as `attention:"needs-human"` with a
// humanQuestion, on both the merge and the synthesis path. Deleting the Linear
// label while leaving this untouched would have moved the artifact one layer
// down, not removed it: a provider outage across N tickets still lighting N
// human cards.
// ─────────────────────────────────────────────────────────────────────────────
describe("CTL-2159 — records carry the stall class, and SYSTEM/MOOT are not human-facing", () => {
  let orchDir;
  beforeEach(() => { orchDir = tmpOrchDir(); });
  afterEach(() => { rmSync(orchDir, { recursive: true, force: true }); });

  it("DERIVES the class from the reason so no writer can forget it", () => {
    // Three writers feed this store (recovery.mjs, fence-standoff.mjs,
    // stale-pr-rescue-timer.mjs) and none of them passed a class.
    const rec = recordDurableEscalation({
      orchDir, ticket: "CTL-2159A", phase: "implement",
      reason: "unresolvable-conflict", labelConfirmed: true, source: "stale-pr-rescue",
      now: "2026-08-21T10:00:00Z",
    });
    expect(rec.stallClass).toBe("system");
    expect(isHumanFacingEscalationRecord(rec)).toBe(false);
    expect(readDurableEscalations(orchDir)[0].stallClass).toBe("system");
  });

  it("POSITIVE CONTROL: an unclassifiable reason is HELD and IS human-facing", () => {
    // The zero above must be a verdict, not the predicate answering false for
    // everything. HELD means "a person must look" — it still lights a card.
    const rec = recordDurableEscalation({
      orchDir, ticket: "CTL-2159B", phase: "implement",
      reason: "something-nobody-classified", labelConfirmed: true, source: "scheduler",
      now: "2026-08-21T10:00:00Z",
    });
    expect(rec.stallClass).toBe("held");
    expect(isHumanFacingEscalationRecord(rec)).toBe(true);
  });

  it("an explicit class from the caller wins, and survives an upsert", () => {
    recordDurableEscalation({
      orchDir, ticket: "CTL-2159C", phase: "implement", reason: "no-progress",
      labelConfirmed: false, source: "scheduler", now: "2026-08-21T10:00:00Z",
      stallClass: "ask",
    });
    const again = recordDurableEscalation({
      orchDir, ticket: "CTL-2159C", phase: "implement", reason: "no-progress",
      labelConfirmed: true, source: "scheduler", now: "2026-08-21T10:05:00Z",
    });
    expect(again.stallClass).toBe("ask");
  });

  it("FAIL-OPEN: a legacy record with no class at all is still human-facing", () => {
    // Records written before this field existed must not silently vanish from the
    // board — an absence of evidence is not a SYSTEM verdict.
    expect(isHumanFacingEscalationRecord({ ticket: "CTL-1", reason: "x" })).toBe(true);
    expect(isHumanFacingEscalationRecord(null)).toBe(true);
  });
});
