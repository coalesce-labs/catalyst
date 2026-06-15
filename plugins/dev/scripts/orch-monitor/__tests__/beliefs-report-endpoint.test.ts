// CTL-935 Phase 5: GET /api/beliefs/report
// Integration tests mirroring beliefs-read-endpoints.test.ts pattern.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// ─── helpers ────────────────────────────────────────────────────────────────

function insertTick(db: Database, nowMs: number, host = "h1"): number {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [nowMs, host]);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

function insertComparison(
  db: Database,
  tickId: number,
  opts: {
    dimension?: string;
    subject?: string;
    agree?: number;
    legacy_guard?: string | null;
    rule_id?: string | null;
    procedural?: string | null;
    belief?: string | null;
  } = {},
): void {
  const {
    dimension = "reclaim",
    subject = "CTL-1/implement",
    agree = 1,
    legacy_guard = "reclaimed",
    rule_id = "R4",
    procedural = "worker_dead",
    belief = "worker_dead",
  } = opts;
  db.run(
    `INSERT OR IGNORE INTO shadow_comparison
      (tick_id, dimension, subject, agree, procedural, belief, legacy_guard, rule_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tickId, dimension, subject, agree, procedural, belief, legacy_guard, rule_id],
  );
}

// ─── seeded server fixtures ─────────────────────────────────────────────────

let seededServer: ReturnType<typeof createServer>;
let seededUrl: string;
let seededDir: string;

let absentServer: ReturnType<typeof createServer>;
let absentUrl: string;
let absentDir: string;

beforeAll(async () => {
  // Seeded: beliefs.db with tick + shadow_comparison rows
  seededDir = mkdtempSync(join(tmpdir(), "beliefs-report-seeded-"));
  const seededCatalystDb = join(seededDir, "catalyst.db");
  const seededBeliefPath = join(seededDir, "beliefs.db");

  const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
  const { openBeliefsDb } = await import(schemaSpecifier) as {
    openBeliefsDb: (opts: { path: string }) => Database;
  };

  const bdb = openBeliefsDb({ path: seededBeliefPath });
  const NOW = Date.now(); // must be within the default 7-day window
  const t1 = insertTick(bdb, NOW);
  // One agree + one disagree row so the report has non-trivial perRule/perGuard.
  insertComparison(bdb, t1, { agree: 1, legacy_guard: "reclaimed", rule_id: "R4" });
  insertComparison(bdb, t1, {
    subject: "CTL-2/implement",
    agree: 0,
    legacy_guard: "wedged-redispatched",
    rule_id: "R4",
    procedural: "worker_dead",
    belief: "lease_valid",
  });
  bdb.close();

  seededServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath: seededCatalystDb,
    wtDir: seededDir,
    annotationsDbPath: join(seededDir, "annotations.db"),
    beliefStoreDbPath: seededBeliefPath,
  });
  seededUrl = `http://localhost:${seededServer.port}`;

  // Absent: beliefStoreDbPath points to a non-existent file → graceful degradation
  absentDir = mkdtempSync(join(tmpdir(), "beliefs-report-absent-"));
  absentServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath: join(absentDir, "catalyst.db"),
    wtDir: absentDir,
    annotationsDbPath: join(absentDir, "annotations.db"),
    beliefStoreDbPath: join(absentDir, "beliefs.db"), // does NOT exist
  });
  absentUrl = `http://localhost:${absentServer.port}`;
});

afterAll(() => {
  void seededServer?.stop(true);
  void absentServer?.stop(true);
  try { rmSync(seededDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(absentDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── seeded db tests ─────────────────────────────────────────────────────────

describe("GET /api/beliefs/report (seeded db)", () => {
  it("returns 200 with content-type application/json", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("response has {window, perRule, perGuard, replays} top-level keys", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const body = await res.json() as {
      window: unknown;
      perRule: unknown[];
      perGuard: unknown[];
      replays: unknown[];
    };
    expect(body).toHaveProperty("window");
    expect(Array.isArray(body.perRule)).toBe(true);
    expect(Array.isArray(body.perGuard)).toBe(true);
    expect(Array.isArray(body.replays)).toBe(true);
  });

  it("window has sinceMs, nowMs, tickCount, rulesShaSet", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const { window } = await res.json() as {
      window: { sinceMs: number; nowMs: number; tickCount: number; rulesShaSet: string[] };
    };
    expect(typeof window.sinceMs).toBe("number");
    expect(typeof window.nowMs).toBe("number");
    expect(typeof window.tickCount).toBe("number");
    expect(Array.isArray(window.rulesShaSet)).toBe(true);
  });

  it("perGuard always has all 14 canonical guards (LEFT JOIN fill)", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const { perGuard } = await res.json() as {
      perGuard: Array<{ legacy_guard: string; total: number }>;
    };
    expect(perGuard.length).toBe(14);
  });

  it("perRule has R4 row with agree+disagree counts", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const { perRule } = await res.json() as {
      perRule: Array<{ rule_id: string; total: number; agree: number; disagree: number; agreementRate: number | null }>;
    };
    const r4 = perRule.find((r) => r.rule_id === "R4");
    expect(r4).toBeDefined();
    expect(r4!.total).toBe(2);
    expect(r4!.agree).toBe(1);
    expect(r4!.disagree).toBe(1);
  });

  it("replays array has CTL-722, CTL-657, CTL-604 entries", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const { replays } = await res.json() as {
      replays: Array<{ id: string; passed: boolean; checks: unknown[] }>;
    };
    const ids = replays.map((r) => r.id);
    expect(ids).toContain("CTL-722");
    expect(ids).toContain("CTL-657");
    expect(ids).toContain("CTL-604");
  });

  it("incident replays pass (reference fixtures)", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report`);
    const { replays } = await res.json() as {
      replays: Array<{ id: string; passed: boolean }>;
    };
    for (const r of replays) {
      expect(r.passed).toBe(true);
    }
  });

  it("?sinceDays=1 accepted → 200, tickCount reflects window", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report?sinceDays=1`);
    expect(res.status).toBe(200);
    const { window } = await res.json() as { window: { tickCount: number } };
    expect(typeof window.tickCount).toBe("number");
  });

  it("?sinceDays=36500 clamped to 90 → 200", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report?sinceDays=36500`);
    expect(res.status).toBe(200);
  });
});

// ─── validation tests ─────────────────────────────────────────────────────────

describe("GET /api/beliefs/report validation", () => {
  it("?sinceDays=abc → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report?sinceDays=abc`);
    expect(res.status).toBe(400);
  });

  it("?sinceDays=0 → 400 (must be positive)", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report?sinceDays=0`);
    expect(res.status).toBe(400);
  });

  it("?sinceDays=-5 → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/report?sinceDays=-5`);
    expect(res.status).toBe(400);
  });
});

// ─── absent db graceful degradation ──────────────────────────────────────────

describe("GET /api/beliefs/report graceful degradation (absent db)", () => {
  it("returns 200 with empty-but-well-formed report", async () => {
    const res = await fetch(`${absentUrl}/api/beliefs/report`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      window: { tickCount: number; rulesShaSet: string[] };
      perRule: unknown[];
      perGuard: unknown[];
      replays: unknown[];
    };
    expect(body.window.tickCount).toBe(0);
    expect(body.window.rulesShaSet).toEqual([]);
    expect(body.perRule).toEqual([]);
    expect(body.perGuard).toEqual([]);
    expect(Array.isArray(body.replays)).toBe(true);
  });
});
