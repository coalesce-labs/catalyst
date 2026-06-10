// collector-relation.test.mjs — CTL-964 belief-store Step 2: obs_relation fact
// layer. Verifies the obs_relation collection block in collector.mjs against
// known relation descriptors: edge normalization, insert-only semantics,
// retention pruning.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { collectTickFacts, __resetBeliefsCollectorForTests } from "./collector.mjs";

const DAY = 86_400_000;
const NOW = 1781030108000; // 2026-06-09T18:35:08Z (same anchor as collector.test.mjs)

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl964-relation-"));
  tmps.push(d);
  return d;
}
beforeEach(() => __resetBeliefsCollectorForTests());
afterEach(() => {
  __resetBeliefsCollectorForTests();
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Minimal two-ticket signal fixture: CTL-100 and CTL-200 both in-flight.
function twoSignals() {
  return [
    {
      ticket: "CTL-100",
      phase: "implement",
      status: "running",
      liveness: { kind: "bg", value: "aaa1" },
      updatedAt: "2026-06-09T10:00:00Z",
      raw: { generation: 1, startedAt: "2026-06-09T09:00:00Z" },
    },
    {
      ticket: "CTL-200",
      phase: "research",
      status: "running",
      liveness: { kind: "bg", value: "bbb2" },
      updatedAt: "2026-06-09T11:00:00Z",
      raw: { generation: 1, startedAt: "2026-06-09T10:00:00Z" },
    },
  ];
}

// Base collect helper — injects a minimal db + env with shadow enabled.
function collect(db, relationsMap, signalOverride, extraOverrides = {}) {
  return collectTickFacts({
    db,
    now: NOW,
    host: "mini",
    env: { CATALYST_BELIEFS_SHADOW: "1" },
    eventLogPath: join(scratch(), "absent.jsonl"),
    getAgents: () => [],
    readSignals: signalOverride ?? twoSignals,
    readJobState: () => ({ exists: false }),
    findTranscriptFn: () => null,
    linearCache: {
      get: () => undefined,
      // getRelations returns the descriptor for the ticket, or undefined.
      getRelations: (ticket) => relationsMap?.[ticket] ?? undefined,
    },
    ...extraOverrides,
  });
}

// Build canonical edge set by hand for assertions.
// Format: { source, target, type } sorted for stable comparison.
function edgeKey(e) {
  return `${e.source_ticket}|${e.target_ticket}|${e.relation_type}`;
}

describe("obs_relation — schema (CTL-964 §1)", () => {
  test("obs_relation table and indexes are created by openBeliefsDb", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("obs_relation");

    const cols = db.query("PRAGMA table_info(obs_relation)").all().map((r) => r.name);
    expect(cols).toEqual([
      "fact_id",
      "tick_id",
      "source_ticket",
      "target_ticket",
      "relation_type",
    ]);

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_obs_relation_tick");
    expect(indexes).toContain("idx_obs_relation_source");

    // FK: tick_id → tick(tick_id)
    const fks = db.query("PRAGMA foreign_key_list(obs_relation)").all();
    expect(fks.length).toBe(1);
    expect(fks[0].table).toBe("tick");
    expect(fks[0].from).toBe("tick_id");

    db.close();
  });
});

describe("obs_relation — edge normalization (CTL-964 §2)", () => {
  test("relations.nodes type='blocks' → (source=ticket, target=peer, 'blocks')", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // CTL-100 blocks CTL-200 via relations.nodes
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation ORDER BY source_ticket").all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_ticket).toBe("CTL-100");
    expect(rows[0].target_ticket).toBe("CTL-200");
    expect(rows[0].relation_type).toBe("blocks");
    db.close();
  });

  test("relations.nodes type='blocked_by' → swap: (source=peer, target=ticket, 'blocks')", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // CTL-100 is blocked_by CTL-200 → canonical: CTL-200 blocks CTL-100
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_ticket).toBe("CTL-200"); // swapped
    expect(rows[0].target_ticket).toBe("CTL-100");
    expect(rows[0].relation_type).toBe("blocks");
    // 'blocked_by' must NEVER appear as a stored relation_type
    const types = db.query("SELECT DISTINCT relation_type FROM obs_relation").all().map((r) => r.relation_type);
    expect(types).not.toContain("blocked_by");
    db.close();
  });

  test("inverseRelations.nodes type='blocks' → (source=peer, target=ticket, 'blocks')", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // CTL-200 has inverseRelations: CTL-100 blocks CTL-200
    const relMap = {
      "CTL-200": {
        relations: { nodes: [] },
        inverseRelations: {
          nodes: [{ type: "blocks", issue: { identifier: "CTL-100" } }],
        },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_ticket).toBe("CTL-100");
    expect(rows[0].target_ticket).toBe("CTL-200");
    expect(rows[0].relation_type).toBe("blocks");
    db.close();
  });

  test("inverseRelations.nodes type='blocked_by' → (source=ticket, target=peer, 'blocks')", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // CTL-200 has inverseRelation: blocked_by CTL-100 → CTL-200 blocks CTL-100
    const relMap = {
      "CTL-200": {
        relations: { nodes: [] },
        inverseRelations: {
          nodes: [{ type: "blocked_by", issue: { identifier: "CTL-100" } }],
        },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_ticket).toBe("CTL-200");
    expect(rows[0].target_ticket).toBe("CTL-100");
    expect(rows[0].relation_type).toBe("blocks");
    db.close();
  });

  test("relations.nodes type='related' → stored as-is (source=ticket, target=peer, 'related')", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "related", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_ticket).toBe("CTL-100");
    expect(rows[0].target_ticket).toBe("CTL-200");
    expect(rows[0].relation_type).toBe("related");
    db.close();
  });

  test("relations.nodes type='duplicate' → stored as-is", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "duplicate", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1);
    expect(rows[0].relation_type).toBe("duplicate");
    db.close();
  });

  test("nodes with missing peer identifier are skipped", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [
            { type: "blocks", relatedIssue: { identifier: null } },     // null id
            { type: "blocks", relatedIssue: {} },                        // missing id
            { type: "blocks", relatedIssue: { identifier: "CTL-200" } }, // valid
          ],
        },
        inverseRelations: {
          nodes: [
            { type: "blocks", issue: { identifier: null } },  // null id
            { type: "blocks", issue: {} },                     // missing id
          ],
        },
      },
    };
    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT * FROM obs_relation").all();
    expect(rows.length).toBe(1); // only the valid edge
    expect(rows[0].source_ticket).toBe("CTL-100");
    expect(rows[0].target_ticket).toBe("CTL-200");
    db.close();
  });

  test("multi-ticket multi-edge fixture — full canonical edge set matches hand-computed expectation", () => {
    // CTL-100 blocks CTL-200 (via relations.nodes blocks)
    // CTL-100 is blocked_by CTL-200 (same as above from the other direction — deduplication not
    //   required at this layer, but inverseRelations on CTL-200 records CTL-100 blocks CTL-200 too)
    // CTL-200 has inverseRelations: CTL-100 blocks CTL-200 (same canonical edge)
    // We explicitly test ALL four normalization paths using two separate tickets.
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    const relMap = {
      "CTL-100": {
        // CTL-100 → blocks CTL-200 (canonical: CTL-100 blocks CTL-200)
        // CTL-100 → blocked_by CTL-200 (canonical: CTL-200 blocks CTL-100) — same pair, opposite
        relations: {
          nodes: [
            { type: "blocks",     relatedIssue: { identifier: "CTL-200" } },
            { type: "blocked_by", relatedIssue: { identifier: "CTL-200" } },
          ],
        },
        inverseRelations: { nodes: [] },
      },
      "CTL-200": {
        relations: { nodes: [] },
        // inverseRelations: CTL-100 blocks CTL-200 (via 'blocks')
        // inverseRelations: CTL-200 blocked_by CTL-100 → CTL-200 blocks CTL-100
        inverseRelations: {
          nodes: [
            { type: "blocks",     issue: { identifier: "CTL-100" } },
            { type: "blocked_by", issue: { identifier: "CTL-100" } },
          ],
        },
      },
    };

    const res = collect(db, relMap);
    expect(res.ok).toBe(true);

    const rows = db.query("SELECT source_ticket, target_ticket, relation_type FROM obs_relation ORDER BY source_ticket, target_ticket").all();
    // Expected canonical edges:
    //   CTL-100 blocks CTL-200 (from relations.nodes type=blocks on CTL-100)
    //   CTL-200 blocks CTL-100 (from relations.nodes type=blocked_by on CTL-100)
    //   CTL-100 blocks CTL-200 (from inverseRelations.nodes type=blocks on CTL-200)
    //   CTL-200 blocks CTL-100 (from inverseRelations.nodes type=blocked_by on CTL-200)
    // All four normalization paths produce exactly 4 rows (insert-only, no dedup).
    expect(rows.length).toBe(4);

    const keys = rows.map(edgeKey).sort();
    // Two rows: CTL-100 blocks CTL-200, and two: CTL-200 blocks CTL-100.
    const expected = [
      "CTL-100|CTL-200|blocks",
      "CTL-100|CTL-200|blocks",
      "CTL-200|CTL-100|blocks",
      "CTL-200|CTL-100|blocks",
    ].sort();
    expect(keys).toEqual(expected);
    db.close();
  });
});

describe("obs_relation — no cache / null cache behavior (CTL-964 §2)", () => {
  test("getRelations returns undefined → no obs_relation rows this tick (cold cache)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // linearCache with getRelations returning undefined for all tickets
    const res = collect(db, {});
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_relation").get().n).toBe(0);
    db.close();
  });

  test("linearCache has no getRelations method → no obs_relation rows", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collectTickFacts({
      db,
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      getAgents: () => [],
      readSignals: twoSignals,
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      linearCache: { get: () => undefined }, // no getRelations method
    });
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_relation").get().n).toBe(0);
    db.close();
  });

  test("no linearCache wired → no obs_relation rows", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collectTickFacts({
      db,
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      getAgents: () => [],
      readSignals: twoSignals,
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      // no linearCache
    });
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_relation").get().n).toBe(0);
    db.close();
  });

  test("getRelations throws → relations error recorded; tick and other sources still commit", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collectTickFacts({
      db,
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      getAgents: () => [],
      readSignals: twoSignals,
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      linearCache: {
        get: () => undefined,
        getRelations: () => { throw new Error("relations exploded"); },
      },
    });
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(1);
    const errSources = (res.errors ?? []).map((e) => e.source);
    expect(errSources).toContain("relations");
    db.close();
  });
});

describe("obs_relation — insert-only semantics (CTL-964 §2)", () => {
  test("second tick with identical relations appends new rows (different tick_id), does not mutate prior rows", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };

    // Tick 1
    const r1 = collect(db, relMap);
    expect(r1.ok).toBe(true);
    const tickId1 = r1.tickId;

    // Tick 2 — same relations
    const r2 = collect(db, relMap, () => twoSignals(), { now: NOW + 60_000 });
    expect(r2.ok).toBe(true);
    const tickId2 = r2.tickId;

    expect(tickId1).not.toBe(tickId2);

    const rows = db.query("SELECT fact_id, tick_id, source_ticket, target_ticket, relation_type FROM obs_relation ORDER BY tick_id").all();
    // Two rows: one per tick, same edge, different tick_id
    expect(rows.length).toBe(2);
    expect(rows[0].tick_id).toBe(tickId1);
    expect(rows[1].tick_id).toBe(tickId2);
    expect(rows[0].source_ticket).toBe("CTL-100");
    expect(rows[0].target_ticket).toBe("CTL-200");
    expect(rows[1].source_ticket).toBe("CTL-100");
    expect(rows[1].target_ticket).toBe("CTL-200");

    // Prior rows have NOT been mutated — fact_ids are stable and strictly ascending
    // (auto-increment insert-only: row inserted in tick 1 has a lower fact_id than tick 2)
    expect(rows[0].fact_id).toBeGreaterThan(0);
    expect(rows[1].fact_id).toBeGreaterThan(rows[0].fact_id);
    db.close();
  });
});

describe("obs_relation — per-tick deduplication by seen-set (CTL-964 §2)", () => {
  test("each ticket's relations are read exactly once per tick (seen-set like obs_linear)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    const getCalls = [];
    const relMap = {
      "CTL-100": {
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-200" } }],
        },
        inverseRelations: { nodes: [] },
      },
    };

    // Two signals for the same ticket — should only call getRelations once
    const dupSignals = () => [
      {
        ticket: "CTL-100",
        phase: "research",
        status: "done",
        liveness: { kind: "bg", value: "aaa1" },
        updatedAt: "2026-06-09T09:00:00Z",
        raw: { generation: 1, startedAt: "2026-06-09T08:00:00Z" },
      },
      {
        ticket: "CTL-100",
        phase: "implement",
        status: "running",
        liveness: { kind: "bg", value: "bbb2" },
        updatedAt: "2026-06-09T10:00:00Z",
        raw: { generation: 2, startedAt: "2026-06-09T09:00:00Z" },
      },
    ];

    const res = collectTickFacts({
      db,
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      getAgents: () => [],
      readSignals: dupSignals,
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      linearCache: {
        get: () => undefined,
        getRelations: (ticket) => {
          getCalls.push(ticket);
          return relMap[ticket] ?? undefined;
        },
      },
    });

    expect(res.ok).toBe(true);
    // CTL-100 appears twice in signals but getRelations must be called once
    expect(getCalls.filter((t) => t === "CTL-100").length).toBe(1);
    // One edge row (CTL-100 blocks CTL-200) recorded once
    expect(db.query("SELECT COUNT(*) AS n FROM obs_relation").get().n).toBe(1);
    db.close();
  });
});

describe("obs_relation — pruneRetention (CTL-964 §3)", () => {
  test("pruneRetention drops obs_relation rows older than 14-day window", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    // Manually insert: old tick (15d ago) with an obs_relation row, and a fresh tick.
    const oldNow = NOW - 15 * DAY;
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (1, ?, 'mini')", [oldNow]);
    db.run(
      "INSERT INTO obs_relation (tick_id, source_ticket, target_ticket, relation_type) VALUES (1, 'CTL-100', 'CTL-200', 'blocks')",
    );

    // Run a current tick with pruneEveryTicks=1 so prune fires immediately.
    const res = collect(db, {}, undefined, { pruneEveryTicks: 1 });
    expect(res.ok).toBe(true);

    // The old obs_relation row should be pruned.
    const oldRows = db
      .query("SELECT * FROM obs_relation WHERE tick_id = 1")
      .all();
    expect(oldRows.length).toBe(0);

    db.close();
  });

  test("pruneRetention keeps obs_relation rows within the 14-day window", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    // Insert a tick only 1d old with an obs_relation row.
    const recentNow = NOW - 1 * DAY;
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (1, ?, 'mini')", [recentNow]);
    db.run(
      "INSERT INTO obs_relation (tick_id, source_ticket, target_ticket, relation_type) VALUES (1, 'CTL-100', 'CTL-200', 'blocks')",
    );

    const res = collect(db, {}, undefined, { pruneEveryTicks: 1 });
    expect(res.ok).toBe(true);

    // The recent obs_relation row must survive.
    const recentRows = db
      .query("SELECT * FROM obs_relation WHERE tick_id = 1")
      .all();
    expect(recentRows.length).toBe(1);

    db.close();
  });
});
