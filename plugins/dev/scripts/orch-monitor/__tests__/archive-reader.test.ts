import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listArchivedOrchestrators,
  getArchivedOrchestrator,
  getArchivePath,
} from "../lib/archive-reader";

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

function insertOrch(
  db: Database,
  orchId: string,
  fields: Partial<{
    name: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    wavesCount: number;
    workersCount: number;
    prsMergedCount: number;
    ticketsTouched: string[];
    archivePath: string;
    hasRollup: boolean;
    archivedAt: string;
  }> = {},
): void {
  db.run(
    `INSERT INTO orchestrators
     (orch_id, name, started_at, completed_at, status,
      waves_count, workers_count, prs_merged_count,
      tickets_touched, archive_path, has_rollup, archived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      orchId,
      fields.name ?? orchId,
      fields.startedAt ?? "2026-04-20T10:00:00Z",
      fields.completedAt ?? "2026-04-20T12:00:00Z",
      fields.status ?? "completed",
      fields.wavesCount ?? 1,
      fields.workersCount ?? 0,
      fields.prsMergedCount ?? 0,
      JSON.stringify(fields.ticketsTouched ?? []),
      fields.archivePath ?? `/tmp/archives/${orchId}`,
      fields.hasRollup ? 1 : 0,
      fields.archivedAt ?? "2026-04-20T12:30:00Z",
    ],
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "archive-reader-test-"));
  dbPath = join(tmpRoot, "catalyst.db");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listArchivedOrchestrators", () => {
  it("returns empty result when DB doesn't exist", () => {
    const result = listArchivedOrchestrators(
      "/nonexistent/catalyst.db",
      {},
    );
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns orchestrators sorted by started_at DESC", () => {
    seedDb((db) => {
      insertOrch(db, "orch-old", {
        startedAt: "2026-04-10T10:00:00Z",
      });
      insertOrch(db, "orch-new", {
        startedAt: "2026-04-20T10:00:00Z",
      });
    });

    const result = listArchivedOrchestrators(dbPath, {});
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].orchId).toBe("orch-new");
    expect(result.entries[1].orchId).toBe("orch-old");
    expect(result.total).toBe(2);
  });

  it("filters by since", () => {
    seedDb((db) => {
      insertOrch(db, "orch-old", { startedAt: "2026-04-01T10:00:00Z" });
      insertOrch(db, "orch-new", { startedAt: "2026-04-15T10:00:00Z" });
    });

    const result = listArchivedOrchestrators(dbPath, {
      since: "2026-04-10T00:00:00Z",
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].orchId).toBe("orch-new");
    expect(result.total).toBe(1);
  });

  it("filters by ticket (LIKE over tickets_touched JSON)", () => {
    seedDb((db) => {
      insertOrch(db, "orch-a", { ticketsTouched: ["CTL-10", "CTL-11"] });
      insertOrch(db, "orch-b", { ticketsTouched: ["CTL-20"] });
    });
    const result = listArchivedOrchestrators(dbPath, { ticket: "CTL-10" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].orchId).toBe("orch-a");
  });

  it("honors limit and offset", () => {
    seedDb((db) => {
      for (let i = 1; i <= 5; i++) {
        insertOrch(db, `orch-${i}`, {
          startedAt: `2026-04-${String(i).padStart(2, "0")}T10:00:00Z`,
        });
      }
    });
    const page1 = listArchivedOrchestrators(dbPath, { limit: 2, offset: 0 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page2 = listArchivedOrchestrators(dbPath, { limit: 2, offset: 2 });
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].orchId).not.toBe(page1.entries[0].orchId);
  });

  it("parses tickets_touched JSON into string[]", () => {
    seedDb((db) => {
      insertOrch(db, "orch-json", {
        ticketsTouched: ["CTL-1", "CTL-2", "CTL-3"],
      });
    });
    const result = listArchivedOrchestrators(dbPath, {});
    expect(result.entries[0].ticketsTouched).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });

  it("tolerates malformed tickets_touched JSON", () => {
    seedDb((db) => {
      db.run(
        `INSERT INTO orchestrators
         (orch_id, name, started_at, archive_path, archived_at, tickets_touched)
         VALUES (?,?,?,?,?,?)`,
        [
          "orch-bad",
          "orch-bad",
          "2026-04-20T10:00:00Z",
          "/tmp/archives/orch-bad",
          "2026-04-20T10:00:00Z",
          "not-valid-json",
        ],
      );
    });
    const result = listArchivedOrchestrators(dbPath, {});
    expect(result.entries[0].ticketsTouched).toEqual([]);
  });
});

describe("getArchivedOrchestrator", () => {
  it("returns null when orch doesn't exist", () => {
    seedDb(() => {});
    expect(getArchivedOrchestrator(dbPath, "does-not-exist")).toBeNull();
  });

  it("returns orch + workers + artifacts", () => {
    seedDb((db) => {
      insertOrch(db, "orch-x", { workersCount: 2, hasRollup: true });
      db.run(
        `INSERT INTO archived_workers
         (worker_id, orch_id, ticket, pr_number, pr_state, final_status,
          duration_ms, cost_usd, has_summary, has_rollup_fragment, archived_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          "w1",
          "orch-x",
          "CTL-1",
          42,
          "merged",
          "done",
          1000,
          0.5,
          1,
          1,
          "2026-04-20T12:30:00Z",
        ],
      );
      db.run(
        `INSERT INTO archived_artifacts
         (orch_id, worker_id, kind, path, bytes, sha256, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          "orch-x",
          null,
          "summary",
          "SUMMARY.md",
          100,
          "deadbeef",
          "2026-04-20T12:30:00Z",
        ],
      );
    });

    const result = getArchivedOrchestrator(dbPath, "orch-x");
    expect(result).toBeTruthy();
    expect(result!.orch.orchId).toBe("orch-x");
    expect(result!.orch.hasRollup).toBe(true);
    expect(result!.workers).toHaveLength(1);
    expect(result!.workers[0].workerId).toBe("w1");
    expect(result!.workers[0].hasSummary).toBe(true);
    expect(result!.artifacts).toHaveLength(1);
    expect(result!.artifacts[0].kind).toBe("summary");
  });
});

describe("getArchivePath", () => {
  it("returns the archive_path for an orch", () => {
    seedDb((db) => {
      insertOrch(db, "orch-p", { archivePath: "/tmp/archives/orch-p" });
    });
    expect(getArchivePath(dbPath, "orch-p")).toBe("/tmp/archives/orch-p");
  });

  it("returns null when orch doesn't exist", () => {
    seedDb(() => {});
    expect(getArchivePath(dbPath, "missing")).toBeNull();
  });
});
