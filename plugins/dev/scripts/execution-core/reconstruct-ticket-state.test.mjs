// Unit tests for reconstruct-ticket-state.mjs (CTL-1490 Feature F).
// Run: cd plugins/dev/scripts/execution-core && bun test reconstruct-ticket-state.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  reconstructTicketState,
  defaultCheckArchive,
  defaultArchiveDir,
} from "./reconstruct-ticket-state.mjs";

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reconstruct-ticket-state-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// writeThoughtsDoc — create a dated thoughts doc for a given phase + ticket.
function writeThoughtsDoc(phase, ticket) {
  const DIRS = {
    triage: "thoughts/shared/phase-triage",
    research: "thoughts/shared/research",
    plan: "thoughts/shared/plans",
    verify: "thoughts/shared/phase-verify",
    review: "thoughts/shared/phase-review",
    pr: "thoughts/shared/phase-pr",
    "monitor-merge": "thoughts/shared/phase-monitor-merge",
    "monitor-deploy": "thoughts/shared/phase-monitor-deploy",
  };
  const relDir = DIRS[phase];
  if (!relDir) throw new Error(`No thoughts dir for phase: ${phase}`);
  const dir = join(tempDir, relDir);
  mkdirSync(dir, { recursive: true });
  const lc = ticket.toLowerCase();
  writeFileSync(join(dir, `2026-07-01-${lc}.md`), `# ${phase} doc for ${ticket}\n`);
}

// noWorktree — injectable buildWorktree that fails open but records if called.
function noWorktree() {
  return { ok: false, cwd: null };
}

// noPrs — injectable checkOpenPrs that returns empty.
function noPrs() {
  return { prs: [] };
}

describe("reconstructTicketState", () => {
  test("T1: archived-as-Done ticket → nextPhase null, worktree NOT rebuilt", async () => {
    let worktreeCalled = false;
    const result = await reconstructTicketState("CTL-9001", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => ({ terminal: true, completedPhases: ["triage", "research", "plan"] }),
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: () => {
        worktreeCalled = true;
        return { ok: true, cwd: "/tmp/wt" };
      },
    });
    expect(result.nextPhase).toBeNull();
    expect(result.pr).toBeNull();
    expect(result.worktree).toBeNull();
    expect(worktreeCalled).toBe(false);
  });

  test("T2: thoughts docs through review → nextPhase = pr, completedPhases includes review", async () => {
    for (const phase of ["triage", "research", "plan", "verify", "review"]) {
      writeThoughtsDoc(phase, "CTL-9002");
    }
    const result = await reconstructTicketState("CTL-9002", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("pr");
    expect(result.completedPhases).toContain("review");
    expect(result.completedPhases).not.toContain("pr");
  });

  test("T3: nothing done → nextPhase = research (NEW_WORK_ENTRY_PHASE), empty completedPhases", async () => {
    const result = await reconstructTicketState("CTL-9003", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("research");
    expect(result.completedPhases).toEqual([]);
  });

  test("T4: open PR exists → pr field populated from checkOpenPrs seam", async () => {
    const result = await reconstructTicketState("CTL-9004", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: () => ({ prs: [{ number: 42, state: "OPEN", isDraft: false }] }),
      buildWorktree: noWorktree,
    });
    expect(result.pr).not.toBeNull();
    expect(result.pr.number).toBe(42);
  });

  test("T5: non-terminal → calls buildWorktree with { ticket, repoRoot, expectedBranch: ticket }", async () => {
    writeThoughtsDoc("triage", "CTL-9005");
    let capturedArgs = null;
    const result = await reconstructTicketState("CTL-9005", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: (ticket, opts) => {
        capturedArgs = { ticket, ...opts };
        return { ok: true, cwd: "/tmp/wt-ctl-9005" };
      },
    });
    expect(capturedArgs?.ticket).toBe("CTL-9005");
    expect(capturedArgs?.repoRoot).toBe(tempDir);
    expect(capturedArgs?.expectedBranch).toBe("CTL-9005");
    expect(result.worktree).toBe("/tmp/wt-ctl-9005");
  });

  test("T6: projection seam returns completed phases → used ahead of thoughts walk", async () => {
    // No thoughts docs on disk; projection provides phases through plan.
    const result = await reconstructTicketState("CTL-9006", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => ({ completedPhases: ["triage", "research", "plan"] }),
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.completedPhases).toContain("plan");
    expect(result.nextPhase).toBe("implement");
  });

  // Codex P1 (PR #2697, round 2): "Reconcile partial projections with later
  // durable artifacts" — a shallow local projection (e.g. a synced-in triage
  // signal from a host that only just picked the ticket up) must not
  // suppress a DEEPER phase already confirmed by durable thoughts artifacts
  // (e.g. review landed from a different host earlier). The furthest-along
  // source must win, not "projection whenever it's non-empty."
  test("T7: shallow projection + deeper thoughts artifacts → the deeper thoughts result wins", async () => {
    for (const phase of ["triage", "research", "plan", "verify", "review"]) {
      writeThoughtsDoc(phase, "CTL-9007");
    }
    const result = await reconstructTicketState("CTL-9007", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      // Projection only confirms triage — shallower than the thoughts walk's
      // review-deep evidence.
      getProjection: () => ({ completedPhases: ["triage"] }),
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("pr");
    expect(result.completedPhases).toContain("review");
    expect(result.completedPhases).not.toContain("pr");
  });

  // Inverse of T7: projection is DEEPER than the thoughts walk (e.g. a host
  // with a live signal file for a phase whose thoughts doc hasn't synced
  // yet) — projection must still win here, exactly as T6 already covers for
  // the "thoughts walk finds nothing at all" case; this covers "thoughts
  // walk finds something, but shallower."
  test("T8: deeper projection + shallower thoughts artifacts → the deeper projection result wins", async () => {
    writeThoughtsDoc("triage", "CTL-9008");
    const result = await reconstructTicketState("CTL-9008", {
      repoRoot: tempDir,
      pullThoughts: () => {},
      checkArchive: () => null,
      getProjection: () => ({
        completedPhases: ["triage", "research", "plan", "implement", "verify", "review"],
      }),
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("pr");
    expect(result.completedPhases).toContain("review");
  });
});

describe("defaultCheckArchive", () => {
  let prevCatalystDir;

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = tempDir;
  });

  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
  });

  // Codex P1 (PR #2697, round 2): phase-teardown archives execution-core
  // workers by copying the worker dir to ~/catalyst/archives/<TICKET>/
  // (filesystem only) — it never inserts into archived_workers. A ticket
  // whose only durable record is that filesystem copy (PLUS the
  // .teardown-complete terminal marker written last by phase-teardown) must
  // still resolve terminal here.
  test("filesystem archive dir with files + .teardown-complete marker → terminal", async () => {
    const archiveDir = defaultArchiveDir("CTL-9101");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "phase-teardown.json"), "{}");
    writeFileSync(join(archiveDir, ".teardown-complete"), "");

    const result = await defaultCheckArchive("CTL-9101");
    expect(result?.terminal).toBe(true);
    expect(result?.completedPhases?.length).toBeGreaterThan(0);
  });

  // Codex P1 (PR #2697, round 2): "Require terminal evidence in the
  // filesystem archive" — the archive-first `cp -R` happens well BEFORE
  // worktree/branch removal and the final emit in phase-teardown. A worker
  // that crashes right after that copy leaves a populated-but-incomplete
  // archive dir; mere non-emptiness must NOT be read as terminal.
  test("filesystem archive dir populated but WITHOUT the marker (crash-after-archive) → not terminal", async () => {
    const archiveDir = defaultArchiveDir("CTL-9105");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "phase-teardown.json"), "{}");
    writeFileSync(join(archiveDir, "phase-monitor-deploy.json"), "{}");
    // deliberately no .teardown-complete

    const result = await defaultCheckArchive("CTL-9105", {
      dbPath: join(tempDir, "does-not-exist.db"),
    });
    expect(result).toBeNull();
  });

  test("filesystem archive dir empty (mkdir with no files) → not terminal", async () => {
    mkdirSync(defaultArchiveDir("CTL-9102"), { recursive: true });
    const result = await defaultCheckArchive("CTL-9102");
    expect(result).toBeNull();
  });

  test("no filesystem archive dir and no DB row → null (fail-open)", async () => {
    const result = await defaultCheckArchive("CTL-9103", {
      dbPath: join(tempDir, "does-not-exist.db"),
    });
    expect(result).toBeNull();
  });

  // Codex P1 (PR #2697, round 2): the legacy-orchestrate archived_workers DB
  // path (b) — still exercised via bun:sqlite here since these tests run
  // under `bun test`; the Node-under-bare-`node` path is proven separately
  // below via an actual subprocess (that's the runtime the finding is about).
  test("archived_workers DB row, no filesystem archive dir → terminal (bun:sqlite path)", async () => {
    const { Database } = await import("bun:sqlite");
    const dbPath = join(tempDir, "catalyst.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE archived_workers (ticket TEXT, final_status TEXT, archived_at TEXT)",
    );
    db.run(
      "INSERT INTO archived_workers (ticket, final_status, archived_at) VALUES (?, ?, ?)",
      ["CTL-9106", "done", "2026-08-01T00:00:00Z"],
    );
    db.close();

    const result = await defaultCheckArchive("CTL-9106", { dbPath });
    expect(result?.terminal).toBe(true);
  });

  // Codex P1 (PR #2697, round 2): "Make the archive database lookup work
  // under Node" — simulate the bare-Node runtime (bun:sqlite import
  // rejects) via the importBunSqlite seam and prove defaultCheckArchive
  // still resolves the row, via the sqlite3-CLI fallback engine, using a DB
  // file created independently through the real sqlite3 binary (not
  // bun:sqlite) so this doesn't just round-trip the same in-process writer.
  test("bun:sqlite import rejects (simulated Node) → falls through to sqlite3 CLI engine → terminal", async () => {
    const dbPath = join(tempDir, "cli-catalyst.db");
    execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE archived_workers (ticket TEXT, final_status TEXT, archived_at TEXT); " +
        "INSERT INTO archived_workers VALUES ('CTL-9107', 'done', '2026-08-01T00:00:00Z');",
    ]);

    const result = await defaultCheckArchive("CTL-9107", {
      dbPath,
      importBunSqlite: () => {
        throw new Error("ERR_UNSUPPORTED_ESM_URL_SCHEME (simulated plain Node)");
      },
    });
    expect(result?.terminal).toBe(true);
  });

  test("bun:sqlite import rejects (simulated Node), ticket absent from DB → null", async () => {
    const dbPath = join(tempDir, "cli-catalyst-empty.db");
    execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE archived_workers (ticket TEXT, final_status TEXT, archived_at TEXT);",
    ]);

    const result = await defaultCheckArchive("CTL-9108-not-present", {
      dbPath,
      importBunSqlite: () => {
        throw new Error("ERR_UNSUPPORTED_ESM_URL_SCHEME (simulated plain Node)");
      },
    });
    expect(result).toBeNull();
  });

  // Direct unit coverage for the CLI query helper itself, including the
  // SQL-string-escaping seam (a ticket value containing a single quote must
  // not break out of the inlined SQL literal).
  test("queryArchivedWorkersViaCli escapes embedded single quotes in the ticket value", async () => {
    const { queryArchivedWorkersViaCli } = await import("./reconstruct-ticket-state.mjs");
    const dbPath = join(tempDir, "cli-escape.db");
    execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE archived_workers (ticket TEXT, final_status TEXT, archived_at TEXT); " +
        "INSERT INTO archived_workers VALUES ('CTL-''WEIRD', 'done', '2026-08-01T00:00:00Z');",
    ]);
    const row = queryArchivedWorkersViaCli(dbPath, "CTL-'WEIRD");
    expect(row?.final_status).toBe("done");
  });
});

// Codex P1 (PR #2697, round 2): the file advertises `node
// reconstruct-ticket-state.mjs ...` at the top of the file, but a static
// `import ... from "bun:sqlite"` made plain Node fail during module load
// (ERR_UNSUPPORTED_ESM_URL_SCHEME) before argument parsing ever ran. Prove
// the advertised command actually works under the bare `node` binary, not
// just under `bun`.
describe("Node-loadable CLI contract", () => {
  test("`node reconstruct-ticket-state.mjs --ticket ... --json` runs to completion", () => {
    const scriptPath = fileURLToPath(new URL("./reconstruct-ticket-state.mjs", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [scriptPath, "--ticket", "CTL-9104-node-loadable-check", "--json"],
      {
        cwd: tempDir,
        env: { ...process.env, CATALYST_DIR: tempDir },
        encoding: "utf8",
      },
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed).toHaveProperty("nextPhase");
    expect(parsed).toHaveProperty("completedPhases");
  });
});

// ─── CTL-1490 (Codex #2697 P1): archive rows must be filtered to SUCCESS ─────
// archived_workers.final_status is copied straight from the worker signal's status
// (catalyst-archive.ts), so it also carries failed/stalled/skipped/turn-cap-exhausted.
// Treating any row as terminal told reconstruction a ticket had finished when its
// worker had actually failed — so teardown was never resumed or redispatched.
describe("defaultCheckArchive — only successful statuses are terminal (CTL-1490)", () => {
  const check = (final_status) =>
    defaultCheckArchive("T-1", {
      archiveDir: "/nonexistent",
      readdirFn: () => { throw new Error("no archive dir"); },
      dbPath: "/tmp/does-not-matter.db",
      execFileFn: () => JSON.stringify(final_status === null ? [] : [{ final_status }]),
    });

  test("done / complete are terminal", async () => {
    expect((await check("done"))?.terminal).toBe(true);
    expect((await check("complete"))?.terminal).toBe(true);
  });

  test("failed / stalled / skipped / turn-cap-exhausted are NOT terminal", async () => {
    for (const st of ["failed", "stalled", "skipped", "turn-cap-exhausted"]) {
      const r = await check(st);
      expect(r?.terminal === true).toBe(false);
    }
  });

  test("status matching is case- and whitespace-insensitive", async () => {
    expect((await check(" Done "))?.terminal).toBe(true);
  });

  test("no archived row at all stays non-terminal", async () => {
    expect((await check(null))?.terminal === true).toBe(false);
  });
});

// CTL-1490 Codex P1: the thoughts walk reads the LOCAL checkout, so on a
// cross-host resume the survivor's checkout is stale and the previous host's
// pushed phase documents cannot influence nextPhase — the survivor silently
// resumes from an earlier phase and redoes durably-complete work. The pull must
// therefore run BEFORE the walk, not after (the CLI calls this function directly,
// and the worktree rebuild that may sync thoughts happens later).
describe("thoughts refresh ordering", () => {
  test("pulls thoughts BEFORE walking them, and the pulled artifacts count", async () => {
    const order = [];
    const ticket = "CTL-9100";
    const planDir = join(tempDir, "thoughts", "shared", "plans");

    const result = await reconstructTicketState(ticket, {
      orchDir: join(tempDir, "orch"),
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: () => null,
      buildWorktree: () => ({ ok: false, cwd: null }),
      // The "remote" artifact only lands when the pull runs. If the walk happened
      // first it would see an empty thoughts tree and fall back to research.
      pullThoughts: () => {
        order.push("pull");
        mkdirSync(planDir, { recursive: true });
        writeFileSync(join(planDir, `2026-01-01-${ticket.toLowerCase()}.md`), "## Phase 1\n");
      },
    });

    expect(order).toEqual(["pull"]);
    // plan is the deepest artifact present => next phase is the one after plan.
    expect(result.completedPhases).toContain("plan");
    expect(result.nextPhase).toBe("implement");
  });

  test("a failing pull is non-fatal — reconstruction still returns a verdict", async () => {
    const result = await reconstructTicketState("CTL-9101", {
      orchDir: join(tempDir, "orch"),
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: () => null,
      buildWorktree: () => ({ ok: false, cwd: null }),
      pullThoughts: () => {
        throw new Error("pull exploded");
      },
    });
    expect(result.nextPhase).toBe("research");
  });
});
