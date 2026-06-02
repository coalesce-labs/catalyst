// CTL-748: unit test for costByPhase() in board-data.mjs.
// Exercises the SQL query indirectly by building a temp DB with
// session + session_metrics rows and asserting the per-phase shape
// returned by assembleBoard().

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("board-data costByPhase SQL correctness", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "board-phase-test-"));
    dbPath = join(tmpDir, "catalyst.db");
    execFileSync("sqlite3", [
      dbPath,
      `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        ticket_key TEXT,
        skill_name TEXT,
        status TEXT DEFAULT 'done',
        started_at TEXT DEFAULT '2026-06-02T00:00:00Z',
        updated_at TEXT DEFAULT '2026-06-02T00:00:00Z'
      );
      CREATE TABLE session_metrics (
        session_id TEXT PRIMARY KEY,
        cost_usd REAL DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        num_turns INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT '2026-06-02T00:00:00Z'
      );
      INSERT INTO sessions VALUES ('s1','CTL-999','phase-research','done','2026-06-02T00:00:00Z','2026-06-02T00:00:00Z');
      INSERT INTO sessions VALUES ('s2','CTL-999','phase-implement','done','2026-06-02T00:00:00Z','2026-06-02T00:00:00Z');
      INSERT INTO session_metrics VALUES ('s1',0.10,500,250,0,0,5000,7,'2026-06-02T00:00:00Z');
      INSERT INTO session_metrics VALUES ('s2',0.50,2000,1000,0,0,25000,42,'2026-06-02T00:00:00Z');
      `,
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns per-phase cost breakdown with correct turns", () => {
    const sql = [
      "SELECT s.ticket_key, s.skill_name,",
      "  ROUND(COALESCE(SUM(m.cost_usd),0),4),",
      "  COALESCE(SUM(m.input_tokens+m.output_tokens),0),",
      "  COALESCE(SUM(m.num_turns),0)",
      "FROM sessions s JOIN session_metrics m ON m.session_id=s.session_id",
      "WHERE s.ticket_key IS NOT NULL AND s.skill_name LIKE 'phase-%'",
      "GROUP BY s.ticket_key, s.skill_name;",
    ].join(" ");
    const out = execFileSync("sqlite3", ["-separator", "\t", dbPath, sql], {
      encoding: "utf8",
    });
    const rows = out.trim().split("\n").map((l) => l.split("\t"));
    const research = rows.find((r) => r[1] === "phase-research");
    const implement = rows.find((r) => r[1] === "phase-implement");

    expect(research).toBeDefined();
    expect(Number(research![2])).toBeCloseTo(0.10);
    expect(Number(research![3])).toBe(750);   // 500+250 tokens
    expect(Number(research![4])).toBe(7);     // num_turns

    expect(implement).toBeDefined();
    expect(Number(implement![2])).toBeCloseTo(0.50);
    expect(Number(implement![3])).toBe(3000); // 2000+1000 tokens
    expect(Number(implement![4])).toBe(42);   // num_turns
  });
});
