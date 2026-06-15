// job-dir-gc.mjs — CTL-1165 D3. Garbage-collect stale ~/.claude/jobs/<id> dirs.
//
// THE LEAK: every reference to a job dir in the codebase is READ-ONLY
// (session-resolve.mjs, recovery.mjs defaultStatJob, claude-agents.mjs
// defaultStatJobState). Nothing ever deletes them — so on a long-uptime host
// ~1798 dirs (864 MB) accumulated and helped exhaust RAM + swap on mini.
//
// THE FIX: a filesystem-only, fail-CLOSED sweep that deletes a job dir ONLY
// when THREE independent gates ALL pass:
//   (0) fail-closed liveness FIRST — if `claude agents` can't be read
//       ({ ok:false }), ABORT the whole sweep and delete nothing. Treating a
//       read failure as an empty fleet would collapse the live-set and authorize
//       deleting a LIVE worker's dir (mirrors defaultAssessWorktreeRemoval's
//       fail-closed liveness, reaper.mjs).
//   (1) basename ∉ liveShortIds — the dir's 8-char short-id is not a currently
//       registered `claude agents` session.
//   (2) NOT the self/controlling session (isSelfSession).
//   (3) mtime age >= retention (default 24h ≫ any phase duration).
//
// DELETE PRIMITIVE: plain fs.rm(dir, {recursive, force}) of the JOB DIR ALONE —
// NOT `claude rm`. `claude rm` also tears down the worktree (claude-ids.mjs); a
// dead unregistered dir has nothing to deregister, and a short-id collision with
// a live worktree would be catastrophic. We reclaim DISK only — a still-
// registered status:null zombie's dir is PRESERVED by the liveness gate; its
// eviction is D4's job.

import { readdir, stat, rm as rmAsync } from "node:fs/promises";
import { join } from "node:path";
import { getJobsRoot, log as defaultLog } from "./config.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";
import { emitReapIntent } from "./reap-intent.mjs";

// Defaults are config/env-driven (no magic numbers): 24h retention, 200/batch.
const DEFAULT_RETENTION_SECONDS = 86_400; // 24h
const DEFAULT_BATCH_CAP = 200;

/**
 * sweepJobDirs — GC stale ~/.claude/jobs/<id> dirs. Fail-closed, fail-safe,
 * bounded. Every IO/clock/emit primitive is an injected, defaulted seam so the
 * unit test never reads the real jobs root, calls real rmSync, or spawns claude.
 *
 * @returns {Promise<{reclaimed, scanned, skippedLive, skippedRecent, errors, batchCapped, skipped?}>}
 */
export async function sweepJobDirs({
  jobsRoot = getJobsRoot(),
  readDir = (p) => readdir(p),
  statDir = (p) => stat(p),
  rm = (p, opts) => rmAsync(p, opts),
  readAgents = listClaudeAgentsResult,
  now = () => Date.now(),
  retentionMs = (Number(process.env.CATALYST_JOB_GC_RETENTION_SECONDS) ||
    DEFAULT_RETENTION_SECONDS) * 1000,
  batchCap = Number(process.env.CATALYST_JOB_GC_BATCH_CAP) || DEFAULT_BATCH_CAP,
  emit = emitReapIntent,
  env = process.env,
  log = defaultLog,
} = {}) {
  // Gate 0 — fail-closed liveness FIRST. A FAILED `claude agents` read
  // ({ ok:false }) is NOT a genuinely-empty fleet: deleting on a read failure
  // would authorize evicting a live worker's dir. Abort, delete nothing.
  let agentsResult;
  try {
    agentsResult = readAgents();
  } catch {
    agentsResult = { ok: false, agents: [] };
  }
  if (!agentsResult || agentsResult.ok !== true) {
    log.warn(
      { jobsRoot },
      "job-dir-gc: `claude agents` unreadable — aborting sweep (fail-closed), deleting nothing"
    );
    return {
      reclaimed: 0,
      scanned: 0,
      skippedLive: 0,
      skippedRecent: 0,
      errors: 0,
      batchCapped: false,
      skipped: "agents-unreadable",
    };
  }

  // Build the live short-id set from the (confirmed-good) agents snapshot.
  // A malformed/empty sessionId → null → filtered, so a bad row can never
  // accidentally PROTECT or AUTHORIZE deletion of an unrelated basename.
  const liveShortIds = new Set();
  for (const a of agentsResult.agents ?? []) {
    let short = null;
    try {
      short = shortIdFromSessionId(a?.sessionId);
    } catch {
      short = null;
    }
    if (short) liveShortIds.add(short);
  }

  // Enumerate the jobs root. ENOENT (root absent) → [] (mirrors detectColdStart
  // recovery.mjs). Any other read error → degrade safe: nothing to sweep.
  let basenames;
  try {
    basenames = await readDir(jobsRoot);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn({ jobsRoot, err: err?.message }, "job-dir-gc: jobs root unreadable; skipping sweep");
    }
    return {
      reclaimed: 0,
      scanned: 0,
      skippedLive: 0,
      skippedRecent: 0,
      errors: 0,
      batchCapped: false,
    };
  }

  const nowMs = now();
  let reclaimed = 0;
  let scanned = 0;
  let skippedLive = 0;
  let skippedRecent = 0;
  let errors = 0;
  let batchCapped = false;

  for (const basename of basenames) {
    scanned++;

    // Gate 1 — not a live registered session (string compare of 8-char ids).
    if (liveShortIds.has(basename)) {
      skippedLive++;
      continue;
    }

    // Gate 2 — never the self/controlling session.
    if (isSelfSession(basename, env)) {
      skippedLive++;
      continue;
    }

    // Gate 3 — mtime age >= retention. Per-dir stat failure (e.g. ENOENT
    // because the dir vanished between readdir and stat) → errors++, continue;
    // never throw, never abort the batch.
    const dir = join(jobsRoot, basename);
    let st;
    try {
      st = await statDir(dir);
    } catch {
      errors++;
      continue;
    }
    const mtimeMs = st?.mtimeMs ?? nowMs; // unknown mtime → treat as recent (spare)
    if (nowMs - mtimeMs < retentionMs) {
      skippedRecent++;
      continue;
    }

    // batchCap — stop reclaiming once we would exceed the cap; the remainder
    // drains on the next tick. We mark batchCapped and break so a single sweep
    // can never rm an unbounded number of dirs.
    if (reclaimed >= batchCap) {
      batchCapped = true;
      break;
    }

    // All gates passed — delete the JOB DIR ALONE (never `claude rm`).
    try {
      await rm(dir, { recursive: true, force: true });
      reclaimed++;
    } catch {
      errors++;
    }
  }

  // Best-effort flag emit (never throws; emitReapIntent returns false on a
  // write failure). Only emit when we actually reclaimed something.
  if (reclaimed > 0) {
    try {
      await emit("jobs.gc.swept", { reclaimed, scanned });
    } catch (err) {
      log.warn({ err: err?.message }, "job-dir-gc: jobs.gc.swept emit failed");
    }
  }

  return { reclaimed, scanned, skippedLive, skippedRecent, errors, batchCapped };
}
