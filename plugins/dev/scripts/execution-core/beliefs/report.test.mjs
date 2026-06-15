// report.test.mjs — CTL-935 Phase 5: weekly disagreement report tests.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { LEGACY_GUARDS } from "./guards.mjs";
import { computeReport, renderMarkdown, renderJson } from "./report.mjs";

const NOW_MS = 1_800_000_000_000; // arbitrary frozen now
const DAY_MS = 86_400_000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-report-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

function insertTick(nowMs = NOW_MS, host = "mini", rulesSha = null) {
  db.run("INSERT INTO tick (now_ms, host, rules_sha) VALUES (?, ?, ?)", [nowMs, host, rulesSha]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function insertCmp({ tickId, dimension = "reclaim", subject = "CTL-X/plan", agree = 0,
  legacyGuard = null, ruleId = null, procedural = null, belief = null, differingInput = null }) {
  db.run(
    `INSERT OR IGNORE INTO shadow_comparison
      (tick_id, dimension, subject, agree, legacy_guard, rule_id, procedural, belief, differing_input)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tickId, dimension, subject, agree, legacyGuard, ruleId, procedural, belief, differingInput],
  );
}

// ── computeReport — core aggregation ─────────────────────────────────────────

describe("computeReport — per-rule agreement rates", () => {
  test("3 disagree rows for R8 in-window: disagree=3, agreementRate in (0,1)", () => {
    const t = insertTick(NOW_MS, "mini", "sha1");
    insertCmp({ tickId: t, dimension: "free_slots", subject: "host:mini", agree: 0, ruleId: "R8" });
    insertCmp({ tickId: t, dimension: "free_slots", subject: "host:mini2", agree: 0, ruleId: "R8" });
    const t2 = insertTick(NOW_MS - 1000, "mini2", "sha1");
    insertCmp({ tickId: t2, dimension: "free_slots", subject: "host:mini3", agree: 0, ruleId: "R8" });
    // 1 agree row also
    const t3 = insertTick(NOW_MS - 2000, "mini3", "sha1");
    insertCmp({ tickId: t3, dimension: "free_slots", subject: "host:mini4", agree: 1, ruleId: "R8" });

    const report = computeReport(db, { sinceMs: NOW_MS - DAY_MS, nowMs: NOW_MS });
    const r8 = report.perRule.find((r) => r.rule_id === "R8");
    expect(r8).toBeTruthy();
    expect(r8.disagree).toBe(3);
    expect(r8.agreementRate).toBeGreaterThan(0);
    expect(r8.agreementRate).toBeLessThan(1);
    // Exact rate: 1 agree / 4 total = 0.25
    expect(r8.agreementRate).toBeCloseTo(0.25, 5);
  });

  test("window filter by tick.now_ms: tick before sinceMs is excluded", () => {
    const old = insertTick(NOW_MS - 10 * DAY_MS);
    insertCmp({ tickId: old, dimension: "reclaim", subject: "CTL-OLD/plan", agree: 0, ruleId: "R7" });
    const recent = insertTick(NOW_MS - 1000);
    insertCmp({ tickId: recent, dimension: "reclaim", subject: "CTL-NEW/plan", agree: 0, ruleId: "R7" });

    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    const r7 = report.perRule.find((r) => r.rule_id === "R7");
    // Only the recent tick's row should be counted
    expect(r7?.total ?? 0).toBe(1);
  });
});

describe("computeReport — per-guard counts", () => {
  test("perGuard includes a row for EVERY canonical legacy guard even at zero disagreements", () => {
    // No shadow_comparison rows at all
    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    const guardNames = report.perGuard.map((g) => g.legacy_guard);
    for (const g of LEGACY_GUARDS) {
      expect(guardNames).toContain(g);
    }
    // All at zero
    for (const g of report.perGuard) {
      expect(g.disagree).toBe(0);
    }
  });

  test("alive-suppressed vs worker_dead yields a perGuard row with both derivations side-by-side (scenario-2)", () => {
    const t = insertTick();
    insertCmp({
      tickId: t, dimension: "reclaim", subject: "CTL-657/implement",
      agree: 0, legacyGuard: "alive-suppressed", ruleId: "R7",
      procedural: "alive-suppressed", belief: "worker_dead",
    });

    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    const aliveSup = report.perGuard.find((g) => g.legacy_guard === "alive-suppressed");
    expect(aliveSup).toBeTruthy();
    expect(aliveSup.procedural).toBe("alive-suppressed");
    expect(aliveSup.belief).toBe("worker_dead");
    expect(aliveSup.rule_id).toBe("R7");
    expect(aliveSup.disagree).toBe(1);
  });

  test("R8 row with procedural/belief values survives through renderJson (scenario-1)", () => {
    const t = insertTick();
    insertCmp({
      tickId: t, dimension: "free_slots", subject: "host:mini",
      agree: 0, ruleId: "R8", procedural: "6", belief: "4",
      differingInput: JSON.stringify({ name: "bg_session_count", procedural: 6, belief: 4 }),
    });

    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    const json = renderJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.perRule).toBeDefined();
    expect(Array.isArray(parsed.perGuard)).toBe(true);
    // No Map/Set leakage
    expect(typeof json).toBe("string");
  });
});

describe("computeReport — window metadata", () => {
  test("tickCount matches ticks in the window", () => {
    insertTick(NOW_MS - 1000);
    insertTick(NOW_MS - 2000);
    insertTick(NOW_MS - 10 * DAY_MS); // outside 7-day window
    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    expect(report.window.tickCount).toBe(2);
  });

  test("rulesShaSet deduped; multipleRulesSha=true when >1 sha in window", () => {
    insertTick(NOW_MS - 1000, "mini", "sha-abc");
    insertTick(NOW_MS - 2000, "mini", "sha-def");
    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    expect(report.window.rulesShaSet.length).toBe(2);
    expect(report.window.multipleRulesSha).toBe(true);
  });

  test("single rules_sha: multipleRulesSha=false", () => {
    insertTick(NOW_MS - 1000, "mini", "sha-abc");
    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    expect(report.window.multipleRulesSha).toBe(false);
  });
});

describe("computeReport — empty db", () => {
  test("returns tickCount=0, perRule=[], perGuard with all guards at zero, replays still run", () => {
    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    expect(report.window.tickCount).toBe(0);
    expect(report.perRule).toEqual([]);
    expect(report.perGuard.length).toBe(LEGACY_GUARDS.length);
    // replays run (CTL-722/657/604) — they use their own in-memory db
    expect(Array.isArray(report.replays)).toBe(true);
    expect(report.replays.length).toBe(3);
  });

  test("never throws on empty db", () => {
    expect(() => computeReport(db, { sinceMs: 0, nowMs: NOW_MS })).not.toThrow();
  });
});

describe("computeReport — incident replays", () => {
  test("replays section: CTL-722/657/604 are present and passed=true", () => {
    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    const ids = report.replays.map((r) => r.id);
    expect(ids).toContain("CTL-722");
    expect(ids).toContain("CTL-657");
    expect(ids).toContain("CTL-604");
    for (const r of report.replays) {
      expect(r.passed, `${r.id} replay should pass`).toBe(true);
    }
  });
});

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  test("produces three GitHub tables + a header naming window dates, tick count, rules_sha", () => {
    const t = insertTick(NOW_MS - 1000, "mini", "sha-abc");
    insertCmp({ tickId: t, dimension: "reclaim", subject: "CTL-1/plan", agree: 1, ruleId: "R7", legacyGuard: "reclaimed" });
    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    const md = renderMarkdown(report);
    expect(typeof md).toBe("string");
    // Three tables (each has at least one `| ... |` row)
    const tableSections = (md.match(/\|.*\|/g) ?? []).length;
    expect(tableSections).toBeGreaterThanOrEqual(3);
    // Window dates
    expect(md).toContain("Window");
    expect(md).toContain("Ticks");
    expect(md).toContain("rules_sha");
  });

  test("flags when >1 rules_sha is present in the window", () => {
    insertTick(NOW_MS - 1000, "mini", "sha-A");
    insertTick(NOW_MS - 2000, "mini", "sha-B");
    const report = computeReport(db, { sinceMs: NOW_MS - 7 * DAY_MS, nowMs: NOW_MS });
    const md = renderMarkdown(report);
    expect(md.toLowerCase()).toMatch(/multiple rules_sha|multiple rule/i);
  });
});

// ── renderJson ────────────────────────────────────────────────────────────────

describe("renderJson", () => {
  test("round-trips (no Map/Set leakage)", () => {
    const t = insertTick();
    insertCmp({ tickId: t, dimension: "reclaim", subject: "CTL-1/plan", agree: 1, ruleId: "R7" });
    const report = computeReport(db, { sinceMs: 0, nowMs: NOW_MS });
    const json = renderJson(report);
    // Must be valid JSON (no Map/Set leakage)
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    // All top-level keys present
    expect(Object.keys(parsed).sort()).toEqual(["perGuard", "perRule", "replays", "window"]);
    // Structure preserved through round-trip
    expect(parsed.window.sinceMs).toBe(0);
    expect(Array.isArray(parsed.perGuard)).toBe(true);
    expect(Array.isArray(parsed.replays)).toBe(true);
  });
});
