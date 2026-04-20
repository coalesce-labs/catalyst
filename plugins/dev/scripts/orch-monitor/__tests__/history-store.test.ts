import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  queryHistory,
  queryStats,
  compareSessions,
} from "../lib/history-store";

let tmpRoot: string;
let dbPath: string;

function loadMigrations(): string[] {
  const migDir = join(__dirname, "..", "..", "db-migrations");
  return [
    "001_initial_schema.sql",
    "002_session_context.sql",
    "003_archives.sql",
  ].map((f) => readFileSync(join(migDir, f), "utf8"));
}

function seedDb(fn: (db: Database) => void): void {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  for (const sql of loadMigrations()) db.exec(sql);
  fn(db);
  db.close();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "history-store-test-"));
  dbPath = join(tmpRoot, "catalyst.db");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("queryHistory", () => {
  it("returns empty array when db does not exist", () => {
    const result = queryHistory("/nonexistent/path.db", {});
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("lists completed sessions ordered by started_at DESC", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s-old", "oneshot", "done", 6, "2026-04-10T10:00:00Z", "2026-04-10T11:00:00Z", "2026-04-10T11:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s-new", "research", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T11:00:00Z", "2026-04-14T11:00:00Z"],
      );
    });

    const result = queryHistory(dbPath, {});
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].sessionId).toBe("s-new");
    expect(result.entries[1].sessionId).toBe("s-old");
    expect(result.total).toBe(2);
  });

  it("filters by skill", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s2", "research", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
    });

    const result = queryHistory(dbPath, { skill: "oneshot" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sessionId).toBe("s1");
  });

  it("filters by ticket", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, ticket_key, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s1", "CTL-10", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, ticket_key, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s2", "CTL-20", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
    });

    const result = queryHistory(dbPath, { ticket: "CTL-10" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].ticket).toBe("CTL-10");
  });

  it("filters by since date", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s-old", "oneshot", "done", 6, "2026-04-01T10:00:00Z", "2026-04-01T10:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s-new", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
    });

    const result = queryHistory(dbPath, { since: "2026-04-10T00:00:00Z" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sessionId).toBe("s-new");
  });

  it("applies limit and offset for pagination", () => {
    seedDb((db) => {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`s-${i}`, "oneshot", "done", 6, `2026-04-${String(10 + i).padStart(2, "0")}T10:00:00Z`, `2026-04-${String(10 + i).padStart(2, "0")}T10:00:00Z`],
        );
      }
    });

    const page1 = queryHistory(dbPath, { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.entries[0].sessionId).toBe("s-4");

    const page2 = queryHistory(dbPath, { limit: 2, offset: 2 });
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].sessionId).toBe("s-2");
  });

  it("includes cost and duration from metrics", () => {
    const now = "2026-04-14T10:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, now, now],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 2.50, 10000, 5000, 2000, 500, 120000, now],
      );
    });

    const result = queryHistory(dbPath, {});
    expect(result.entries[0].costUsd).toBe(2.50);
    expect(result.entries[0].durationMs).toBe(120000);
    expect(result.entries[0].inputTokens).toBe(10000);
    expect(result.entries[0].outputTokens).toBe(5000);
  });

  it("includes search by text query across skill and ticket", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, ticket_key, label, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "CTL-10", "fix auth bug", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, ticket_key, label, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", "research", "CTL-20", "explore caching", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
    });

    const result = queryHistory(dbPath, { search: "auth" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sessionId).toBe("s1");
  });
});

describe("queryStats", () => {
  it("returns zeroed stats when db does not exist", () => {
    const stats = queryStats("/nonexistent/path.db", {});
    expect(stats.totalSessions).toBe(0);
    expect(stats.skillBreakdown).toEqual([]);
    expect(stats.dailyCosts).toEqual([]);
  });

  it("computes aggregate statistics", () => {
    const ts1 = "2026-04-14T10:00:00Z";
    const ts2 = "2026-04-14T12:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, ts1, ts2, ts2],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s2", "oneshot", "failed", 3, ts1, ts2, ts2],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s3", "research", "done", 6, ts1, ts2, ts2],
      );

      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 3.00, 60000, 5000, 2000, 1000, 500, ts2],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", 1.50, 30000, 3000, 1000, 500, 200, ts2],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s3", 0.50, 15000, 1000, 500, 200, 100, ts2],
      );
    });

    const stats = queryStats(dbPath, {});
    expect(stats.totalSessions).toBe(3);
    expect(stats.totalCostUsd).toBeCloseTo(5.0);
    expect(stats.avgCostUsd).toBeCloseTo(5.0 / 3);
    expect(stats.avgDurationMs).toBeCloseTo(35000);
    expect(stats.successRate).toBeCloseTo(2 / 3);
  });

  it("provides skill breakdown", () => {
    const ts = "2026-04-14T10:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, ts, ts, ts],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s2", "oneshot", "failed", 3, ts, ts, ts],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["s3", "research", "done", 6, ts, ts, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 3.00, 60000, 0, 0, 0, 0, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", 1.50, 30000, 0, 0, 0, 0, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s3", 0.50, 15000, 0, 0, 0, 0, ts],
      );
    });

    const stats = queryStats(dbPath, {});
    expect(stats.skillBreakdown).toHaveLength(2);

    const oneshot = stats.skillBreakdown.find((s) => s.skill === "oneshot")!;
    expect(oneshot.count).toBe(2);
    expect(oneshot.totalCostUsd).toBeCloseTo(4.5);
    expect(oneshot.successRate).toBeCloseTo(0.5);

    const research = stats.skillBreakdown.find((s) => s.skill === "research")!;
    expect(research.count).toBe(1);
    expect(research.successRate).toBeCloseTo(1.0);
  });

  it("provides daily cost data", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, "2026-04-10T10:00:00Z", "2026-04-10T10:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s2", "oneshot", "done", 6, "2026-04-10T14:00:00Z", "2026-04-10T14:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s3", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 2.00, 0, 0, 0, 0, 0, "2026-04-10T10:00:00Z"],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", 1.00, 0, 0, 0, 0, 0, "2026-04-10T10:00:00Z"],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s3", 0.50, 0, 0, 0, 0, 0, "2026-04-14T10:00:00Z"],
      );
    });

    const stats = queryStats(dbPath, {});
    expect(stats.dailyCosts.length).toBeGreaterThanOrEqual(2);
    const day10 = stats.dailyCosts.find((d) => d.date === "2026-04-10");
    expect(day10).toBeDefined();
    expect(day10!.costUsd).toBeCloseTo(3.0);
    expect(day10!.sessionCount).toBe(2);

    const day14 = stats.dailyCosts.find((d) => d.date === "2026-04-14");
    expect(day14).toBeDefined();
    expect(day14!.costUsd).toBeCloseTo(0.5);
  });

  it("filters stats by skill", () => {
    const ts = "2026-04-14T10:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, ts, ts],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s2", "research", "done", 6, ts, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 3.00, 0, 0, 0, 0, 0, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", 1.00, 0, 0, 0, 0, 0, ts],
      );
    });

    const stats = queryStats(dbPath, { skill: "oneshot" });
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(3.0);
  });

  it("includes top tools across sessions", () => {
    const ts = "2026-04-14T10:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, ts, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s1", "Read", 50, 5000, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s1", "Edit", 20, 3000, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s1", "Bash", 10, 10000, ts],
      );
    });

    const stats = queryStats(dbPath, {});
    expect(stats.topTools.length).toBeGreaterThanOrEqual(3);
    expect(stats.topTools[0].tool).toBe("Read");
    expect(stats.topTools[0].totalCalls).toBe(50);
  });
});

describe("compareSessions", () => {
  it("returns null when either session does not exist", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T10:00:00Z"],
      );
    });

    expect(compareSessions(dbPath, "s1", "nonexistent")).toBeNull();
    expect(compareSessions(dbPath, "nonexistent", "s1")).toBeNull();
  });

  it("returns null for nonexistent db", () => {
    expect(compareSessions("/nonexistent.db", "a", "b")).toBeNull();
  });

  it("compares two sessions side-by-side", () => {
    const ts = "2026-04-14T10:00:00Z";
    seedDb((db) => {
      db.run(
        `INSERT INTO sessions (session_id, skill_name, ticket_key, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", "oneshot", "CTL-10", "done", 6, "2026-04-10T10:00:00Z", "2026-04-10T11:00:00Z", "2026-04-10T11:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, skill_name, ticket_key, status, phase, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", "oneshot", "CTL-20", "done", 6, "2026-04-14T10:00:00Z", "2026-04-14T12:00:00Z", "2026-04-14T12:00:00Z"],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s1", 2.00, 60000, 5000, 2000, 1000, 0, ts],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["s2", 4.00, 120000, 10000, 4000, 2000, 0, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s1", "Read", 30, 3000, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s2", "Read", 50, 5000, ts],
      );
      db.run(
        `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["s2", "Edit", 20, 2000, ts],
      );
    });

    const cmp = compareSessions(dbPath, "s1", "s2");
    expect(cmp).not.toBeNull();
    expect(cmp!.left.sessionId).toBe("s1");
    expect(cmp!.right.sessionId).toBe("s2");
    expect(cmp!.left.costUsd).toBe(2.0);
    expect(cmp!.right.costUsd).toBe(4.0);
    expect(cmp!.left.durationMs).toBe(60000);
    expect(cmp!.right.durationMs).toBe(120000);
    expect(cmp!.left.tools).toHaveLength(1);
    expect(cmp!.right.tools).toHaveLength(2);
  });
});
