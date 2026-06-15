// reclaim-shadow.test.mjs — CTL-935 Phase 3: reclaim-verdict / R4-R7 shadow
// comparator.  Tests pure compareReclaim + readReclaimBeliefs + the per-tick
// driver makeReclaimShadowRecorder.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import {
  compareReclaim,
  readReclaimBeliefs,
  makeReclaimShadowRecorder,
} from "./reclaim-shadow.mjs";

const NOW = 1781030108000;
const HOUR = 3_600_000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-reclaim-"));
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

function tick(host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [NOW, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function signal(tickId, ticket, phase, status, opts = {}) {
  db.run(
    "INSERT INTO obs_signal (tick_id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [tickId, ticket, phase, status, opts.bg_job_id ?? null, opts.generation ?? null, opts.started_at_ms ?? null, opts.updated_at_ms ?? null],
  );
}
function agent(tickId, sessId, shortId, opts = {}) {
  db.run(
    "INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [tickId, sessId, shortId, opts.kind ?? "background", opts.status ?? null, opts.state ?? null, opts.started_at_ms ?? null],
  );
}
function job(tickId, bgId, opts = {}) {
  db.run(
    "INSERT INTO obs_job (tick_id, bg_job_id, state, tempo, first_terminal_at, exists_flag) VALUES (?, ?, ?, ?, ?, ?)",
    [tickId, bgId, opts.state ?? null, opts.tempo ?? null, opts.first_terminal_at ?? null, opts.exists_flag ?? 1],
  );
}

function seedBelief(tickId, name, subject, value, ruleId) {
  db.run(
    "INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids) VALUES (?, 2, ?, ?, ?, ?, '[]')",
    [tickId, name, subject, value !== undefined ? JSON.stringify(value) : null, ruleId],
  );
}

describe("compareReclaim — pure attribution", () => {
  test("alive-suppressed vs worker_dead → disagreement guard=alive-suppressed rule_id=R7", () => {
    const rec = compareReclaim({ outcome: "alive-suppressed", beliefVerdict: "worker_dead" });
    expect(rec).not.toBeNull();
    expect(rec.legacyGuard).toBe("alive-suppressed");
    expect(rec.ruleId).toBe("R7");
    expect(rec.agree).toBe(false);
  });

  test("alive-suppressed vs lease_expired → disagreement guard=alive-suppressed rule_id=R6", () => {
    const rec = compareReclaim({ outcome: "alive-suppressed", beliefVerdict: "lease_expired" });
    expect(rec).not.toBeNull();
    expect(rec.ruleId).toBe("R6");
  });

  test("alive-suppressed vs lease_valid → null (agreement — both say alive)", () => {
    expect(compareReclaim({ outcome: "alive-suppressed", beliefVerdict: "lease_valid" })).toBeNull();
  });

  test("wedged-redispatched vs wedged_never_started → null (R4 direct analog)", () => {
    expect(compareReclaim({ outcome: "wedged-redispatched", beliefVerdict: "wedged_never_started" })).toBeNull();
  });

  test("wedged-redispatched vs lease_valid → disagreement guard=wedged-redispatched rule_id=R4", () => {
    const rec = compareReclaim({ outcome: "wedged-redispatched", beliefVerdict: "lease_valid" });
    expect(rec).not.toBeNull();
    expect(rec.legacyGuard).toBe("wedged-redispatched");
    expect(rec.ruleId).toBe("R4");
  });

  test("reclaimed vs worker_dead → null (both dead)", () => {
    expect(compareReclaim({ outcome: "reclaimed", beliefVerdict: "worker_dead" })).toBeNull();
  });

  test("terminal-short-circuit → guard-only-no-rule, rule_id null, agree false (not a disagreement)", () => {
    const rec = compareReclaim({ outcome: "terminal-short-circuit", beliefVerdict: "worker_dead" });
    expect(rec).not.toBeNull();
    expect(rec.guardOnlyNoRule).toBe(true);
    expect(rec.ruleId).toBeNull();
    expect(rec.agree).toBe(false);
  });

  test("superseded-noop → guard-only-no-rule", () => {
    const rec = compareReclaim({ outcome: "superseded-noop", beliefVerdict: "lease_valid" });
    expect(rec).not.toBeNull();
    expect(rec.guardOnlyNoRule).toBe(true);
    expect(rec.ruleId).toBeNull();
  });

  test("rate-limited-deferred → guard-only-no-rule", () => {
    expect(compareReclaim({ outcome: "rate-limited-deferred", beliefVerdict: "worker_dead" }).guardOnlyNoRule).toBe(true);
  });

  test("escalation-suppressed → guard-only-no-rule", () => {
    expect(compareReclaim({ outcome: "escalation-suppressed", beliefVerdict: "lease_valid" }).guardOnlyNoRule).toBe(true);
  });

  test("noop vs lease_valid → null (agreement — no action expected)", () => {
    expect(compareReclaim({ outcome: "noop", beliefVerdict: "lease_valid" })).toBeNull();
  });

  test("noop vs absent belief (null) → null (no belief, no action)", () => {
    expect(compareReclaim({ outcome: "noop", beliefVerdict: null })).toBeNull();
  });
});

describe("readReclaimBeliefs — R4-R7 precedence reduction", () => {
  test("returns Map keyed by ticket/phase with belief verdict for each", () => {
    const t = tick();
    signal(t, "CTL-1", "plan", "running", { bg_job_id: "aaa", started_at_ms: NOW - 9 * HOUR });
    agent(t, "aaa-sid", "aaa", { kind: "background", state: "blocked" });
    job(t, "aaa", { state: "working", tempo: "blocked" });
    // No transcript → wedged_never_started (R4) fires
    evaluateBeliefs(db, t);
    const beliefs = readReclaimBeliefs(db, t);
    expect(beliefs instanceof Map).toBe(true);
    // CTL-1/plan should have a verdict
    expect(beliefs.has("CTL-1/plan")).toBe(true);
    // wedged (R4) is the most severe; check it's mapped
    const v = beliefs.get("CTL-1/plan");
    expect(["wedged_never_started", "worker_dead", "lease_expired", "lease_valid"].includes(v)).toBe(true);
  });

  test("worker_dead takes precedence over lease_expired (both fired for same subject)", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-2/plan", null, "R7");
    seedBelief(t, "lease_expired", "CTL-2/plan", null, "R6");
    const beliefs = readReclaimBeliefs(db, t);
    expect(beliefs.get("CTL-2/plan")).toBe("worker_dead");
  });

  test("wedged_never_started takes highest precedence", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-3/plan", null, "R7");
    seedBelief(t, "wedged_never_started", "CTL-3/plan", null, "R4");
    seedBelief(t, "lease_expired", "CTL-3/plan", null, "R6");
    const beliefs = readReclaimBeliefs(db, t);
    expect(beliefs.get("CTL-3/plan")).toBe("wedged_never_started");
  });

  test("returns empty Map on null db/tickId", () => {
    expect(readReclaimBeliefs(null, 1).size).toBe(0);
    expect(readReclaimBeliefs(db, null).size).toBe(0);
  });
});

describe("makeReclaimShadowRecorder — per-tick driver", () => {
  test("writes agree=0 + disagree event for alive-suppressed vs worker_dead (scenario 2)", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-657/implement", null, "R7");
    const events = [];
    const written = [];
    const recorder = makeReclaimShadowRecorder(db, t, {
      appendEvent: (e) => events.push(e),
      writeComparison: (rec) => written.push(rec),
    });
    recorder(new Map([["CTL-657/implement", "alive-suppressed"]]));
    expect(events.filter((e) => e["event.name"] === "beliefs.reclaim_shadow.disagree")).toHaveLength(1);
    expect(written).toHaveLength(1);
    const w = written[0];
    expect(w.agree).toBe(0);
    expect(w.dimension).toBe("reclaim");
    expect(w.subject).toBe("CTL-657/implement");
    expect(w.legacyGuard).toBe("alive-suppressed");
    expect(w.ruleId).toBe("R7");
    expect(JSON.parse(w.differingInput).legacyGuard).toBe("alive-suppressed");
    expect(JSON.parse(w.differingInput).beliefVerdict).toBe("worker_dead");
  });

  test("writes agree=1 and no disagree event for reclaimed vs worker_dead (agreement)", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-1/plan", null, "R7");
    const events = [];
    const written = [];
    const recorder = makeReclaimShadowRecorder(db, t, {
      appendEvent: (e) => events.push(e),
      writeComparison: (rec) => written.push(rec),
    });
    recorder(new Map([["CTL-1/plan", "reclaimed"]]));
    expect(events.filter((e) => e["event.name"] === "beliefs.reclaim_shadow.disagree")).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0].agree).toBe(1);
  });

  test("per-subject isolation: a throwing belief read skips that subject, rest are compared", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-OK/plan", null, "R7");
    const written = [];
    const recorder = makeReclaimShadowRecorder(db, t, {
      writeComparison: (rec) => written.push(rec),
    });
    // CTL-BAD has no belief (null beliefVerdict); CTL-OK has worker_dead
    recorder(new Map([["CTL-BAD/plan", "reclaimed"], ["CTL-OK/plan", "reclaimed"]]));
    // CTL-OK: reclaimed vs worker_dead → agree=1
    expect(written.filter((w) => w.subject === "CTL-OK/plan")).toHaveLength(1);
    expect(written.find((w) => w.subject === "CTL-OK/plan").agree).toBe(1);
  });

  test("raw guard identity preserved: guard='alive-suppressed' not coarsened to a bucket", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-X/implement", null, "R7");
    const written = [];
    const recorder = makeReclaimShadowRecorder(db, t, { writeComparison: (r) => written.push(r) });
    recorder(new Map([["CTL-X/implement", "alive-suppressed"]]));
    expect(written[0].legacyGuard).toBe("alive-suppressed");
  });

  test("guard-only-no-rule subjects are written but not counted as disagreements", () => {
    const t = tick();
    const events = [];
    const written = [];
    const recorder = makeReclaimShadowRecorder(db, t, {
      appendEvent: (e) => events.push(e),
      writeComparison: (r) => written.push(r),
    });
    recorder(new Map([["CTL-Y/plan", "terminal-short-circuit"]]));
    // terminal-short-circuit → guard-only-no-rule: written but no disagree event
    expect(written).toHaveLength(1);
    expect(written[0].guardOnlyNoRule).toBe(true);
    expect(events.filter((e) => e["event.name"] === "beliefs.reclaim_shadow.disagree")).toHaveLength(0);
  });

  test("a throwing writeComparison does NOT abort the recorder (shadow contract)", () => {
    const t = tick();
    seedBelief(t, "worker_dead", "CTL-Z/plan", null, "R7");
    expect(() => {
      const recorder = makeReclaimShadowRecorder(db, t, {
        writeComparison: () => { throw new Error("boom"); },
      });
      recorder(new Map([["CTL-Z/plan", "alive-suppressed"]]));
    }).not.toThrow();
  });

  test("null db / null tickId returns a no-op recorder without throwing", () => {
    expect(() => {
      const r1 = makeReclaimShadowRecorder(null, 1, {});
      r1(new Map([["CTL-1/plan", "reclaimed"]]));
      const r2 = makeReclaimShadowRecorder(db, null, {});
      r2(new Map([["CTL-1/plan", "reclaimed"]]));
    }).not.toThrow();
  });
});
