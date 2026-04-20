import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sweep,
  syncArchive,
  prune,
  listArchived,
  resolveConfig,
  buildArtifactManifest,
  type ArchiveConfig,
} from "../catalyst-archive";

let tmpRoot: string;
let runsDir: string;
let archiveRoot: string;
let dbPath: string;
let commsDir: string;
let configDir: string;

function loadMigrations(): string[] {
  const migDir = join(__dirname, "..", "..", "db-migrations");
  return [
    "001_initial_schema.sql",
    "002_session_context.sql",
    "003_archives.sql",
  ].map((f) => readFileSync(join(migDir, f), "utf8"));
}

function seedDb(): void {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  for (const sql of loadMigrations()) db.exec(sql);
  db.close();
}

function buildTestConfig(overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return resolveConfig(
    {
      root: archiveRoot,
      runsDir,
      dbPath,
      commsDir,
      thoughtsDir: null,
      syncToThoughts: false,
      retention: { days: null },
      ...overrides,
    },
    configDir,
  );
}

function makeOrchFixture(
  orchId: string,
  opts: {
    includeSummary?: boolean;
    includeRollup?: boolean;
    waves?: number;
    workers?: {
      id: string;
      ticket?: string;
      includeSummaryInWorktree?: boolean;
      includeRollupFragment?: boolean;
      prState?: string;
      prNumber?: number;
    }[];
    completedAt?: string | null;
    workersRecord?: Record<string, unknown>;
  },
): string {
  const dir = join(runsDir, orchId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "workers"), { recursive: true });
  mkdirSync(join(dir, "workers", "output"), { recursive: true });

  const wavesArr: { wave: number; status: string; tickets: string[] }[] = [];
  for (let i = 1; i <= (opts.waves ?? 1); i++) {
    const tickets = (opts.workers ?? []).map((w) => w.ticket ?? w.id);
    wavesArr.push({ wave: i, status: "done", tickets: i === 1 ? tickets : [] });
  }

  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify(
      {
        orchestrator: orchId,
        status: "completed",
        startedAt: "2026-04-20T10:00:00Z",
        completedAt: opts.completedAt ?? "2026-04-20T12:00:00Z",
        totalWaves: opts.waves ?? 1,
        waves: wavesArr,
        workers: opts.workersRecord ?? {},
      },
      null,
      2,
    ),
  );

  if (opts.includeSummary) {
    writeFileSync(
      join(dir, "SUMMARY.md"),
      `# Summary for ${orchId}\n\nFixture content.\n`,
    );
  }
  if (opts.includeRollup) {
    writeFileSync(
      join(dir, "rollup-briefing.md"),
      `# Rollup for ${orchId}\n\nFixture rollup.\n`,
    );
  }

  for (let i = 1; i <= (opts.waves ?? 1); i++) {
    writeFileSync(
      join(dir, `wave-${i}-briefing.md`),
      `# Wave ${i} Briefing\n`,
    );
  }

  for (const w of opts.workers ?? []) {
    const worktreeDir = join(tmpRoot, "worktrees", w.id);
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(
      join(dir, "workers", `${w.id}.json`),
      JSON.stringify(
        {
          ticket: w.ticket ?? w.id,
          workerName: w.id,
          status: "done",
          startedAt: "2026-04-20T10:00:00Z",
          completedAt: "2026-04-20T11:30:00Z",
          updatedAt: "2026-04-20T11:30:00Z",
          worktreePath: worktreeDir,
          pr:
            w.prNumber !== undefined
              ? {
                  number: w.prNumber,
                  ciStatus: w.prState ?? "merged",
                  mergedAt: "2026-04-20T11:30:00Z",
                }
              : null,
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "workers", "output", `${w.id}-stream.jsonl`),
      `{"type":"event","ts":"2026-04-20T10:00:00Z"}\n`,
    );

    if (w.includeSummaryInWorktree) {
      writeFileSync(
        join(worktreeDir, "SUMMARY.md"),
        `# Worker ${w.id} summary\n`,
      );
    }
    if (w.includeRollupFragment) {
      writeFileSync(
        join(worktreeDir, "rollup-fragment.md"),
        `# Worker ${w.id} rollup fragment\n`,
      );
    }
  }

  return dir;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "catalyst-archive-test-"));
  runsDir = join(tmpRoot, "runs");
  archiveRoot = join(tmpRoot, "archives");
  dbPath = join(tmpRoot, "catalyst.db");
  commsDir = join(tmpRoot, "comms", "channels");
  configDir = join(tmpRoot, "config");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(commsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  seedDb();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("uses defaults when no overrides given", () => {
    const cfg = resolveConfig({}, configDir);
    expect(cfg.root).toMatch(/\/catalyst\/archives$/);
    expect(cfg.syncToThoughts).toBe(false);
    expect(cfg.retention.days).toBeNull();
  });

  it("respects overrides over file and defaults", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        archive: { root: "/tmp/file-root", syncToThoughts: true },
      }),
    );
    const cfg = resolveConfig({ root: "/tmp/override" }, configDir);
    expect(cfg.root).toBe("/tmp/override");
    expect(cfg.syncToThoughts).toBe(true);
  });

  it("reads archive block from ~/.config/catalyst/config.json", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        archive: {
          root: "/tmp/file-root",
          syncToThoughts: true,
          retention: { days: 30 },
        },
      }),
    );
    const cfg = resolveConfig({}, configDir);
    expect(cfg.root).toBe("/tmp/file-root");
    expect(cfg.syncToThoughts).toBe(true);
    expect(cfg.retention.days).toBe(30);
  });
});

describe("buildArtifactManifest", () => {
  it("includes state, summary, rollup, briefings, workers when present", () => {
    makeOrchFixture("orch-a", {
      includeSummary: true,
      includeRollup: true,
      waves: 2,
      workers: [
        {
          id: "CTL-100",
          ticket: "CTL-100",
          includeSummaryInWorktree: true,
          includeRollupFragment: true,
          prNumber: 42,
        },
      ],
    });
    const manifest = buildArtifactManifest("orch-a", buildTestConfig());
    const kinds = manifest.map((m) => `${m.kind}:${m.relativeDest}`);
    expect(kinds).toContain("state:orch-state.json");
    expect(kinds).toContain("summary:SUMMARY.md");
    expect(kinds).toContain("rollup:rollup-briefing.md");
    expect(kinds).toContain("briefing:briefings/wave-1-briefing.md");
    expect(kinds).toContain("briefing:briefings/wave-2-briefing.md");
    expect(kinds).toContain("signal:workers/CTL-100/signal-final.json");
    expect(kinds).toContain("phase-log:workers/CTL-100/phase-log.jsonl");
    expect(kinds).toContain("summary:workers/CTL-100/SUMMARY.md");
    expect(kinds).toContain("rollup:workers/CTL-100/rollup-fragment.md");
  });

  it("skips absent optional artifacts (no rollup, no worker SUMMARY)", () => {
    makeOrchFixture("orch-b", {
      includeSummary: true,
      includeRollup: false,
      workers: [{ id: "CTL-200" }],
    });
    const manifest = buildArtifactManifest("orch-b", buildTestConfig());
    const kinds = manifest.map((m) => `${m.kind}:${m.relativeDest}`);
    expect(kinds).toContain("summary:SUMMARY.md");
    expect(kinds).not.toContain("rollup:rollup-briefing.md");
    expect(kinds).not.toContain("summary:workers/CTL-200/SUMMARY.md");
    expect(kinds).not.toContain("rollup:workers/CTL-200/rollup-fragment.md");
  });
});

describe("sweep", () => {
  it("writes filesystem artifacts AND SQLite rows", () => {
    makeOrchFixture("orch-c", {
      includeSummary: true,
      includeRollup: true,
      workers: [
        {
          id: "CTL-300",
          ticket: "CTL-300",
          includeSummaryInWorktree: true,
          prNumber: 42,
        },
      ],
    });

    const summary = sweep("orch-c", buildTestConfig());
    expect(summary.orchId).toBe("orch-c");
    expect(summary.archivedArtifacts).toBeGreaterThan(0);
    expect(summary.workers).toBe(1);
    expect(summary.hasRollup).toBe(true);

    expect(existsSync(join(archiveRoot, "orch-c", "orch-state.json"))).toBe(
      true,
    );
    expect(existsSync(join(archiveRoot, "orch-c", "SUMMARY.md"))).toBe(true);
    expect(
      existsSync(join(archiveRoot, "orch-c", "rollup-briefing.md")),
    ).toBe(true);
    expect(
      existsSync(join(archiveRoot, "orch-c", "workers", "CTL-300", "SUMMARY.md")),
    ).toBe(true);
    expect(
      existsSync(
        join(archiveRoot, "orch-c", "workers", "CTL-300", "signal-final.json"),
      ),
    ).toBe(true);
    expect(existsSync(join(archiveRoot, "orch-c", "metadata.json"))).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const orchRow = db
      .prepare(`SELECT * FROM orchestrators WHERE orch_id = ?`)
      .get("orch-c") as {
      orch_id: string;
      name: string;
      workers_count: number;
      has_rollup: number;
      prs_merged_count: number;
    };
    expect(orchRow).toBeTruthy();
    expect(orchRow.workers_count).toBe(1);
    expect(orchRow.has_rollup).toBe(1);
    expect(orchRow.prs_merged_count).toBe(1);

    const artifacts = db
      .prepare(
        `SELECT kind, path FROM archived_artifacts WHERE orch_id = ? ORDER BY path`,
      )
      .all("orch-c") as { kind: string; path: string }[];
    expect(artifacts.some((a) => a.kind === "state")).toBe(true);
    expect(artifacts.some((a) => a.kind === "metadata")).toBe(true);
    db.close();
  });

  it("is idempotent: running twice produces no duplicates", () => {
    makeOrchFixture("orch-d", {
      includeSummary: true,
      workers: [{ id: "CTL-400", ticket: "CTL-400" }],
    });
    const cfg = buildTestConfig();
    sweep("orch-d", cfg);
    sweep("orch-d", cfg);

    const db = new Database(dbPath, { readonly: true });
    const orchCount = (
      db
        .prepare(`SELECT COUNT(*) as c FROM orchestrators WHERE orch_id = ?`)
        .get("orch-d") as { c: number }
    ).c;
    expect(orchCount).toBe(1);

    const workerCount = (
      db
        .prepare(`SELECT COUNT(*) as c FROM archived_workers WHERE orch_id = ?`)
        .get("orch-d") as { c: number }
    ).c;
    expect(workerCount).toBe(1);

    const artifactCountBySummary = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM archived_artifacts WHERE orch_id = ? AND kind = 'summary' AND worker_id IS NULL`,
        )
        .get("orch-d") as { c: number }
    ).c;
    expect(artifactCountBySummary).toBe(1);
    db.close();
  });

  it("tolerates absent SUMMARY.md and rollup-briefing.md", () => {
    makeOrchFixture("orch-e", {
      includeSummary: false,
      includeRollup: false,
      workers: [{ id: "CTL-500" }],
    });
    const summary = sweep("orch-e", buildTestConfig());
    expect(summary.hasRollup).toBe(false);
    expect(
      summary.skippedArtifacts.filter((s) => s.startsWith("summary")).length,
    ).toBe(0);
    expect(existsSync(join(archiveRoot, "orch-e", "SUMMARY.md"))).toBe(false);
    expect(existsSync(join(archiveRoot, "orch-e", "metadata.json"))).toBe(true);
  });

  it("writes filesystem blobs BEFORE SQLite rows (consistency)", () => {
    makeOrchFixture("orch-f", {
      includeSummary: true,
      workers: [{ id: "CTL-600", ticket: "CTL-600" }],
    });
    const cfg = buildTestConfig({
      dbPath: join(tmpRoot, "missing.db"),
    });
    expect(() => sweep("orch-f", cfg)).toThrow(/SQLite DB not found/);
    expect(existsSync(join(archiveRoot, "orch-f", "SUMMARY.md"))).toBe(true);
    expect(existsSync(join(archiveRoot, "orch-f", "metadata.json"))).toBe(true);
  });

  it("archives comms channels with matching orch id", () => {
    writeFileSync(
      join(commsDir, "orch-test.jsonl"),
      JSON.stringify({
        id: "msg-1",
        orch: "orch-g",
        from: "worker",
        to: "all",
        ch: "orch-test",
        ts: "2026-04-20T10:00:00Z",
        type: "info",
        body: "hello",
      }) + "\n",
    );
    writeFileSync(
      join(commsDir, "other.jsonl"),
      JSON.stringify({
        id: "msg-2",
        orch: "different-orch",
        from: "worker",
        to: "all",
        ch: "other",
        ts: "2026-04-20T10:00:00Z",
        type: "info",
        body: "bye",
      }) + "\n",
    );
    makeOrchFixture("orch-g", {
      includeSummary: true,
      workers: [{ id: "CTL-700" }],
    });

    sweep("orch-g", buildTestConfig());
    expect(existsSync(join(archiveRoot, "orch-g", "comms", "orch-test.jsonl"))).toBe(
      true,
    );
    expect(existsSync(join(archiveRoot, "orch-g", "comms", "other.jsonl"))).toBe(
      false,
    );
  });

  it("dry-run writes nothing", () => {
    makeOrchFixture("orch-h", {
      includeSummary: true,
      workers: [{ id: "CTL-800" }],
    });
    const summary = sweep("orch-h", buildTestConfig(), { dryRun: true });
    expect(summary.archivedArtifacts).toBeGreaterThan(0);
    expect(existsSync(join(archiveRoot, "orch-h", "SUMMARY.md"))).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    const orchCount = (
      db
        .prepare(`SELECT COUNT(*) as c FROM orchestrators WHERE orch_id = ?`)
        .get("orch-h") as { c: number }
    ).c;
    expect(orchCount).toBe(0);
    db.close();
  });
});

describe("syncArchive", () => {
  it("detects missing files referenced in SQLite", () => {
    makeOrchFixture("orch-sync-1", {
      includeSummary: true,
      workers: [{ id: "CTL-100" }],
    });
    sweep("orch-sync-1", buildTestConfig());

    const summaryPath = join(archiveRoot, "orch-sync-1", "SUMMARY.md");
    expect(existsSync(summaryPath)).toBe(true);
    unlinkSync(summaryPath);

    const report = syncArchive(buildTestConfig());
    expect(report.missingFiles.some((m) => m.path.endsWith("SUMMARY.md"))).toBe(
      true,
    );
  });

  it("detects orphan archive directories not in SQLite", () => {
    const orphan = join(archiveRoot, "orch-orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "metadata.json"), "{}");

    const report = syncArchive(buildTestConfig());
    expect(report.orphanDirs.some((d) => d.endsWith("orch-orphan"))).toBe(true);
  });
});

describe("prune", () => {
  it("removes archives older than N days (filesystem + SQLite)", () => {
    makeOrchFixture("orch-prune", {
      includeSummary: true,
      workers: [{ id: "CTL-100" }],
    });
    sweep("orch-prune", buildTestConfig());

    const db = new Database(dbPath);
    db.run(
      `UPDATE orchestrators SET archived_at = ? WHERE orch_id = ?`,
      ["2020-01-01T00:00:00Z", "orch-prune"],
    );
    db.close();

    const report = prune(buildTestConfig(), 30);
    expect(report.removed).toContain("orch-prune");
    expect(existsSync(join(archiveRoot, "orch-prune"))).toBe(false);

    const db2 = new Database(dbPath, { readonly: true });
    const row = db2
      .prepare(`SELECT * FROM orchestrators WHERE orch_id = ?`)
      .get("orch-prune");
    expect(row).toBeNull();
    db2.close();
  });

  it("keeps archives newer than threshold", () => {
    makeOrchFixture("orch-keep", {
      includeSummary: true,
      workers: [{ id: "CTL-100" }],
    });
    sweep("orch-keep", buildTestConfig());

    const report = prune(buildTestConfig(), 9999);
    expect(report.removed).not.toContain("orch-keep");
    expect(report.keptCount).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(archiveRoot, "orch-keep"))).toBe(true);
  });
});

describe("listArchived", () => {
  it("returns empty array when DB doesn't exist", () => {
    const cfg = buildTestConfig({
      dbPath: join(tmpRoot, "does-not-exist.db"),
    });
    expect(listArchived(cfg)).toEqual([]);
  });

  it("returns rows sorted by started_at DESC", () => {
    makeOrchFixture("orch-older", {
      includeSummary: true,
      workers: [{ id: "CTL-1" }],
    });
    makeOrchFixture("orch-newer", {
      includeSummary: true,
      workers: [{ id: "CTL-2" }],
    });
    sweep("orch-older", buildTestConfig());
    sweep("orch-newer", buildTestConfig());

    const db = new Database(dbPath);
    db.run(`UPDATE orchestrators SET started_at = ? WHERE orch_id = ?`, [
      "2026-04-01T10:00:00Z",
      "orch-older",
    ]);
    db.run(`UPDATE orchestrators SET started_at = ? WHERE orch_id = ?`, [
      "2026-04-20T10:00:00Z",
      "orch-newer",
    ]);
    db.close();

    const entries = listArchived(buildTestConfig());
    expect(entries[0].orchId).toBe("orch-newer");
    expect(entries[1].orchId).toBe("orch-older");
  });

  it("round-trips tickets_touched JSON array", () => {
    makeOrchFixture("orch-tickets", {
      includeSummary: true,
      workers: [
        { id: "CTL-10", ticket: "CTL-10" },
        { id: "CTL-11", ticket: "CTL-11" },
      ],
    });
    sweep("orch-tickets", buildTestConfig());

    const entries = listArchived(buildTestConfig());
    const match = entries.find((e) => e.orchId === "orch-tickets");
    expect(match).toBeTruthy();
    expect(match!.ticketsTouched).toContain("CTL-10");
    expect(match!.ticketsTouched).toContain("CTL-11");
  });
});

describe("throws on unknown orch", () => {
  it("sweep throws when orch dir missing", () => {
    expect(() => sweep("does-not-exist", buildTestConfig())).toThrow(
      /Orchestrator dir not found/,
    );
  });
});

describe("metadata file content", () => {
  it("metadata.json has expected fields and matches SQLite", () => {
    makeOrchFixture("orch-meta", {
      includeSummary: true,
      includeRollup: true,
      waves: 2,
      workers: [
        { id: "CTL-1", ticket: "CTL-1", prNumber: 1 },
        { id: "CTL-2", ticket: "CTL-2", prNumber: 2 },
      ],
    });
    sweep("orch-meta", buildTestConfig());

    const metaPath = join(archiveRoot, "orch-meta", "metadata.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.orchId).toBe("orch-meta");
    expect(meta.workersCount).toBe(2);
    expect(meta.prsMergedCount).toBe(2);
    expect(meta.wavesCount).toBe(2);
    expect(statSync(metaPath).size).toBeGreaterThan(0);
  });
});
