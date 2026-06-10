// intent.test.mjs — CTL-936: closed-loop intent layer.
//
// TDD: all tests here DEFINE the contract before the implementation.
// Frozen time (now is a passed constant, never Date.now()), injected fakes,
// in-memory beliefs.db via openBeliefsDb.
//
// Test coverage:
//   1. recordIntent — inserts with correct schema
//   2. hasOpenIntent — open/satisfied/absent discrimination
//   3. resolvePostcondition (via reconcileIntents) — all four kinds
//   4. reconcileIntents marks satisfied when world changed
//   5. reconcileIntents increments attempts + retries when not satisfied
//   6. reconcileIntents marks ineffective at maxAttempts (the R11 keystone):
//      simulate the 8h kill-storm and prove it stops after 2 attempts +
//      emits the operator event instead of looping
//   7. mirror read-back mismatch → retry then satisfied on convergence
//   8. label failure → operator event not silent skip (enforce=true)
//   9. terminal-Done exempt (mirror kind)
//  10. isIntentEffective guard
//  11. getMaxAttempts reads cfg or defaults

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import {
  recordIntent,
  hasOpenIntent,
  reconcileIntents,
  isIntentEffective,
  getMaxAttempts,
} from "./intent.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────
const NOW = 1_781_030_108_000; // 2026-06-09T18:35:08Z (frozen)
const TICKET = "CTL-722";
const PHASE = "implement";
const SUBJECT_KILL = `${TICKET}/${PHASE}`;
const SHORT_ID = "bg-abc123";
const SESSION_ID = "5ad5c1ff-1111-2222-3333-444455556666";

// ── Scratch dirs (cleanup) ────────────────────────────────────────────────────
const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl936-intent-"));
  tmps.push(d);
  return d;
}

let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
  // Insert a tick so intent.tick_id FK is valid
  db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (1, ?, 'test-host')", [NOW]);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function allIntents() {
  return db.query("SELECT * FROM intent ORDER BY intent_id").all();
}

// Build a world snapshot that says the kill target is still registered (session
// still in agents listing → postcondition NOT satisfied)
function worldStillRegistered() {
  const m = new Map();
  m.set(SUBJECT_KILL, { session_id: SESSION_ID, short_id: SHORT_ID });
  return { agentsBySubject: m };
}

// Build a world snapshot where the session is gone (kill satisfied)
function worldSessionGone() {
  const m = new Map(); // subject absent → null
  return { agentsBySubject: m };
}

// ── 1. recordIntent inserts correct schema ────────────────────────────────────
describe("recordIntent", () => {
  test("inserts with correct fields and open outcome", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });
    expect(typeof id).toBe("number");
    const row = db.query("SELECT * FROM intent WHERE intent_id = ?").get(id);
    expect(row.tick_id).toBe(1);
    expect(row.kind).toBe("kill");
    expect(row.subject).toBe(SUBJECT_KILL);
    expect(row.outcome).toBeNull();
    expect(row.attempts).toBe(0);
    const pc = JSON.parse(row.postcondition);
    expect(pc.kind).toBe("kill");
    expect(pc.subject).toBe(SUBJECT_KILL);
  });

  test("records beliefId when provided", () => {
    // Insert a stub belief
    db.run(
      "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 1, 'test', 'CTL-722/implement', 'R1', '[]')",
    );
    const beliefId = db.query("SELECT last_insert_rowid() AS id").get().id;
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
      beliefId,
    });
    const row = db.query("SELECT belief_id FROM intent WHERE intent_id = ?").get(id);
    expect(row.belief_id).toBe(beliefId);
  });
});

// ── 2. hasOpenIntent ──────────────────────────────────────────────────────────
describe("hasOpenIntent", () => {
  test("returns false when no intent exists", () => {
    expect(hasOpenIntent(db, "kill", SUBJECT_KILL)).toBe(false);
  });

  test("returns true for an open intent", () => {
    recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    expect(hasOpenIntent(db, "kill", SUBJECT_KILL)).toBe(true);
  });

  test("returns false when the intent is satisfied", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    db.run("UPDATE intent SET outcome = 'satisfied' WHERE intent_id = ?", [id]);
    expect(hasOpenIntent(db, "kill", SUBJECT_KILL)).toBe(false);
  });

  test("returns false when the intent is ineffective", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    db.run("UPDATE intent SET outcome = 'ineffective' WHERE intent_id = ?", [id]);
    expect(hasOpenIntent(db, "kill", SUBJECT_KILL)).toBe(false);
  });
});

// ── 3. reconcileIntents marks satisfied when world changed ────────────────────
describe("reconcileIntents — satisfied path", () => {
  test("kill intent satisfied when session leaves agents listing", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });

    const result = reconcileIntents(db, 1, worldSessionGone(), { maxAttempts: 2, enforce: false });
    expect(result.satisfied).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.ineffective).toBe(0);

    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
  });

  test("mirror intent satisfied when Linear state matches wantState", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "mirror",
      subject: TICKET,
      postcondition: { kind: "mirror", subject: TICKET, wantState: "Implement" },
    });

    const linearMap = new Map([[TICKET, "Implement"]]);
    const result = reconcileIntents(
      db,
      1,
      { linearStateByTicket: linearMap },
      { maxAttempts: 2, enforce: false },
    );
    expect(result.satisfied).toBe(1);
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
  });

  test("label intent satisfied when label is present on ticket", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "label",
      subject: TICKET,
      postcondition: { kind: "label", subject: TICKET, label: "needs-human", present: true },
    });

    const labelsMap = new Map([[TICKET, new Set(["needs-human", "orchestrator"])]]);
    const result = reconcileIntents(
      db,
      1,
      { labelsByTicket: labelsMap },
      { maxAttempts: 2, enforce: false },
    );
    expect(result.satisfied).toBe(1);
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
  });
});

// ── 4. reconcileIntents increments attempts when unsatisfied ──────────────────
describe("reconcileIntents — retry path", () => {
  test("increments attempts on each unsatisfied tick (below maxAttempts)", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });

    // First tick: still registered → retry
    reconcileIntents(db, 1, worldStillRegistered(), { maxAttempts: 3, enforce: false });
    const r1 = db.query("SELECT attempts, outcome FROM intent WHERE intent_id = ?").get(id);
    expect(r1.attempts).toBe(1);
    expect(r1.outcome).toBeNull(); // still open

    // Second tick: still registered → retry again
    reconcileIntents(db, 1, worldStillRegistered(), { maxAttempts: 3, enforce: false });
    const r2 = db.query("SELECT attempts, outcome FROM intent WHERE intent_id = ?").get(id);
    expect(r2.attempts).toBe(2);
    expect(r2.outcome).toBeNull();
  });

  test("satisfied after retry — outcome flips on convergence", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });

    // Tick 1: not satisfied (session still listed)
    reconcileIntents(db, 1, worldStillRegistered(), { maxAttempts: 3, enforce: false });
    // Tick 2: satisfied (session gone)
    const result = reconcileIntents(db, 1, worldSessionGone(), { maxAttempts: 3, enforce: false });
    expect(result.satisfied).toBe(1);
    const row = db.query("SELECT outcome, attempts FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
    expect(row.attempts).toBe(1); // incremented once, then satisfied
  });
});

// ── 5. THE KEYSTONE: kill-storm simulation ────────────────────────────────────
// Simulate the 8h stop-storm scenario: daemon issues `claude stop` N times
// against a session that never leaves the agents listing. After maxAttempts
// the intent is marked ineffective, an operator event is emitted, and the
// channel stops being retried.
describe("reconcileIntents — ineffective escalation (stop-storm keystone)", () => {
  test("marks ineffective after maxAttempts and emits operator event (enforce=true)", () => {
    const events = [];
    const appendEvent = (evt) => events.push(evt);

    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });

    // Tick 1: attempt 1 — session still listed, below maxAttempts=2
    const r1 = reconcileIntents(db, 1, worldStillRegistered(), {
      maxAttempts: 2,
      enforce: true,
      appendEvent,
      now: NOW,
    });
    expect(r1.retried).toBe(1);
    expect(r1.ineffective).toBe(0);
    expect(events).toHaveLength(0); // not yet ineffective
    const after1 = db.query("SELECT attempts, outcome FROM intent WHERE intent_id = ?").get(id);
    expect(after1.attempts).toBe(1);
    expect(after1.outcome).toBeNull();

    // Tick 2: attempt 2 — still listed, reaches maxAttempts → ineffective
    const r2 = reconcileIntents(db, 1, worldStillRegistered(), {
      maxAttempts: 2,
      enforce: true,
      appendEvent,
      now: NOW,
    });
    expect(r2.ineffective).toBe(1);
    expect(r2.retried).toBe(0);
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt["event.name"]).toBe("intent.ineffective");
    expect(evt.payload.kind).toBe("kill");
    expect(evt.payload.subject).toBe(SUBJECT_KILL);
    expect(evt.payload.attempts).toBe(2);

    const after2 = db.query("SELECT attempts, outcome FROM intent WHERE intent_id = ?").get(id);
    expect(after2.outcome).toBe("ineffective");

    // Tick 3: intent is already closed — reconcile sees no open intents
    const r3 = reconcileIntents(db, 1, worldStillRegistered(), {
      maxAttempts: 2,
      enforce: true,
      appendEvent,
      now: NOW,
    });
    expect(r3.satisfied).toBe(0);
    expect(r3.retried).toBe(0);
    expect(r3.ineffective).toBe(0);
    // NO third stop issued — the storm is broken
    expect(events).toHaveLength(1); // still only one event
  });

  test("shadow mode: marks ineffective but does NOT call appendEvent (enforce=false)", () => {
    const events = [];
    const appendEvent = (evt) => events.push(evt);

    recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL, sessionNotRegistered: true },
    });

    // Run twice to exhaust attempts
    reconcileIntents(db, 1, worldStillRegistered(), { maxAttempts: 2, enforce: false, appendEvent });
    const r2 = reconcileIntents(db, 1, worldStillRegistered(), {
      maxAttempts: 2,
      enforce: false,
      appendEvent,
    });
    expect(r2.ineffective).toBe(1);
    // Shadow: appendEvent NOT called
    expect(events).toHaveLength(0);
  });
});

// ── 6. mirror read-back mismatch → retry then satisfied ───────────────────────
describe("mirror intent lifecycle", () => {
  test("retries on mismatch, satisfied on convergence", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "mirror",
      subject: TICKET,
      postcondition: { kind: "mirror", subject: TICKET, wantState: "Implement" },
    });

    // Tick 1: Linear still says "Todo" → retry
    const r1 = reconcileIntents(
      db,
      1,
      { linearStateByTicket: new Map([[TICKET, "Todo"]]) },
      { maxAttempts: 3, enforce: false },
    );
    expect(r1.retried).toBe(1);

    // Tick 2: Linear now says "Implement" → satisfied
    const r2 = reconcileIntents(
      db,
      1,
      { linearStateByTicket: new Map([[TICKET, "Implement"]]) },
      { maxAttempts: 3, enforce: false },
    );
    expect(r2.satisfied).toBe(1);

    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
  });

  test("terminal Done is exempt — treated as satisfied (no backward write)", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "mirror",
      subject: TICKET,
      postcondition: { kind: "mirror", subject: TICKET, wantState: "Implement" },
    });

    // Linear shows "Done" → exempt, postcondition is satisfied (no re-write)
    const result = reconcileIntents(
      db,
      1,
      { linearStateByTicket: new Map([[TICKET, "Done"]]) },
      { maxAttempts: 2, enforce: false },
    );
    expect(result.satisfied).toBe(1);
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBe("satisfied");
  });
});

// ── 7. label failure → operator event not silent skip ─────────────────────────
describe("label intent — operator visibility", () => {
  test("emits operator event when label write is ineffective (enforce=true)", () => {
    const events = [];
    const appendEvent = (evt) => events.push(evt);

    recordIntent(db, {
      tickId: 1,
      kind: "label",
      subject: TICKET,
      postcondition: { kind: "label", subject: TICKET, label: "needs-human", present: true },
    });

    // Tick 1: label not on ticket → retry
    reconcileIntents(
      db,
      1,
      { labelsByTicket: new Map([[TICKET, new Set()]]) },
      { maxAttempts: 2, enforce: true, appendEvent },
    );
    expect(events).toHaveLength(0);

    // Tick 2: still not on ticket → ineffective → operator event
    reconcileIntents(
      db,
      1,
      { labelsByTicket: new Map([[TICKET, new Set()]]) },
      { maxAttempts: 2, enforce: true, appendEvent },
    );
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("intent.ineffective");
    expect(events[0].payload.kind).toBe("label");
    expect(events[0].payload.subject).toBe(TICKET);
  });

  test("silent skip in shadow mode (enforce=false)", () => {
    const events = [];
    const appendEvent = (evt) => events.push(evt);

    recordIntent(db, {
      tickId: 1,
      kind: "label",
      subject: TICKET,
      postcondition: { kind: "label", subject: TICKET, label: "needs-human", present: true },
    });

    reconcileIntents(
      db,
      1,
      { labelsByTicket: new Map([[TICKET, new Set()]]) },
      { maxAttempts: 2, enforce: false, appendEvent },
    );
    reconcileIntents(
      db,
      1,
      { labelsByTicket: new Map([[TICKET, new Set()]]) },
      { maxAttempts: 2, enforce: false, appendEvent },
    );
    // Shadow: event NOT emitted
    expect(events).toHaveLength(0);
  });
});

// ── 8. isIntentEffective guard ────────────────────────────────────────────────
describe("isIntentEffective", () => {
  test("returns true when no intent exists (channel viable)", () => {
    expect(isIntentEffective(db, "kill", SUBJECT_KILL, { maxAttempts: 2 })).toBe(true);
  });

  test("returns true when intent is open and below maxAttempts", () => {
    recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    expect(isIntentEffective(db, "kill", SUBJECT_KILL, { maxAttempts: 2 })).toBe(true);
  });

  test("returns false when intent outcome='ineffective'", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    db.run("UPDATE intent SET outcome = 'ineffective' WHERE intent_id = ?", [id]);
    expect(isIntentEffective(db, "kill", SUBJECT_KILL, { maxAttempts: 2 })).toBe(false);
  });

  test("returns false when intent is open but attempts >= maxAttempts (in-flight ineffective)", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    db.run("UPDATE intent SET attempts = 2 WHERE intent_id = ?", [id]);
    expect(isIntentEffective(db, "kill", SUBJECT_KILL, { maxAttempts: 2 })).toBe(false);
  });

  test("returns true when intent is satisfied (channel worked, no suppression needed)", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    db.run("UPDATE intent SET outcome = 'satisfied' WHERE intent_id = ?", [id]);
    expect(isIntentEffective(db, "kill", SUBJECT_KILL, { maxAttempts: 2 })).toBe(true);
  });
});

// ── 9. getMaxAttempts ─────────────────────────────────────────────────────────
describe("getMaxAttempts", () => {
  test("reads from cfg when present", () => {
    db.run("INSERT OR REPLACE INTO cfg (key, value_int) VALUES ('max_attempts', 5)");
    expect(getMaxAttempts(db)).toBe(5);
  });

  test("defaults to 2 when cfg row absent", () => {
    db.run("DELETE FROM cfg WHERE key = 'max_attempts'");
    expect(getMaxAttempts(db)).toBe(2);
  });
});

// ── 10. Multiple intents — only open ones are reconciled ─────────────────────
describe("reconcileIntents — multi-intent isolation", () => {
  test("satisfied intent is not re-evaluated in subsequent ticks", () => {
    const id1 = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: "CTL-001/implement",
      postcondition: { kind: "kill", subject: "CTL-001/implement" },
    });
    const id2 = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: "CTL-002/implement",
      postcondition: { kind: "kill", subject: "CTL-002/implement" },
    });

    // Satisfy id1
    db.run("UPDATE intent SET outcome = 'satisfied' WHERE intent_id = ?", [id1]);

    // Only id2 is open; worldSessionGone → both subjects absent → id2 satisfies
    const result = reconcileIntents(db, 1, worldSessionGone(), { maxAttempts: 2, enforce: false });
    expect(result.satisfied).toBe(1); // only id2
    expect(result.retried).toBe(0);
  });

  test("different kinds for same subject are independent", () => {
    const kill_id = recordIntent(db, {
      tickId: 1,
      kind: "kill",
      subject: SUBJECT_KILL,
      postcondition: { kind: "kill", subject: SUBJECT_KILL },
    });
    const mirror_id = recordIntent(db, {
      tickId: 1,
      kind: "mirror",
      subject: TICKET,
      postcondition: { kind: "mirror", subject: TICKET, wantState: "Implement" },
    });

    // kill: session gone → satisfied; mirror: Linear still "Todo" → retry
    const result = reconcileIntents(
      db,
      1,
      {
        agentsBySubject: new Map(), // no sessions
        linearStateByTicket: new Map([[TICKET, "Todo"]]),
      },
      { maxAttempts: 3, enforce: false },
    );
    expect(result.satisfied).toBe(1);
    expect(result.retried).toBe(1);

    const k = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(kill_id);
    expect(k.outcome).toBe("satisfied");
    const m = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(mirror_id);
    expect(m.outcome).toBeNull();
  });
});

// ── 11. label intent with unreadable labels (null) stays open ─────────────────
describe("unreadable world facts", () => {
  test("mirror: null linearState → intent stays open (retry)", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "mirror",
      subject: TICKET,
      postcondition: { kind: "mirror", subject: TICKET, wantState: "Implement" },
    });

    // linearCache returned null this tick
    const result = reconcileIntents(
      db,
      1,
      { linearStateByTicket: new Map([[TICKET, null]]) },
      { maxAttempts: 3, enforce: false },
    );
    expect(result.retried).toBe(1);
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBeNull();
  });

  test("label: ticket absent from labelsByTicket → intent stays open", () => {
    const id = recordIntent(db, {
      tickId: 1,
      kind: "label",
      subject: TICKET,
      postcondition: { kind: "label", subject: TICKET, label: "needs-human", present: true },
    });

    const result = reconcileIntents(
      db,
      1,
      { labelsByTicket: new Map() }, // TICKET absent
      { maxAttempts: 3, enforce: false },
    );
    expect(result.retried).toBe(1);
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(id);
    expect(row.outcome).toBeNull();
  });
});
