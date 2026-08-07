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
//       resume teardown on an already-done ticket.
//   (b) The archived_workers SQLite index (ADR-011 / migration
//       003_archives.sql), populated by the orchestrator-level
//       `catalyst-archive.ts sweep` run at the end of the legacy
//       /catalyst-legacy:orchestrate pipeline (Phase 7) — a distinct
//       completion path that never writes the filesystem dir (a).
//
// `Database` (bun:sqlite) is imported dynamically and only inside the (b)
// branch so this file stays loadable under plain Node per its own advertised
// `node reconstruct-ticket-state.mjs` CLI usage (top-of-file comment): a
// static `import ... from "bun:sqlite"` fails Node at module-load time,
// before argument parsing or reconstruction ever runs. Under bun the dynamic
// import resolves normally; under Node it rejects and is swallowed by the
// same fail-open contract that already covers an absent DB, a
// pre-archive-migration schema, or lock contention — reconstruction proceeds
// via check (a) or the other sources instead.
export async function defaultCheckArchive(
  ticket,
  {
    archiveDir = defaultArchiveDir(ticket),
    dbPath = defaultCatalystDbPath(),
    readdirFn = readdirSync,
  } = {},
) {
  try {
    const files = readdirFn(archiveDir);
    if (files && files.length > 0) {
      return { terminal: true, completedPhases: PHASES.slice() };
    }
  } catch {
    // no filesystem archive dir for this ticket — fall through to (b)
  }

  let db;
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    const row = db
      .query(
        "SELECT final_status FROM archived_workers WHERE ticket = ? ORDER BY archived_at DESC LIMIT 1",
      )
      .get(ticket);
    if (!row) return null;
    return { terminal: true, completedPhases: PHASES.slice() };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
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
//   2. Projection (signal files) → completedPhases + nextPhase (best-effort first)
//   3. Thoughts-artifact walk → fallback when projection is empty
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

  // 2 + 3. Determine completedPhases and nextPhase.
  let completedPhases = [];
  let nextPhase = NEW_WORK_ENTRY_PHASE;

  const projection = getProjection ? await getProjection(orchDir, ticket) : null;
  if (projection?.completedPhases?.length > 0) {
    // Projection wins — use signal-file-derived data as the best-effort source.
    completedPhases = projection.completedPhases;
    const last = completedPhases[completedPhases.length - 1];
    const lastIdx = PHASES.indexOf(last);
    nextPhase = lastIdx >= 0 ? (PHASES[lastIdx + 1] ?? null) : NEW_WORK_ENTRY_PHASE;
  } else {
    // Thoughts-artifact walk — reverse-walk PHASES; first hit = last completed.
    for (let i = PHASES.length - 1; i >= 0; i--) {
      const phase = PHASES[i];
      const relDir = THOUGHTS_DIRS[phase];
      if (!relDir) continue;
      const absDir = join(repoRoot, relDir);
      if (hasThoughtsArtifact(absDir, ticket)) {
        nextPhase = PHASES[i + 1] ?? null;
        completedPhases = PHASES.slice(0, i + 1).filter((p) => THOUGHTS_DIRS[p]);
        break;
      }
    }
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
