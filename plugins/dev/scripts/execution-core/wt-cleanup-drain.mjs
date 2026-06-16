// wt-cleanup-drain.mjs — CTL-1218 Part C. Periodic reader for the
// ~/catalyst/wt-cleanup-queue/*.json deferral markers deferWorktreeCleanup writes
// (worktree-safety.mjs). Pre-1218 the queue had ZERO readers (the CTL-792 drain
// was never built), so every deferred worktree re-deferred on every 600s tick and
// ~62 stale trees accumulated on mini.
//
// THE FIX: a fail-soft, bounded sweep, modeled on worker-dir-gc.mjs's sweep shape:
//   - A marker whose worktree path is already GONE → just delete the marker (the
//     bulk after the first drain; no git/gh, no teardown).
//   - A SURVIVING worktree → confirm the PR is merged (fail-CLOSED), then re-run
//     the CTL-791 gated safeTeardownWorktree (NEVER --force). On success the
//     teardown clears its OWN marker (worktree-safety clearDeferMarker); on a
//     re-defer the marker is left for the next tick.
//
// Every IO/spawn/clock seam is injected + defaulted so the unit test never reads
// real disk, git, or gh. Wired into the existing 600s orphan-reaper timer
// (orphan-reaper-timer.mjs) — no new daemon timer.

import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeTeardownWorktree, listOrchDirs } from "./worktree-safety.mjs";
import { getExecutionCoreDir, log as defaultLog } from "./config.mjs";
import { makePrView } from "./scan-adapters.mjs";
import { defaultResolvePrForEvent } from "./reaper.mjs";

const DEFAULT_QUEUE_DIR = join(homedir(), "catalyst", "wt-cleanup-queue");
const DEFAULT_BATCH_CAP = 100;

// defaultConfirmMerged — confirm a marker's PR is GitHub-merged, the SAME dual-field
// check the gate uses (state === "MERGED" || mergedAt != null). Fail-CLOSED: any
// unresolvable PR / gh error → false, so the re-attempt passes prMerged:false and
// the gate defers rather than removing on a guess.
function defaultConfirmMerged(marker, { prView, resolvePr } = {}) {
  try {
    const event = {
      worktree_path: marker.worktreePath,
      ticket: marker.ticket,
      branch: marker.branch,
    };
    const pr = (resolvePr ?? ((e) => defaultResolvePrForEvent(e)))(event);
    if (!pr?.number) return false;
    const view = (prView ?? makePrView(() => marker.worktreePath))(marker.ticket, pr);
    return view?.state === "MERGED" || view?.mergedAt != null;
  } catch {
    return false;
  }
}

/**
 * sweepWtCleanupQueue — drain ~/catalyst/wt-cleanup-queue/*.json once. Fail-soft,
 * bounded, idempotent. Returns a summary:
 *   { scanned, cleared, reattempted, removed, stillDeferred, errors, batchCapped }
 *
 * @returns {Promise<object>}
 */
export async function sweepWtCleanupQueue({
  queueDir = DEFAULT_QUEUE_DIR,
  orchDir = getExecutionCoreDir(),
  readDir = (p) => readdirSync(p),
  readFileFn = (p) => readFileSync(p, "utf8"),
  pathExists = (p) => existsSync(p),
  clearMarker = (file) => rmSync(file, { force: true }),
  safeTeardown = safeTeardownWorktree,
  confirmMerged = (marker) => defaultConfirmMerged(marker),
  batchCap = Number(process.env.CATALYST_WT_DRAIN_BATCH_CAP) || DEFAULT_BATCH_CAP,
  log = defaultLog,
} = {}) {
  const result = {
    scanned: 0,
    cleared: 0,
    reattempted: 0,
    removed: 0,
    stillDeferred: 0,
    errors: 0,
    batchCapped: false,
  };

  let files;
  try {
    files = readDir(queueDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { queueDir, err: err?.message },
        "wt-cleanup-drain: queue dir unreadable; skipping sweep"
      );
    }
    return result;
  }

  const orchDirs = [orchDir, ...listOrchDirs()];

  for (const f of files) {
    result.scanned++;
    const file = join(queueDir, f);

    let marker;
    try {
      marker = JSON.parse(readFileFn(file));
    } catch {
      // Malformed/unreadable marker → skip (never throw); leave it for an operator.
      result.errors++;
      continue;
    }
    const worktreePath = marker?.worktreePath;
    if (!worktreePath || typeof worktreePath !== "string") {
      result.errors++;
      continue;
    }

    // Already-gone worktree → just clear the stale marker (the post-removal bulk).
    let exists;
    try {
      exists = pathExists(worktreePath);
    } catch {
      exists = true; // probe failed → treat as surviving (fail-closed; never delete blindly)
    }
    if (!exists) {
      try {
        clearMarker(file);
        result.cleared++;
      } catch {
        result.errors++;
      }
      continue;
    }

    // Surviving worktree → re-attempt the gated teardown, bounded.
    if (result.reattempted >= batchCap) {
      result.batchCapped = true;
      break;
    }
    result.reattempted++;

    let prMerged = false;
    try {
      prMerged = confirmMerged(marker) === true;
    } catch {
      prMerged = false; // fail-closed
    }

    let outcome;
    try {
      outcome = safeTeardown(
        {
          repoRoot: worktreePath, // git -C <worktree> works for the gate's probes
          ticket: marker.ticket ?? null,
          worktreePath,
          branch: marker.branch ?? null,
          terminal: true,
          prMerged,
        },
        { orchDirs }
      );
    } catch (err) {
      log.warn({ worktreePath, err: err?.message }, "wt-cleanup-drain: safeTeardown threw");
      result.errors++;
      continue;
    }

    if (outcome?.removed === true) {
      // safeTeardownWorktree clears its own marker on success (clearDeferMarker);
      // an alreadyAbsent removal means the path vanished mid-flight — clear here too.
      result.removed++;
      if (outcome.alreadyAbsent === true) {
        try {
          clearMarker(file);
        } catch {
          /* best-effort */
        }
      }
    } else {
      result.stillDeferred++;
    }
  }

  return result;
}
