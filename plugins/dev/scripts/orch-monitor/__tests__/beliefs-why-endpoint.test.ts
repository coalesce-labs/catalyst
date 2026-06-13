// CTL-1100 Phase 4: GET /api/beliefs/why?ticket=&tick=
// HTTP integration tests; backed-by-code deep-equal test.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// ─── helpers ────────────────────────────────────────────────────────────────

async function seedBeliefDbAsync(dbPath: string): Promise<{ tickId: number }> {
  const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
  const { openBeliefsDb } = await import(schemaSpecifier) as {
    openBeliefsDb: (opts: { path: string }) => Database;
  };
  const db = openBeliefsDb({ path: dbPath });
  db.run("INSERT INTO tick (now_ms, host) VALUES (1000, 'h1')");
  const tickId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.run(
    `INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
     VALUES (?, 1, 'session_registered', 'CTL-1234/plan', NULL, 'R1', '[]')`,
    [tickId],
  );
  db.close();
  return { tickId };
}

// ─── Seeded server ─────────────────────────────────────────────────────────

let seededServer: ReturnType<typeof createServer>;
let seededUrl: string;
let seededDir: string;
let seededTickId: number;

beforeAll(async () => {
  seededDir = mkdtempSync(join(tmpdir(), "beliefs-why-seeded-"));
  const dbPath = join(seededDir, "catalyst.db");
  const beliefPath = join(seededDir, "beliefs.db");
  const { tickId } = await seedBeliefDbAsync(beliefPath);
  seededTickId = tickId;
  seededServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath,
    wtDir: seededDir,
    beliefStoreDbPath: beliefPath,
  });
  seededUrl = `http://localhost:${seededServer.port}`;
});

afterAll(() => {
  void seededServer?.stop(true);
  try { rmSync(seededDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Absent db server ──────────────────────────────────────────────────────

let absentServer: ReturnType<typeof createServer>;
let absentUrl: string;
let absentDir: string;

beforeAll(() => {
  absentDir = mkdtempSync(join(tmpdir(), "beliefs-why-absent-"));
  const dbPath = join(absentDir, "catalyst.db");
  absentServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath,
    wtDir: absentDir,
    beliefStoreDbPath: join(absentDir, "nonexistent.db"), // absent
  });
  absentUrl = `http://localhost:${absentServer.port}`;
});

afterAll(() => {
  void absentServer?.stop(true);
  try { rmSync(absentDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 1. Seeded belief → 200 with full trace ─────────────────────────────────

describe("GET /api/beliefs/why — seeded db", () => {
  it("seeded belief → 200, ticket/tickId/beliefs present", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-1234`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string; tickId: number; beliefs: Array<{ rule_id: string; subject: string; name: string; sources: unknown[] }> };
    expect(body.ticket).toBe("CTL-1234");
    expect(body.tickId).not.toBeNull();
    expect(body.beliefs.length).toBeGreaterThan(0);
    expect(body.beliefs[0]?.rule_id).toBe("R1");
    expect(body.beliefs[0]?.subject).toBe("CTL-1234/plan");
    expect(body.beliefs[0]?.name).toBe("session_registered");
    expect(Array.isArray(body.beliefs[0]?.sources)).toBe(true);
  });

  // ─── 2. Explicit tick= honored ───────────────────────────────────────────

  it("explicit &tick= honored, correct tickId returned", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-1234&tick=${seededTickId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tickId: number; beliefs: unknown[] };
    expect(body.tickId).toBe(seededTickId);
    expect(body.beliefs.length).toBe(1);
  });

  it("&tick=999999 (no rows) → 200 beliefs:[] (not 404)", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-1234&tick=999999`);
    expect(res.status).toBe(200);
    const body = await res.json() as { beliefs: unknown[] };
    expect(body.beliefs).toEqual([]);
  });

  // ─── 3. Unknown well-formed ticket → 200 empty ───────────────────────────

  it("unknown well-formed ticket → 200 {ticket, tickId:null, beliefs:[]}", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=ZZZ-999999`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string; tickId: null; beliefs: unknown[] };
    expect(body.ticket).toBe("ZZZ-999999");
    expect(body.tickId).toBeNull();
    expect(body.beliefs).toEqual([]);
  });

  // ─── 4. Input validation → 400 ───────────────────────────────────────────

  it("missing ticket → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why`);
    expect(res.status).toBe(400);
  });

  it("not-a-ticket (no dash) → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=notavalidticket`);
    expect(res.status).toBe(400);
  });

  it("just prefix (CTL only, no number) → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL`);
    expect(res.status).toBe(400);
  });

  it("encoded path traversal ..%2F.. → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=..%2F..`);
    expect(res.status).toBe(400);
  });

  it("non-numeric tick → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-1234&tick=abc`);
    expect(res.status).toBe(400);
  });

  // ─── 5. Absent db → 200 empty, no 500 ────────────────────────────────────

  it("absent beliefs.db → 200 {ticket, tickId:null, beliefs:[]}", async () => {
    const res = await fetch(`${absentUrl}/api/beliefs/why?ticket=CTL-1234`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string; tickId: null; beliefs: unknown[] };
    expect(body.ticket).toBe("CTL-1234");
    expect(body.tickId).toBeNull();
    expect(body.beliefs).toEqual([]);
  });

  // ─── 6. Backed-by-code deep-equal ────────────────────────────────────────

  it("HTTP body deep-equals traceTicket() on same db", async () => {
    const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
    const { openBeliefsDb } = await import(schemaSpecifier) as {
      openBeliefsDb: (opts: { path: string }) => Database;
    };
    const beliefPath = join(seededDir, "beliefs.db");
    const db = openBeliefsDb({ path: beliefPath });
    const whySpecifier = ["../../execution-core/beliefs/why.mjs"].join("");
    const { traceTicket } = await import(whySpecifier) as {
      traceTicket: (db: Database, ticket: string, opts?: { tickId?: number }) => unknown;
    };
    const expected = JSON.parse(JSON.stringify(traceTicket(db, "CTL-1234")));
    db.close();

    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-1234`);
    const actual = await res.json();
    expect(actual).toEqual(expected);
  });
});
