// recursive-rules.test.mjs — CTL-965 belief-store Step 2: the recursive
// dependency beliefs (R13 blocker_rank, R14 cycle_detected, R15 ready) over the
// obs_relation EDB.
//
// HAND-COMPUTED FIXTURE BATTERY (the core proof). Each test seeds obs_relation
// (and, for `ready`, obs_linear) rows into a fresh in-memory schema under one
// tick, runs evaluateBeliefs, and asserts the derived rows match an
// INDEPENDENTLY HAND-COMPUTED closure written in the comment above each assert.
//
// DIRECTION (the thing that inverts every verdict if wrong): obs_relation is
// canonicalized at ingest to "source BLOCKS target". A blocked ticket depends on
// its blocker, so a stored row obs_relation(source=B, target=A, 'blocks') means
// B blocks A ⇒ A depends_on B ⇒ B is a blocker of A. In the transitive closure
// the DEPENDENT is `target_ticket` and the DEPENDENCY (blocker) is
// `source_ticket`. Topologies below are described as BLOCKING edges "X→Y" = a
// stored row (source=X, target=Y) = "X blocks Y" = "Y depends_on X".
//
// TERMINATION: the closure CTE uses UNION (not UNION ALL); the working set
// dedupes, so cyclic graphs (cases 3 & 4) reach a fixpoint and halt instead of
// looping forever. Cases 3/4 are the proof that recursion terminates.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";

const NOW = 1781030108000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl965-recursive-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
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

// ── fixture builders ─────────────────────────────────────────────────────────
function tick(now = NOW, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
// blockingEdge(src → tgt): src blocks tgt ⇒ tgt depends_on src.
function blockingEdge(tickId, src, tgt) {
  db.run(
    "INSERT INTO obs_relation (tick_id, source_ticket, target_ticket, relation_type) VALUES (?, ?, ?, 'blocks')",
    [tickId, src, tgt],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function relation(tickId, src, tgt, type) {
  db.run(
    "INSERT INTO obs_relation (tick_id, source_ticket, target_ticket, relation_type) VALUES (?, ?, ?, ?)",
    [tickId, src, tgt, type],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function linear(tickId, ticket, state) {
  db.run("INSERT INTO obs_linear (tick_id, ticket, state) VALUES (?, ?, ?)", [tickId, ticket, state]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// ── readers (filter to the named belief at the given tick) ───────────────────
function beliefRows(tickId, name) {
  return db
    .query(
      "SELECT subject, value, rule_id, stratum, source_fact_ids FROM belief WHERE tick_id = ? AND name = ? ORDER BY subject",
    )
    .all(tickId, name);
}
function rankBySubject(tickId) {
  const out = {};
  for (const r of beliefRows(tickId, "blocker_rank")) {
    const v = JSON.parse(r.value);
    out[r.subject] = {
      rank: v.rank,
      direct: [...v.direct].sort(),
      transitive: [...v.transitive].sort(),
    };
  }
  return out;
}
function cycleSubjects(tickId) {
  return beliefRows(tickId, "cycle_detected").map((r) => r.subject);
}
function cycleMembers(tickId, subject) {
  const row = beliefRows(tickId, "cycle_detected").find((r) => r.subject === subject);
  return row ? [...JSON.parse(row.value).members].sort() : null;
}
function readySubjects(tickId) {
  return beliefRows(tickId, "ready").map((r) => r.subject);
}

// ── CASE 1: linear chain  A→B→C→D ────────────────────────────────────────────
// Blocking edges: A blocks B, B blocks C, C blocks D.
// Dependency closure (target depends_on source, transitively):
//   B depends_on {A}              → rank 1, direct [A],     transitive [A]
//   C depends_on {B, A}           → rank 2, direct [B],     transitive [A,B]
//   D depends_on {C, B, A}        → rank 3, direct [C],     transitive [A,B,C]
//   A has NO blocker              → NO blocker_rank row for A
// No node depends on itself → cycle_detected EMPTY.
describe("CTL-965 R13/R14 — case 1: linear chain A→B→C→D", () => {
  test("ranks are 1/2/3, A absent, no cycle", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    blockingEdge(t, "B", "C");
    blockingEdge(t, "C", "D");
    evaluateBeliefs(db, t);

    const ranks = rankBySubject(t);
    expect(Object.keys(ranks).sort()).toEqual(["B", "C", "D"]);
    expect(ranks.B).toEqual({ rank: 1, direct: ["A"], transitive: ["A"] });
    expect(ranks.C).toEqual({ rank: 2, direct: ["B"], transitive: ["A", "B"] });
    expect(ranks.D).toEqual({ rank: 3, direct: ["C"], transitive: ["A", "B", "C"] });

    expect(cycleSubjects(t)).toEqual([]);
  });

  test("blocker_rank carries 'x'-tagged obs_relation provenance", () => {
    const t = tick();
    const e1 = blockingEdge(t, "A", "B"); // direct blocker edge for B
    blockingEdge(t, "B", "C");
    blockingEdge(t, "C", "D");
    evaluateBeliefs(db, t);

    // B's only direct blocker edge is e1 (A blocks B) → provenance ["x<e1>"].
    const bRow = beliefRows(t, "blocker_rank").find((r) => r.subject === "B");
    expect(JSON.parse(bRow.source_fact_ids)).toEqual([`x${e1}`]);
    expect(bRow.stratum).toBe(5);
    expect(bRow.rule_id).toBe("R13");
  });
});

// ── CASE 2: diamond  A→B, A→C, B→D, C→D ──────────────────────────────────────
// Blocking edges: A blocks B, A blocks C, B blocks D, C blocks D.
// Dependency closure:
//   B depends_on {A}              → rank 1, direct [A],       transitive [A]
//   C depends_on {A}              → rank 1, direct [A],       transitive [A]
//   D depends_on {B, C, A}        → rank 3, direct [B,C],     transitive [A,B,C]
//   A has NO blocker              → absent
// Diamond is a DAG — NO node depends on itself → cycle_detected EMPTY (the
// false-cycle guard: two paths to D must NOT manufacture a cycle).
describe("CTL-965 R13/R14 — case 2: diamond (no false cycle)", () => {
  test("D rank 3 via two paths, NO cycle", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    blockingEdge(t, "A", "C");
    blockingEdge(t, "B", "D");
    blockingEdge(t, "C", "D");
    evaluateBeliefs(db, t);

    const ranks = rankBySubject(t);
    expect(Object.keys(ranks).sort()).toEqual(["B", "C", "D"]);
    expect(ranks.B).toEqual({ rank: 1, direct: ["A"], transitive: ["A"] });
    expect(ranks.C).toEqual({ rank: 1, direct: ["A"], transitive: ["A"] });
    expect(ranks.D).toEqual({ rank: 3, direct: ["B", "C"], transitive: ["A", "B", "C"] });

    expect(cycleSubjects(t)).toEqual([]);
  });
});

// ── CASE 3: direct 2-node cycle  A↔B ─────────────────────────────────────────
// Blocking edges: A blocks B, B blocks A.
// Dependency closure (with UNION dedup; (X,X) pairs produced once → terminates):
//   A depends_on {B, A}           → rank 2, direct [B], transitive [A,B]
//   B depends_on {A, B}           → rank 2, direct [A], transitive [A,B]
//   Both A and B depend on themselves → cycle_detected fires for BOTH.
//   cycle members reachable that loop back: {A, B} for each.
describe("CTL-965 R14 — case 3: 2-node cycle A↔B (terminates via UNION)", () => {
  test("both A and B flagged, members {A,B}", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    blockingEdge(t, "B", "A");
    evaluateBeliefs(db, t);

    expect(cycleSubjects(t)).toEqual(["A", "B"]);
    expect(cycleMembers(t, "A")).toEqual(["A", "B"]);
    expect(cycleMembers(t, "B")).toEqual(["A", "B"]);

    // blocker_rank still derives (rank counts the dependency itself in the cycle).
    const ranks = rankBySubject(t);
    expect(ranks.A).toEqual({ rank: 2, direct: ["B"], transitive: ["A", "B"] });
    expect(ranks.B).toEqual({ rank: 2, direct: ["A"], transitive: ["A", "B"] });
  });
});

// ── CASE 4: 4-node cycle  A→B→C→D→A ──────────────────────────────────────────
// Blocking edges: A blocks B, B blocks C, C blocks D, D blocks A.
// Every node transitively reaches every node (incl. itself):
//   each X depends_on {A,B,C,D}   → rank 4, transitive [A,B,C,D]
//   direct blocker of each is its single predecessor:
//     B←A, C←B, D←C, A←D
//   ALL FOUR depend on themselves → cycle_detected fires for A,B,C,D, members
//   {A,B,C,D} for each.
// This is the termination keystone: without UNION dedup the recursion never
// halts. evaluateBeliefs returning at all proves it terminates.
describe("CTL-965 R14 — case 4: 4-node cycle A→B→C→D→A (termination keystone)", () => {
  test("all four flagged, rank 4, terminates", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    blockingEdge(t, "B", "C");
    blockingEdge(t, "C", "D");
    blockingEdge(t, "D", "A");

    const start = Date.now();
    evaluateBeliefs(db, t); // MUST return (does not loop forever)
    expect(Date.now() - start).toBeLessThan(5000);

    expect(cycleSubjects(t)).toEqual(["A", "B", "C", "D"]);
    for (const n of ["A", "B", "C", "D"]) {
      expect(cycleMembers(t, n)).toEqual(["A", "B", "C", "D"]);
    }

    const ranks = rankBySubject(t);
    expect(ranks.A).toEqual({ rank: 4, direct: ["D"], transitive: ["A", "B", "C", "D"] });
    expect(ranks.B).toEqual({ rank: 4, direct: ["A"], transitive: ["A", "B", "C", "D"] });
    expect(ranks.C).toEqual({ rank: 4, direct: ["B"], transitive: ["A", "B", "C", "D"] });
    expect(ranks.D).toEqual({ rank: 4, direct: ["C"], transitive: ["A", "B", "C", "D"] });
  });
});

// ── CASE 5: done-deps-do-not-block ───────────────────────────────────────────
// Blocking edges: X blocks A (X is A's only direct blocker).
// obs_linear: A=Todo (eligible), X=Done (terminal).
// A's only blocker X is terminal → A has NO non-terminal direct blocker → A READY.
// Flip X to "In Progress" (non-terminal) → A NOT ready.
describe("CTL-965 R15 — case 5: done deps do not block", () => {
  test("blocker in Done → dependent is ready", () => {
    const t = tick();
    blockingEdge(t, "X", "A");
    linear(t, "A", "Todo");
    linear(t, "X", "Done");
    evaluateBeliefs(db, t);

    expect(readySubjects(t)).toEqual(["A"]);
    const a = beliefRows(t, "ready").find((r) => r.subject === "A");
    expect(JSON.parse(a.value)).toEqual({ ready: 1 });
  });

  test("blocker In Progress (non-terminal) → dependent NOT ready", () => {
    const t = tick();
    blockingEdge(t, "X", "A");
    linear(t, "A", "Todo");
    linear(t, "X", "In Progress");
    evaluateBeliefs(db, t);

    expect(readySubjects(t)).toEqual([]);
  });

  test("eligible ticket with NO blockers is ready (vacuously)", () => {
    const t = tick();
    linear(t, "Z", "Todo");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toContain("Z");
  });

  test("non-eligible state (Done) is never ready", () => {
    const t = tick();
    linear(t, "Z", "Done");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toEqual([]);
  });

  test("blocker with UNKNOWN obs_linear state does not count as non-terminal (null-is-unreadable)", () => {
    // X blocks A; A=Todo; X has NO obs_linear row this tick → we cannot SEE X is
    // non-terminal, so we do not assert "blocked" from absence → A is ready.
    const t = tick();
    blockingEdge(t, "X", "A");
    linear(t, "A", "Todo");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toContain("A");
  });

  test("Cancelled and Canceled are both terminal", () => {
    const t = tick();
    blockingEdge(t, "X", "A");
    blockingEdge(t, "Y", "A");
    linear(t, "A", "Todo");
    linear(t, "X", "Cancelled");
    linear(t, "Y", "Canceled");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toContain("A");
  });
});

// ── CASE 6: disconnected graph (two islands; ranks independent) ──────────────
// Island 1 blocking edges: A→B→C  →  B dep {A} rank1; C dep {A,B} rank2.
// Island 2 blocking edges: P→Q     →  Q dep {P} rank1.
// No cross-island edge → ranks computed independently, no cycle.
describe("CTL-965 R13 — case 6: disconnected graph, independent ranks", () => {
  test("two islands rank independently", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    blockingEdge(t, "B", "C");
    blockingEdge(t, "P", "Q");
    evaluateBeliefs(db, t);

    const ranks = rankBySubject(t);
    expect(Object.keys(ranks).sort()).toEqual(["B", "C", "Q"]);
    expect(ranks.B).toEqual({ rank: 1, direct: ["A"], transitive: ["A"] });
    expect(ranks.C).toEqual({ rank: 2, direct: ["B"], transitive: ["A", "B"] });
    expect(ranks.Q).toEqual({ rank: 1, direct: ["P"], transitive: ["P"] });
    expect(cycleSubjects(t)).toEqual([]);
  });
});

// ── EDB hygiene: related/duplicate are NOT dependency edges ───────────────────
// Only relation_type='blocks' rows are dependencies. A 'related'/'duplicate'
// row must NOT contribute to blocker_rank, cycle_detected, or ready-blocking.
describe("CTL-965 — related/duplicate are not dependencies", () => {
  test("related edge produces no blocker_rank", () => {
    const t = tick();
    relation(t, "A", "B", "related");
    relation(t, "C", "D", "duplicate");
    evaluateBeliefs(db, t);
    expect(beliefRows(t, "blocker_rank")).toEqual([]);
    expect(cycleSubjects(t)).toEqual([]);
  });

  test("a 'related' peer in a non-terminal state does NOT block readiness", () => {
    // A is eligible; A is 'related' to R (R In Progress) but 'related' is not a
    // blocking dependency → A stays ready.
    const t = tick();
    relation(t, "R", "A", "related");
    linear(t, "A", "Todo");
    linear(t, "R", "In Progress");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toContain("A");
  });
});

// ── sparse obs_linear: ready may be empty, acceptable ─────────────────────────
describe("CTL-965 R15 — sparse obs_linear yields empty ready (acceptable)", () => {
  test("no obs_linear rows → no ready beliefs, no error", () => {
    const t = tick();
    blockingEdge(t, "A", "B");
    evaluateBeliefs(db, t);
    expect(readySubjects(t)).toEqual([]);
    // blocker_rank still derives from obs_relation alone.
    expect(rankBySubject(t).B).toEqual({ rank: 1, direct: ["A"], transitive: ["A"] });
  });
});
