// reconstruct-ticket-state.mjs — rebuild an in-flight ticket's phase history and
// next dispatch target from durable sources (CTL-1490 Feature F).
//
// Follows the reclaimDeadHostWork DI pattern (recovery.mjs:3543-3570):
// all collaborators are second-argument named defaults, injectable for tests.
//
// Usage (CLI):
//   node reconstruct-ticket-state.mjs --ticket CTL-XXXX [--json]

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PHASES, NEW_WORK_ENTRY_PHASE } from "../lib/workflow-descriptor.mjs";
import { createWorktree } from "./worktree.mjs";
import { defaultCheckOpenPrs } from "./open-pr-gate.mjs";

// THOUGHTS_DIRS — JS twin of bash own_thoughts_artifact_dir_for_phase.
// Phases absent from this map (implement, teardown, remediate, recovery-pass)
// produce no thoughts artifact and are skipped in the walk.
const THOUGHTS_DIRS = Object.freeze({
  triage: "thoughts/shared/phase-triage",
  research: "thoughts/shared/research",
  plan: "thoughts/shared/plans",
  verify: "thoughts/shared/phase-verify",
  review: "thoughts/shared/phase-review",
  pr: "thoughts/shared/phase-pr",
  "monitor-merge": "thoughts/shared/phase-monitor-merge",
  "monitor-deploy": "thoughts/shared/phase-monitor-deploy",
});

// hasThoughtsArtifact — mirrors bash match_thoughts_artifact's two glob patterns.
// Case-insensitive to match nocaseglob.
function hasThoughtsArtifact(absDir, ticket, { readdirFn = readdirSync } = {}) {
  const lc = ticket.toLowerCase();
  let files;
  try {
    files = readdirFn(absDir);
  } catch {
    return false;
  }
  return files.some((f) => {
    const fl = f.toLowerCase();
    return fl.endsWith(`-${lc}.md`) || fl.includes(`-${lc}-`);
  });
}

// defaultGetProjection — read workers/<ticket>/phase-*.json to derive completed
// phases from local signal files. Returns null when orchDir is absent.
function defaultGetProjection(orchDir, ticket) {
  if (!orchDir) return null;
  const workerDir = join(orchDir, "workers", ticket);
  const completed = [];
  for (const phase of PHASES) {
    try {
      const raw = JSON.parse(
        readFileSync(join(workerDir, `phase-${phase}.json`), "utf8"),
      );
      // "skipped" is terminal-success for monitor-deploy specifically (the
      // supported no-deployment path — matches scheduler.mjs deriveAdvancement's
      // `status === "done" || (status === "skipped" && latest === "monitor-deploy")`
      // semantics). For every other phase "skipped" is not a completion signal.
      const isComplete =
        raw?.status === "done" ||
        raw?.status === "complete" ||
        (raw?.status === "skipped" && phase === "monitor-deploy");
      if (isComplete) {
        completed.push(phase);
      }
    } catch {
      // no signal file for this phase — continue
    }
  }
  return completed.length > 0 ? { completedPhases: completed } : null;
}

// defaultCatalystDbPath — mirrors gateway-read.mjs's defaultDbPath idiom
// (CATALYST_DIR override, else ~/catalyst).
function defaultCatalystDbPath() {
  return resolve(process.env.CATALYST_DIR ?? `${homedir()}/catalyst`, "catalyst.db");
}

// defaultArchiveDir — filesystem archive root for a ticket, mirroring
// phase-teardown's ARCHIVE_DIR="${HOME}/catalyst/archives/${TICKET}"
// (phase-teardown/SKILL.md, archive-first step, CTL-791). The bash writer
// always resolves under literal $HOME; the JS reader additionally honors
// CATALYST_DIR (same override defaultCatalystDbPath already uses) so tests
// can redirect without touching $HOME.
export function defaultArchiveDir(ticket) {
  return join(process.env.CATALYST_DIR ?? `${homedir()}/catalyst`, "archives", ticket);
}

// ARCHIVE_TERMINAL_MARKER — phase-teardown's proof-of-completion file, written
// into the archive dir strictly LAST (phase-teardown/SKILL.md's
// phase-teardown-emit fence, after archiving, worktree/branch removal, the
// Linear mirror, AND the terminal event emit have all already run). The
// archive-first `cp -R` itself happens much earlier (CTL-791), so a worker
// that crashes right after that copy — before worktree removal or the final
// emit — leaves a populated but INCOMPLETE archive dir. Checking for mere
// non-emptiness cannot tell that crash apart from a genuine finish; this
// marker's presence is the only thing that can (Codex round-2, PR #2697).
const ARCHIVE_TERMINAL_MARKER = ".teardown-complete";

// defaultCheckArchive — fail-open lookup for a ticket that has already been
// fully archived. Two independent sources, either one is sufficient:
//
//   (a) The filesystem archive dir phase-teardown writes for EVERY
//       execution-core-dispatched ticket (`cp -R` of the worker dir to
//       ~/catalyst/archives/<TICKET>/, unconditional archive-first step —
//       phase-teardown/SKILL.md:345-362). This is the ONLY durable record
//       for that path: a normally completed execution-core ticket's local
//       workers/<TICKET>/ signals are removed once its worktree is torn
//       down, so without (a) this check always returns null post-teardown
//       and reconstruction falls back to the thoughts-artifact walk, finds
//       monitor-deploy as the last artifact, and rebuilds a worktree to
//       resume teardown on an already-done ticket. Terminal is asserted only
//       by ARCHIVE_TERMINAL_MARKER's presence, not the dir's non-emptiness —
//       see that constant's comment for why.
//   (b) The archived_workers SQLite index (ADR-011 / migration
//       003_archives.sql), populated by the orchestrator-level
//       `catalyst-archive.ts sweep` run at the end of the legacy
//       /catalyst-legacy:orchestrate pipeline (Phase 7) — a distinct
//       completion path that never writes the filesystem dir (a).
//
// (b) is read through TWO engines, tried in order, so the advertised
// `node reconstruct-ticket-state.mjs` CLI usage (top-of-file comment) gets a
// real answer under bare Node, not a silent no-op: bun:sqlite (imported
// dynamically so a static import can't fail Node at module-load time, before
// argument parsing ever runs) is tried first when available, then the
// `sqlite3` CLI (AGENTS.md → Dependencies lists it as an optional but
// expected tool) via a read-only query as a Node-safe fallback. Either
// engine failing (missing binary, absent DB, pre-archive-migration schema,
// lock contention) is swallowed — reconstruction proceeds via check (a) or
// the other sources instead.
function queryArchivedWorkersViaBun(dbPath, ticket, DatabaseCtor) {
  let db;
  try {
    db = new DatabaseCtor(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    return db
      .query(
        "SELECT final_status FROM archived_workers WHERE ticket = ? ORDER BY archived_at DESC LIMIT 1",
      )
      .get(ticket);
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

export function queryArchivedWorkersViaCli(dbPath, ticket, { execFileFn = execFileSync } = {}) {
  // sqlite3's CLI has no bind-parameter syntax over argv, so the value is
  // inlined into the SQL text with SQL-string escaping (double any embedded
  // single quote) rather than shell escaping — execFileFn (execFileSync, no
  // shell) already removes the shell-injection surface; this only prevents
  // breaking out of the SQL string literal.
  const escaped = String(ticket).replace(/'/g, "''");
  const sql =
    `SELECT final_status FROM archived_workers WHERE ticket = '${escaped}' ` +
    "ORDER BY archived_at DESC LIMIT 1;";
  // `.timeout` (a dot-command) sets the busy timeout WITHOUT emitting its own
  // row under -json — unlike `PRAGMA busy_timeout=250` (as a -cmd), which
  // would print its own `[{"timeout":250}]` JSON array ahead of the SELECT's
  // output and break single-JSON.parse on the combined stdout.
  const out = execFileFn(
    "sqlite3",
    ["-readonly", "-json", "-cmd", ".timeout 250", dbPath, sql],
    { encoding: "utf8" },
  );
  const trimmed = out.trim();
  // Zero matching rows → sqlite3 -json prints nothing at all for that
  // statement (not `[]`), so an empty stdout means "no row", not an error.
  if (!trimmed) return undefined;
  const rows = JSON.parse(trimmed);
  return rows[0];
}

// CTL-1490 (Codex #2697 P1): only a SUCCESSFUL completion is terminal evidence.
//
// archived_workers.final_status is copied straight from the worker signal's `status`
// (catalyst-archive.ts), so the column also carries "failed", "stalled", "skipped" and
// "turn-cap-exhausted" — every LIFECYCLE-terminal state, not just success. Treating any
// row as terminal told reconstruction a ticket had finished when its worker had in fact
// failed or stalled, so teardown was never resumed or redispatched. A non-success row
// must fall through to the artifact walk, exactly as a missing row does.
const ARCHIVE_TERMINAL_STATUSES = new Set(["done", "complete"]);

function isArchiveTerminalRow(row) {
  if (!row) return false;
  const st = String(row.final_status ?? "").trim().toLowerCase();
  return ARCHIVE_TERMINAL_STATUSES.has(st);
}

export async function defaultCheckArchive(
  ticket,
  {
    archiveDir = defaultArchiveDir(ticket),
    dbPath = defaultCatalystDbPath(),
    readdirFn = readdirSync,
    execFileFn = execFileSync,
    // importBunSqlite — injectable so tests can simulate "running under
    // plain Node" (where `import("bun:sqlite")` rejects) without actually
    // spawning a node subprocess for every case; defaults to the real
    // dynamic import.
    importBunSqlite = () => import("bun:sqlite"),
  } = {},
) {
  try {
    const files = readdirFn(archiveDir);
    if (files && files.includes(ARCHIVE_TERMINAL_MARKER)) {
      return { terminal: true, completedPhases: PHASES.slice() };
    }
  } catch {
    // no filesystem archive dir for this ticket — fall through to (b)
  }

  try {
    const { Database } = await importBunSqlite();
    const row = queryArchivedWorkersViaBun(dbPath, ticket, Database);
    if (isArchiveTerminalRow(row)) return { terminal: true, completedPhases: PHASES.slice() };
    return null;
  } catch {
    // bun:sqlite unavailable (plain Node) or the query itself failed —
    // fall through to the CLI engine below rather than giving up.
  }

  try {
    const row = queryArchivedWorkersViaCli(dbPath, ticket, { execFileFn });
    if (isArchiveTerminalRow(row)) return { terminal: true, completedPhases: PHASES.slice() };
    return null;
  } catch {
    return null;
  }
}

// defaultBuildWorktree — create or reuse the ticket's worktree, always passing
// expectedBranch so the CTL-615 collision guard fires on cross-host takeover.
function defaultBuildWorktree(ticket, { repoRoot, orchDir }) {
  try {
    const root = repoRoot ?? join(orchDir, "..", "..");
    const res = createWorktree({ ticket, repoRoot: root, expectedBranch: ticket });
    return { ok: res?.code === 0 && !!res.worktreePath, cwd: res?.worktreePath ?? null };
  } catch {
    return { ok: false, cwd: null };
  }
}

// defaultPullThoughts — run the mode-aware, ff-only pull-before-read gate so the
// thoughts walk below sees a peer's freshly-pushed artifacts (CTL-1490 Codex P1).
// The gate is NON-FATAL by contract in every mode (read side never blocks the
// pipeline), and this wrapper is belt-and-braces on top of that: any spawn failure
// — gate missing, bash absent, non-zero exit — degrades to "walk what is on disk",
// which is exactly the previous behaviour.
function defaultPullThoughts({ repoRoot } = {}) {
  const selfDir = fileURLToPath(new URL(".", import.meta.url));
  const gate = resolve(selfDir, "..", "lib", "thoughts-pull-sync-gate.sh");
  try {
    execFileSync("bash", [gate], {
      cwd: repoRoot ?? process.cwd(),
      stdio: "ignore",
      timeout: 120_000,
    });
  } catch {
    // Non-fatal by design — see above.
  }
}

// reconstructTicketState — main export.
//
// Returns { nextPhase, completedPhases, pr, worktree }.
// nextPhase is null for terminal (done/teardown complete).
// completedPhases is the list of phases with confirmed durable artifacts.
// pr is the first open PR found, or null.
// worktree is the path to the rebuilt worktree, or null on failure/terminal.
//
// Composition order:
//   1. Archive check → terminal short-circuit
//   2. Projection (signal files) AND 3. thoughts-artifact walk are BOTH
//      always computed, then reconciled to whichever source confirms the
//      FURTHER phase (Codex P1, PR #2697 round 2: a host that retains only a
//      shallow local projection — e.g. a synced-in triage signal — must not
//      regress a deeper phase confirmed by durable thoughts artifacts that
//      landed from elsewhere, such as when a ticket moves between hosts and
//      later returns). Neither source is treated as a fallback-only branch.
//   4. Open-PR union
//   5. Worktree rebuild (non-terminal only)
export async function reconstructTicketState(
  ticket,
  {
    orchDir = process.env.CATALYST_ORCHESTRATOR_DIR,
    repoRoot = process.cwd(),
    checkArchive = defaultCheckArchive,
    getProjection = defaultGetProjection,
    checkOpenPrs = (t) => defaultCheckOpenPrs(t, { cwd: repoRoot }),
    buildWorktree = defaultBuildWorktree,
    pullThoughts = defaultPullThoughts,
  } = {},
) {
  // 1. Archive check — terminal short-circuit. If the ticket is Done/archived,
  //    skip worktree rebuild and return terminal immediately.
  const archive = await checkArchive(ticket);
  if (archive?.terminal) {
    return {
      nextPhase: null,
      completedPhases: archive.completedPhases ?? [],
      pr: null,
      worktree: null,
    };
  }

  // 2. Projection (signal files) — source A. projLastIdx is the PHASES index
  // of the furthest phase it confirms, or -1 when it has nothing usable
  // (no data, or a last-phase name that doesn't resolve in PHASES).
  const projection = getProjection ? await getProjection(orchDir, ticket) : null;
  let projCompletedPhases = [];
  let projLastIdx = -1;
  if (projection?.completedPhases?.length > 0) {
    const last = projection.completedPhases[projection.completedPhases.length - 1];
    const lastIdx = PHASES.indexOf(last);
    if (lastIdx >= 0) {
      projCompletedPhases = projection.completedPhases;
      projLastIdx = lastIdx;
    }
  }

  // 2b. Refresh thoughts BEFORE walking them (CTL-1490 Codex P1).
  //
  // The whole point of the durable artifacts is cross-host resume: the previous
  // host pushes its completed phase documents, a survivor picks the ticket up.
  // But this walk reads the LOCAL thoughts checkout, and on the survivor that
  // checkout is stale — the CLI calls reconstructTicketState directly, and the
  // worktree rebuild (which may init/sync thoughts) happens only AFTER this
  // scan. So the remote artifacts that justify the feature could never influence
  // nextPhase, and the survivor silently resumed from an earlier phase, redoing
  // work that was already durably complete.
  //
  // The pull gate is mode-aware and NON-FATAL by contract in every mode, so a
  // failed or skipped pull degrades to exactly the previous behaviour (walk what
  // is on disk) rather than blocking reconstruction.
  try {
    await pullThoughts({ repoRoot });
  } catch {
    // Structurally non-fatal, not merely non-fatal by convention: the contract is
    // "the read side never blocks the pipeline", so it must hold for ANY injected
    // implementation, not only the default one that happens to catch internally.
    // A failed refresh degrades to walking whatever is already on disk.
  }

  // 3. Thoughts-artifact walk — source B, ALWAYS computed (not gated on
  // whether the projection had data). Reverse-walk PHASES; first hit = last
  // completed.
  let thoughtsCompletedPhases = [];
  let thoughtsLastIdx = -1;
  for (let i = PHASES.length - 1; i >= 0; i--) {
    const phase = PHASES[i];
    const relDir = THOUGHTS_DIRS[phase];
    if (!relDir) continue;
    const absDir = join(repoRoot, relDir);
    if (hasThoughtsArtifact(absDir, ticket)) {
      thoughtsLastIdx = i;
      thoughtsCompletedPhases = PHASES.slice(0, i + 1).filter((p) => THOUGHTS_DIRS[p]);
      break;
    }
  }

  // Reconcile — whichever source confirms the FURTHER phase wins outright
  // (never a merge of the two completedPhases lists: PHASES is a strict
  // linear order, so the deeper source's list is already a superset of
  // everything the shallower source could have confirmed).
  let completedPhases;
  let nextPhase;
  if (projLastIdx >= thoughtsLastIdx && projLastIdx >= 0) {
    completedPhases = projCompletedPhases;
    nextPhase = PHASES[projLastIdx + 1] ?? null;
  } else if (thoughtsLastIdx >= 0) {
    completedPhases = thoughtsCompletedPhases;
    nextPhase = PHASES[thoughtsLastIdx + 1] ?? null;
  } else {
    completedPhases = [];
    nextPhase = NEW_WORK_ENTRY_PHASE;
  }

  // 4. Open-PR union — fail-open; a gh/network failure must not block reconstruction.
  let pr = null;
  try {
    const result = await checkOpenPrs(ticket);
    pr = result?.prs?.[0] ?? null;
  } catch {
    // fail-open
  }

  // 5. Worktree rebuild — only when non-terminal; fail-open.
  let worktree = null;
  if (nextPhase !== null) {
    try {
      const res = await buildWorktree(ticket, {
        orchDir,
        repoRoot,
        // Explicit even though defaultBuildWorktree hardcodes it: an INJECTED
        // buildWorktree collaborator relies on this DI contract (tested in T5),
        // so it is not actually redundant.
        expectedBranch: ticket,
      });
      worktree = res?.ok ? (res.cwd ?? null) : null;
    } catch {
      // fail-open
    }
  }

  return { nextPhase, completedPhases, pr, worktree };
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const ticketIdx = args.indexOf("--ticket");
  const ticket = ticketIdx >= 0 ? args[ticketIdx + 1] : null;
  const asJson = args.includes("--json");

  if (!ticket) {
    console.error("Usage: reconstruct-ticket-state.mjs --ticket CTL-XXXX [--json]");
    process.exit(1);
  }

  reconstructTicketState(ticket)
    .then((result) => {
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`ticket:           ${ticket}`);
        console.log(`nextPhase:        ${result.nextPhase ?? "(terminal)"}`);
        console.log(`completedPhases:  ${result.completedPhases.join(", ") || "(none)"}`);
        console.log(`pr:               ${result.pr ? `#${result.pr.number}` : "(none)"}`);
        console.log(`worktree:         ${result.worktree ?? "(none)"}`);
      }
    })
    .catch((err) => {
      console.error("reconstruct-ticket-state: fatal:", err.message);
      process.exit(1);
    });
}
