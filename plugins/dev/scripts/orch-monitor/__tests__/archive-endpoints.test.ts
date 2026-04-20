import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let dbPath: string;
let archiveRoot: string;

function loadMigrations(): string[] {
  const migDir = join(__dirname, "..", "..", "db-migrations");
  return [
    "001_initial_schema.sql",
    "002_session_context.sql",
    "003_archives.sql",
  ].map((f) => readFileSync(join(migDir, f), "utf8"));
}

function seedArchive(): void {
  archiveRoot = join(tmpDir, "archives");
  mkdirSync(archiveRoot, { recursive: true });

  // Two archive directories for orch-alpha and orch-beta
  const alphaDir = join(archiveRoot, "orch-alpha");
  mkdirSync(join(alphaDir, "briefings"), { recursive: true });
  writeFileSync(join(alphaDir, "SUMMARY.md"), "# Alpha summary\n");
  writeFileSync(
    join(alphaDir, "metadata.json"),
    JSON.stringify({ orchId: "orch-alpha", workers: 1 }),
  );
  writeFileSync(
    join(alphaDir, "briefings", "wave-1.md"),
    "# Wave 1 briefing\n",
  );

  const betaDir = join(archiveRoot, "orch-beta");
  mkdirSync(betaDir, { recursive: true });
  writeFileSync(join(betaDir, "SUMMARY.md"), "# Beta summary\n");

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  for (const sql of loadMigrations()) db.exec(sql);

  const insertOrch = (
    id: string,
    startedAt: string,
    archivePath: string,
    extras: Partial<{
      completedAt: string;
      status: string;
      workersCount: number;
      prsMergedCount: number;
      tickets: string[];
    }> = {},
  ): void => {
    db.run(
      `INSERT INTO orchestrators
       (orch_id, name, started_at, completed_at, status,
        waves_count, workers_count, prs_merged_count,
        tickets_touched, archive_path, has_rollup, archived_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        id,
        startedAt,
        extras.completedAt ?? "2026-04-20T12:00:00Z",
        extras.status ?? "completed",
        1,
        extras.workersCount ?? 0,
        extras.prsMergedCount ?? 0,
        JSON.stringify(extras.tickets ?? []),
        archivePath,
        1,
        "2026-04-20T12:30:00Z",
      ],
    );
  };

  insertOrch("orch-alpha", "2026-04-15T10:00:00Z", alphaDir, {
    workersCount: 1,
    prsMergedCount: 1,
    tickets: ["CTL-100"],
  });
  insertOrch("orch-beta", "2026-04-10T10:00:00Z", betaDir, {
    tickets: ["CTL-200"],
  });

  db.run(
    `INSERT INTO archived_workers
     (worker_id, orch_id, ticket, pr_number, pr_state, final_status,
      duration_ms, cost_usd, has_summary, has_rollup_fragment, archived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "w-alpha-1",
      "orch-alpha",
      "CTL-100",
      42,
      "merged",
      "done",
      1000,
      0.25,
      1,
      0,
      "2026-04-20T12:30:00Z",
    ],
  );

  db.run(
    `INSERT INTO archived_artifacts
     (orch_id, worker_id, kind, path, bytes, sha256, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      "orch-alpha",
      null,
      "summary",
      "SUMMARY.md",
      16,
      "deadbeef",
      "2026-04-20T12:30:00Z",
    ],
  );
  db.run(
    `INSERT INTO archived_artifacts
     (orch_id, worker_id, kind, path, bytes, sha256, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      "orch-alpha",
      null,
      "briefing",
      "briefings/wave-1.md",
      18,
      "cafebabe",
      "2026-04-20T12:30:00Z",
    ],
  );

  db.close();
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "archive-endpoints-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  dbPath = join(tmpDir, "catalyst.db");
  seedArchive();

  const annotationsDbPath = join(tmpDir, "annotations.db");
  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    annotationsDbPath,
    dbPath,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("GET /api/archive/orchestrators", () => {
  it("lists archived orchestrators sorted by started_at DESC", async () => {
    const res = await fetch(`${baseUrl}/api/archive/orchestrators`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      entries: { orchId: string; ticketsTouched: string[] }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].orchId).toBe("orch-alpha");
    expect(body.entries[1].orchId).toBe("orch-beta");
    expect(body.entries[0].ticketsTouched).toEqual(["CTL-100"]);
  });

  it("filters by ticket substring", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators?ticket=CTL-200`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { orchId: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0].orchId).toBe("orch-beta");
  });

  it("filters by since", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators?since=2026-04-12T00:00:00Z`,
    );
    const body = (await res.json()) as {
      entries: { orchId: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0].orchId).toBe("orch-alpha");
  });

  it("honors limit + offset", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators?limit=1&offset=1`,
    );
    const body = (await res.json()) as {
      entries: { orchId: string }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].orchId).toBe("orch-beta");
  });

  it("returns empty result when dbPath is not configured", async () => {
    const noDbServer = createServer({
      port: 0,
      wtDir: tmpDir,
      startWatcher: false,
    });
    try {
      const res = await fetch(
        `http://localhost:${noDbServer.port}/api/archive/orchestrators`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: unknown[]; total: number };
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    } finally {
      void noDbServer.stop(true);
    }
  });
});

describe("GET /api/archive/orchestrators/:id", () => {
  it("returns orch + workers + artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/archive/orchestrators/orch-alpha`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orch: { orchId: string; workersCount: number };
      workers: { workerId: string; ticket: string }[];
      artifacts: { kind: string; path: string }[];
    };
    expect(body.orch.orchId).toBe("orch-alpha");
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0].workerId).toBe("w-alpha-1");
    expect(body.workers[0].ticket).toBe("CTL-100");
    expect(body.artifacts).toHaveLength(2);
    const kinds = body.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["briefing", "summary"]);
  });

  it("returns 404 when orch doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/api/archive/orchestrators/orch-missing`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid orchId characters", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/${encodeURIComponent("bad id!")}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/archive/orchestrators/:id/files/:rel+", () => {
  it("serves top-level SUMMARY.md with text/markdown content-type", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/SUMMARY.md`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("Alpha summary");
  });

  it("serves top-level metadata.json with application/json content-type", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/metadata.json`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { orchId: string };
    expect(body.orchId).toBe("orch-alpha");
  });

  it("serves nested files under a subdirectory", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/briefings/wave-1.md`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Wave 1 briefing");
  });

  it("returns 400 for path traversal attempts", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for absolute paths", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/${encodeURIComponent("/etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when a symlink resolves outside the archive root", async () => {
    const alphaDir = join(archiveRoot, "orch-alpha");
    const outside = join(tmpDir, "outside-secret.md");
    writeFileSync(outside, "SECRET");
    const linkPath = join(alphaDir, "leak.md");
    try {
      symlinkSync(outside, linkPath);
    } catch {
      // symlinks unsupported — skip rest of assertion
      return;
    }
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/leak.md`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when orch is not in the DB", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-missing/files/SUMMARY.md`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the file doesn't exist", async () => {
    const res = await fetch(
      `${baseUrl}/api/archive/orchestrators/orch-alpha/files/does-not-exist.md`,
    );
    expect(res.status).toBe(404);
  });
});
