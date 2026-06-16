// incident-replay.test.mjs — CTL-935 Phase 4: incident replay harness.
// Tests the frozen INCIDENTS fixtures + replayIncident() against fresh in-memory dbs.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { traceTicket } from "./why.mjs";
import { INCIDENTS, replayIncident } from "./incident-replay.mjs";

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-replay-"));
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

// ── INCIDENTS structure ───────────────────────────────────────────────────────

describe("INCIDENTS catalog", () => {
  test("INCIDENTS is frozen and contains exactly the required keys", () => {
    expect(Object.isFrozen(INCIDENTS)).toBe(true);
    const keys = Object.keys(INCIDENTS).sort();
    expect(keys).toEqual(["CTL-604", "CTL-604-cap", "CTL-657", "CTL-722"]);
  });

  test("each INCIDENTS entry has a non-empty expect[] list", () => {
    for (const [id, fixture] of Object.entries(INCIDENTS)) {
      expect(Array.isArray(fixture.expect), `${id}.expect should be array`).toBe(true);
      expect(fixture.expect.length, `${id}.expect should be non-empty`).toBeGreaterThan(0);
    }
  });
});

// ── CTL-722 — wedge fleet ─────────────────────────────────────────────────────

describe("replayIncident — CTL-722 (wedge fleet)", () => {
  test("passed=true; wedged_never_started(CTL-722/plan) R4 + wake_diagnostician reason='never-started' R10; worker_dead ABSENT", () => {
    const result = replayIncident(db, INCIDENTS["CTL-722"]);
    expect(result.passed).toBe(true);
    expect(result.id).toBe("CTL-722");

    const wd = result.beliefs.find((b) => b.name === "wedged_never_started" && b.subject === "CTL-722/plan");
    expect(wd).toBeTruthy();
    expect(wd.rule_id).toBe("R4");

    const wk = result.beliefs.find((b) => b.name === "wake_diagnostician" && b.subject === "CTL-722/plan");
    expect(wk).toBeTruthy();
    expect(wk.rule_id).toBe("R10");
    expect(JSON.parse(wk.value).reason).toBe("never-started");

    const workerDead = result.beliefs.filter((b) => b.name === "worker_dead");
    expect(workerDead).toHaveLength(0);
  });

  test("free_slots(host:mini) by_lease=6, by_session_cap=9, free_slots=6 (one wedged agent in session, no valid lease)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-722"]);
    expect(result.passed).toBe(true);
    const fs = result.beliefs.find((b) => b.name === "free_slots" && b.subject === "host:mini");
    expect(fs).toBeTruthy();
    const v = JSON.parse(fs.value);
    expect(v.by_lease).toBe(6);
    expect(v.by_session_cap).toBe(9);
    expect(v.free_slots).toBe(6);
    expect(v.lease_valid_count).toBe(0);
    expect(v.bg_session_count).toBe(1);
  });

  test("CTL-722 provenance chain: b3 ← b2 ← b1 (traceTicket returns non-empty)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-722"]);
    expect(result.passed).toBe(true);
    const trace = traceTicket(db, "CTL-722", { tickId: result.tickId });
    expect(trace).toBeTruthy();
    expect(Array.isArray(trace.beliefs)).toBe(true);
    expect(trace.beliefs.length).toBeGreaterThan(0);
  });
});

// ── CTL-657 — over-spawn ──────────────────────────────────────────────────────

describe("replayIncident — CTL-657 (over-spawn)", () => {
  test("passed=true; worker_dead fires for all 6 over-spawn subjects (R7, first_terminal_at)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-657"]);
    expect(result.passed).toBe(true);
    const deadBeliefs = result.beliefs.filter((b) => b.name === "worker_dead");
    expect(deadBeliefs).toHaveLength(6);
    for (const b of deadBeliefs) {
      expect(b.rule_id).toBe("R7");
    }
  });

  test("lease_valid and lease_expired have ZERO rows (worker_dead suppresses both)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-657"]);
    expect(result.passed).toBe(true);
    expect(result.beliefs.filter((b) => b.name === "lease_valid")).toHaveLength(0);
    expect(result.beliefs.filter((b) => b.name === "lease_expired")).toHaveLength(0);
  });

  test("free_slots present: lease_valid_count=0 and free_slots=4 despite 6 listed agents (R8 counts leases, not agents)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-657"]);
    expect(result.passed).toBe(true);
    const fs = result.beliefs.find((b) => b.name === "free_slots" && b.subject === "host:mini");
    expect(fs).toBeTruthy();
    const v = JSON.parse(fs.value);
    expect(v.lease_valid_count).toBe(0);
    expect(v.bg_session_count).toBe(6);
    expect(v.by_lease).toBe(6);
    expect(v.by_session_cap).toBe(4);
    expect(v.free_slots).toBe(4);
  });
});

// ── CTL-604 — orphan takeover / advancement FSM ───────────────────────────────

describe("replayIncident — CTL-604 (advancement FSM — verify→remediate)", () => {
  test("passed=true; advance_to(CTL-604) value.to='remediate' (R16 arm A, remediate_count=0 < cap 3)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-604"]);
    expect(result.passed).toBe(true);
    const at = result.beliefs.find((b) => b.name === "advance_to" && b.subject === "CTL-604");
    expect(at).toBeTruthy();
    expect(at.rule_id).toBe("R16");
    const v = JSON.parse(at.value);
    expect(v.to).toBe("remediate");
  });

  test("cycle_exhausted ABSENT (remediate_count=0)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-604"]);
    expect(result.passed).toBe(true);
    const ce = result.beliefs.find((b) => b.name === "cycle_exhausted" && b.subject === "CTL-604");
    expect(ce).toBeUndefined();
  });

  test("CTL-604-cap: remediate_count=3 → advance_to ABSENT; cycle_exhausted present (R17)", () => {
    const result = replayIncident(db, INCIDENTS["CTL-604-cap"]);
    expect(result.passed).toBe(true);
    const at = result.beliefs.find((b) => b.name === "advance_to" && b.subject === "CTL-604");
    expect(at).toBeUndefined();
    const ce = result.beliefs.find((b) => b.name === "cycle_exhausted" && b.subject === "CTL-604");
    expect(ce).toBeTruthy();
    expect(ce.rule_id).toBe("R17");
  });
});

// ── determinism + no-live-IO ──────────────────────────────────────────────────

describe("replayIncident — determinism and safety", () => {
  test("same fixture over two fresh dbs yields identical belief name/subject/rule_id sets", () => {
    const db2Path = join(scratch(), "b2.db");
    const db2 = openBeliefsDb({ path: db2Path });
    try {
      const r1 = replayIncident(db, INCIDENTS["CTL-722"]);
      const r2 = replayIncident(db2, INCIDENTS["CTL-722"]);
      const toKey = (b) => `${b.name}/${b.subject}/${b.rule_id ?? ""}`;
      const keys1 = r1.beliefs.map(toKey).sort();
      const keys2 = r2.beliefs.map(toKey).sort();
      expect(keys1).toEqual(keys2);
    } finally {
      try { db2.close(); } catch { /* */ }
    }
  });

  test("replayIncident with a fixture that can never pass returns passed=false (not a throw)", () => {
    const badFixture = {
      id: "never-passes",
      title: "Always-fail fixture",
      nowMs: 1781030108000,
      seed: () => {},
      expect: [{ name: "worker_dead", subject: "CTL-FAKE/plan", present: true }],
    };
    let result;
    expect(() => { result = replayIncident(db, badFixture); }).not.toThrow();
    expect(result.passed).toBe(false);
  });

  test("checks array contains one entry per expect item with name, subject, pass", () => {
    const result = replayIncident(db, INCIDENTS["CTL-722"]);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBe(INCIDENTS["CTL-722"].expect.length);
    for (const chk of result.checks) {
      expect(typeof chk.name).toBe("string");
      expect(typeof chk.pass).toBe("boolean");
    }
  });
});
