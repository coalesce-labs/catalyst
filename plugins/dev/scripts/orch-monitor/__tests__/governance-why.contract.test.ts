// governance-why.contract.test.ts — CTL-1100 Phase 7
// Contract: GET /api/beliefs/why HTTP body deep-equals traceTicket() on the
// same beliefs.db. Any divergence between HTTP wrapper and the CLI function
// must turn this suite red.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// ─── helpers ────────────────────────────────────────────────────────────────

async function seedBeliefDb(dbPath: string): Promise<{ tickId: number }> {
  const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
  const { openBeliefsDb } = await import(schemaSpecifier) as {
    openBeliefsDb: (opts: { path: string }) => Database;
  };
  const db = openBeliefsDb({ path: dbPath });
  db.run("INSERT INTO tick (now_ms, host) VALUES (1000, 'h1')");
  const tickId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.run(
    `INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
     VALUES (?, 1, 'session_registered', 'CTL-9991/plan', NULL, 'R1', '[]')`,
    [tickId],
  );
  db.close();
  return { tickId };
}

function jsonNorm<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// ─── Seeded server ───────────────────────────────────────────────────────────

let seededServer: ReturnType<typeof createServer>;
let seededUrl: string;
let seededDir: string;
let seededTickId: number;
let beliefPath: string;

beforeAll(async () => {
  seededDir = mkdtempSync(join(tmpdir(), "gov-why-seeded-"));
  beliefPath = join(seededDir, "beliefs.db");
  const { tickId } = await seedBeliefDb(beliefPath);
  seededTickId = tickId;
  seededServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath: join(seededDir, "catalyst.db"),
    beliefStoreDbPath: beliefPath,
    wtDir: seededDir,
  });
  seededUrl = `http://localhost:${seededServer.port}`;
});

afterAll(() => {
  void seededServer?.stop(true);
  try { rmSync(seededDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Absent db server ────────────────────────────────────────────────────────

let absentServer: ReturnType<typeof createServer>;
let absentUrl: string;
let absentDir: string;

beforeAll(() => {
  absentDir = mkdtempSync(join(tmpdir(), "gov-why-absent-"));
  absentServer = createServer({
    port: 0,
    startWatcher: false,
    dbPath: join(absentDir, "catalyst.db"),
    beliefStoreDbPath: join(absentDir, "nonexistent.db"),
    wtDir: absentDir,
  });
  absentUrl = `http://localhost:${absentServer.port}`;
});

afterAll(() => {
  void absentServer?.stop(true);
  try { rmSync(absentDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 1. Implicit tick: body deep-equals traceTicket() ───────────────────────

describe("GET /api/beliefs/why — implicit tick contract", () => {
  it("HTTP body deep-equals traceTicket(db, ticket) on same db", async () => {
    const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
    const { openBeliefsDb } = await import(schemaSpecifier) as {
      openBeliefsDb: (opts: { path: string }) => Database;
    };
    const db = openBeliefsDb({ path: beliefPath });
    const whySpecifier = ["../../execution-core/beliefs/why.mjs"].join("");
    const { traceTicket } = await import(whySpecifier) as {
      traceTicket: (db: Database, ticket: string, opts?: { tickId?: number }) => unknown;
    };
    const expected = jsonNorm(traceTicket(db, "CTL-9991"));
    db.close();

    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-9991`);
    expect(res.status).toBe(200);
    const actual = await res.json();
    expect(actual).toEqual(expected);
  });
});

// ─── 2. Explicit tick= honored ───────────────────────────────────────────────

describe("GET /api/beliefs/why — explicit tick contract", () => {
  it("HTTP body deep-equals traceTicket(db, ticket, {tickId}) on same db", async () => {
    const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
    const { openBeliefsDb } = await import(schemaSpecifier) as {
      openBeliefsDb: (opts: { path: string }) => Database;
    };
    const db = openBeliefsDb({ path: beliefPath });
    const whySpecifier = ["../../execution-core/beliefs/why.mjs"].join("");
    const { traceTicket } = await import(whySpecifier) as {
      traceTicket: (db: Database, ticket: string, opts?: { tickId?: number }) => unknown;
    };
    const expected = jsonNorm(traceTicket(db, "CTL-9991", { tickId: seededTickId }));
    db.close();

    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=CTL-9991&tick=${seededTickId}`);
    expect(res.status).toBe(200);
    const actual = await res.json();
    expect(actual).toEqual(expected);
  });
});

// ─── 3. Absent db → 200 {beliefs:[]} ────────────────────────────────────────

describe("GET /api/beliefs/why — absent db contract", () => {
  it("absent db → 200 with beliefs:[] (graceful degradation)", async () => {
    const res = await fetch(`${absentUrl}/api/beliefs/why?ticket=CTL-9991`);
    expect(res.status).toBe(200);
    const body = await res.json() as { beliefs: unknown[]; ticket: string };
    expect(body.beliefs).toEqual([]);
    expect(body.ticket).toBe("CTL-9991");
  });
});

// ─── 4. Missing ticket → 400 ────────────────────────────────────────────────

describe("GET /api/beliefs/why — validation contract", () => {
  it("missing ticket → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why`);
    expect(res.status).toBe(400);
  });

  it("invalid ticket format → 400", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/why?ticket=notavalidticket`);
    expect(res.status).toBe(400);
  });
});
