import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * CTL-813 loop-reopen regression gate.
 *
 * The estimator's backward path was DEAD from CTL-751 until CTL-813: the
 * committed corpus had a single one-shot commit and nothing regenerated it.
 * This test runs the real refresh-corpus.sh (offline, via the --signals
 * seam) and fails if the loop re-opens:
 *
 *   - generated_at must ADVANCE on refresh
 *   - entry count must GROW when new actuals appear
 *   - fresh entries must REPLACE stale same-ticket entries (full signals)
 *   - entries not re-scored (cross-repo anchors) must be RETAINED
 *   - the compound-log human re-score must survive into the corpus
 *
 * The pre-existing lookup-corpus-integration.test.ts only proves the corpus
 * stays LOADABLE — it cannot detect a frozen corpus.
 */

const SCRIPT = resolve(import.meta.dir, "../refresh-corpus.sh");

const CSV_HEADER =
  '"ticket_id","title","state","closed_at","current_estimate","pr_number","additions","deletions","changed_files","domains_touched","has_migration","has_frontend","has_backend","otel_cost_usd","otel_turns","otel_wall_time_hours","human_actual_points"';

// CTL-9001: LOC=400→M, files=6→M, domains=1→S → mode M; human override 8 → L.
const ROW_9001 =
  '"CTL-9001","wire refresh corpus orchestration","Done","2026-06-05T10:00:00Z","5","1401","300","100","6","plugins/pm","false","false","true","","","","8"';
// CTL-9002: LOC=45→XS, files=1→XS → XS (points 1). Replaces a STALE old entry.
const ROW_9002 =
  '"CTL-9002","fix broker bug","Done","2026-06-05T11:00:00Z","3","1402","40","5","1","plugins/dev","false","false","true","","","",""';
// CTL-9003: appears only in the v2 fixture — the growth probe.
const ROW_9003 =
  '"CTL-9003","add monitor panel","Done","2026-06-06T09:00:00Z","","1403","150","20","3","plugins/dev","false","true","true","","","",""';

const OLD_CORPUS = {
  generated_at: "2020-01-01T00:00:00.000Z",
  schema: "catalyst.estimation.corpus.v1",
  count: 2,
  entries: [
    {
      // Stale CTL-751-bootstrap-shaped entry: degraded signals, wrong points.
      ticket_id: "CTL-9002",
      title: "",
      tier: null,
      tshirt: "M",
      points: 5,
      confidence: "low",
      rationale: "reconstructed from CTL-746 actuals corpus",
      signals: {
        loc: null,
        changed_files: null,
        domains: [],
        has_migration: false,
        has_frontend: false,
        has_backend: false,
      },
      actuals: { cost_usd: 12.5, turns: 80, wall_hours: 1.2 },
    },
    {
      // Cross-repo anchor (its PRs live in another repo) — must be retained.
      ticket_id: "ADV-1",
      title: "",
      tier: null,
      tshirt: "S",
      points: 3,
      confidence: "low",
      rationale: "reconstructed from CTL-746 actuals corpus",
      signals: {
        loc: 120,
        changed_files: 4,
        domains: [],
        has_migration: false,
        has_frontend: false,
        has_backend: false,
      },
      actuals: { cost_usd: 30.1, turns: 150, wall_hours: 0.9 },
    },
  ],
};

let dir: string;

function runRefresh(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], { cwd: dir });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function readCorpus(path: string): {
  generated_at: string;
  count: number;
  entries: Array<{
    ticket_id: string;
    title: string;
    points: number;
    confidence: string;
    rationale: string;
    signals: { loc: number | null; domains: string[] };
  }>;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "refresh-corpus-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("refresh-corpus.sh (offline via --signals seam)", () => {
  test("refresh advances generated_at, replaces stale entries, retains anchors, honors human re-score", () => {
    const signals = join(dir, "signals-v1.csv");
    const corpus = join(dir, "corpus.json");
    writeFileSync(signals, [CSV_HEADER, ROW_9001, ROW_9002].join("\n") + "\n");
    writeFileSync(corpus, JSON.stringify(OLD_CORPUS, null, 2));

    const r = runRefresh(["--signals", signals, "--corpus", corpus, "--no-check-labels"]);
    expect(r.code).toBe(0);

    const c = readCorpus(corpus);
    // generated_at advanced past the frozen bootstrap timestamp.
    expect(c.generated_at > OLD_CORPUS.generated_at).toBe(true);
    // 2 fresh + 1 retained anchor.
    expect(c.count).toBe(3);
    expect(c.entries.map((e) => e.ticket_id).sort()).toEqual(["ADV-1", "CTL-9001", "CTL-9002"]);

    // Fresh CTL-9002 REPLACED the stale degraded entry: full signals now.
    const e9002 = c.entries.find((e) => e.ticket_id === "CTL-9002");
    expect(e9002?.title).toBe("fix broker bug");
    expect(e9002?.points).toBe(1); // XS from LOC=45/files=1, not the stale 5
    expect(e9002?.signals.loc).toBe(45);
    expect(e9002?.signals.domains).toEqual(["plugins/dev"]);

    // Human re-score override survives into the corpus.
    const e9001 = c.entries.find((e) => e.ticket_id === "CTL-9001");
    expect(e9001?.points).toBe(8);
    expect(e9001?.confidence).toBe("high");
    expect(e9001?.rationale).toContain("human re-score override");

    // Cross-repo anchor retained untouched.
    const adv = c.entries.find((e) => e.ticket_id === "ADV-1");
    expect(adv?.points).toBe(3);
  });

  test("entry count GROWS when new actuals appear (the loop-reopen probe)", () => {
    const signals = join(dir, "signals-v2.csv");
    const corpus = join(dir, "corpus.json"); // continues from the previous test
    writeFileSync(signals, [CSV_HEADER, ROW_9001, ROW_9002, ROW_9003].join("\n") + "\n");

    const before = readCorpus(corpus);
    const r = runRefresh(["--signals", signals, "--corpus", corpus, "--no-check-labels"]);
    expect(r.code).toBe(0);

    const after = readCorpus(corpus);
    expect(after.count).toBe(before.count + 1);
    expect(after.entries.some((e) => e.ticket_id === "CTL-9003")).toBe(true);
    expect(after.generated_at > before.generated_at).toBe(true);
  });

  test("--dry-run leaves the corpus byte-identical", () => {
    const signals = join(dir, "signals-v1.csv");
    const corpus = join(dir, "corpus.json");
    const before = readFileSync(corpus, "utf8");

    const r = runRefresh(["--signals", signals, "--corpus", corpus, "--no-check-labels", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(readFileSync(corpus, "utf8")).toBe(before);
  });

  test("missing/empty signals CSV fails loud", () => {
    const corpus = join(dir, "corpus.json");
    const r = runRefresh([
      "--signals",
      join(dir, "does-not-exist.csv"),
      "--corpus",
      corpus,
      "--no-check-labels",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("signals CSV");
  });

  test("bootstrapping with no existing corpus file works", () => {
    const signals = join(dir, "signals-v1.csv");
    const corpus = join(dir, "fresh-start.json");
    const r = runRefresh(["--signals", signals, "--corpus", corpus, "--no-check-labels"]);
    expect(r.code).toBe(0);
    const c = readCorpus(corpus);
    expect(c.count).toBe(2);
  });
});
