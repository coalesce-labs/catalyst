// unstuck-act-seams.mjs — CTL-1219 deterministic act-seam registry for the
// unstuck-sweep Pass 0u driver (unstuck-sweep.mjs:runUnstuckSweepPass).
//
// Pass 0u classifies the stalled/needs-human ticket backlog into four typed
// categories (dirty-tree, source-conflict, orphan-stale, stale-label). The
// classifiers are PURE and already shipped + tested (dirty-tree-classifier.mjs,
// catB-force-with-lease.mjs, unstuck-orphan-merge.mjs, unstuck-stale-label.mjs).
// This module supplies the MECHANICAL act seams the driver invokes once per
// candidate when mode === 'enforce'.
//
// Driver seam contract (unstuck-sweep.mjs:405-440 — frozen, do not deviate):
//   • actByCategory[decision.category](candidate, decision) — return value IGNORED.
//   • THROW on hard failure → the driver records report.failed and skips all
//     post-act bookkeeping (intent / comment / event).
//   • Return normally (incl. undefined) → success → the driver records the intent,
//     posts the Linear audit comment, and fires the enforce event.
//   • The seam MUST NOT call recordIntent / postComment / emit / fire itself —
//     the driver owns ALL post-act bookkeeping.
//
// Every seam is the thin ORCHESTRATION over an existing PURE classifier; the
// safety decision is re-validated against the LIVE worktree at act time (not the
// stale census evidence). Every IO operation (git, fs, label removal, event
// append, signal re-arm) is an injected dependency with a real default, so the
// unit tests drive each seam with stub deps — zero real git / fs / Linear.
//
// Ships gated behind the three-layer mode gate (config.mjs:readUnstuckSweepConfig)
// which defaults to 'off'. Wiring this registry into the scheduler does NOT flip
// enforce on — enforce is an operator decision per ADR-023 (CTL-1219).

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log as defaultLog } from "./config.mjs";
import { filterMachineLocalDirt, isNodeModulesDeletion } from "./dirty-tree-classifier.mjs";
import { classifyCleanRebaseForcePush } from "./catB-force-with-lease.mjs";
import { classifyOrphanMergedReconcile } from "./unstuck-orphan-merge.mjs";
import { clearStalledLabel, inRemovalBackoff } from "./label-guard.mjs";

// phase-agent-emit-complete sits two directories up from execution-core/
// (mirrors recovery.mjs:86 — the canonical synthetic-complete emitter).
const EMIT_COMPLETE_BIN = fileURLToPath(new URL("../phase-agent-emit-complete", import.meta.url));

// ─── default IO seams ───────────────────────────────────────────────────────
// Each is overridable via deps; the production defaults shell to real git / fs /
// the emit-complete script. The classifier/collector pattern of this subsystem
// (collectForcePushCandidates' runGit, clearStalledLabel's writeStatus).

function defaultRunGit(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function defaultReadPorcelain(worktreePath, runGit) {
  // Non-zero exit / spawn error → null so the classifier fails closed (never
  // auto-acts on an unknown tree state — mirrors collectForcePushCandidates).
  const res = runGit(["-C", worktreePath, "status", "--porcelain"]);
  if (res?.error || (res?.status ?? 1) !== 0) return null;
  return res.stdout ?? "";
}

function defaultMarkerExists(p) {
  return existsSync(p);
}

function defaultWriteMarker(p) {
  try {
    mkdirSync(join(p, ".."), { recursive: true });
  } catch {
    /* best-effort dir create */
  }
  writeFileSync(p, "");
}

function defaultUnlink(p) {
  try {
    unlinkSync(p);
  } catch {
    /* best-effort — already gone is success */
  }
}

// defaultEmitPhaseComplete — emit a synthetic phase.<phase>.complete.<ticket>
// canonical event via the phase-agent-emit-complete script (matching how
// recovery.mjs's reclaim path emits synthetic completes). --no-signal-update so
// we only WAKE the orchestrator with the event; the seam does not own the signal
// flip. Returns true on a zero exit, false otherwise (the seam throws on false).
function defaultEmitPhaseComplete({ ticket, phase, orchDir }, { spawn = spawnSync } = {}) {
  const args = ["--phase", phase, "--ticket", ticket, "--status", "complete", "--no-signal-update"];
  if (orchDir) args.push("--orch-dir", orchDir, "--orch-id", ticket);
  const res = spawn(EMIT_COMPLETE_BIN, args, { encoding: "utf8" });
  if (res?.error) return false;
  return (res?.status ?? 1) === 0;
}

// markerPath — the per-(ticket, phase) idempotency once-marker under workers/<T>/.
function markerPath(orchDir, ticket, phase, name) {
  return join(orchDir ?? ".", "workers", ticket, `.unstuck-${name}-${phase}.applied`);
}

// ─── Phase 1: dirty-tree act seam ─────────────────────────────────────────────
//
// Clears machine-local rebase noise (REBASE_NOISE_PATHS + deleted node_modules)
// from the worktree, then re-arms the worker (clearStall deletes the stalled
// signal so the phase re-dispatches next tick). FAIL-CLOSED: throws if the tree
// carries real work (filterMachineLocalDirt non-empty), if the worktree path is
// null, or if the tree is still dirty after the clear. Idempotent via the
// .unstuck-cleared-<phase>.applied marker.
export function buildDirtyTreeActSeam(deps = {}) {
  const {
    runGit = defaultRunGit,
    readPorcelain = (wt) => defaultReadPorcelain(wt, runGit),
    unlink = defaultUnlink,
    writeMarker = defaultWriteMarker,
    markerExists = defaultMarkerExists,
    clearStall = () => true,
    orchDir = null,
    log = defaultLog,
  } = deps;

  return function dirtyTreeActSeam(candidate, _decision) {
    const { ticket, phase, worktreePath } = candidate;
    if (!worktreePath) throw new Error(`dirty-tree: no-worktree (${ticket})`);

    const marker = markerPath(orchDir, ticket, phase, "cleared");
    if (markerExists(marker)) return; // idempotent — already cleared this lifetime.

    const porcelain = readPorcelain(worktreePath);
    // Fail-closed on unreadable porcelain (never auto-clear an unknown state).
    if (porcelain === null || porcelain === undefined) {
      throw new Error(`dirty-tree: unreadable-porcelain (${ticket})`);
    }

    const lines = porcelain.split("\n").filter((l) => l.trim().length > 0);
    const realDirt = filterMachineLocalDirt(lines);
    if (realDirt.length > 0) {
      // Real uncommitted work present → never auto-clear (fail-closed, mirrors
      // classifyDirtyTreeRecoverable's escalate/real-dirt-present).
      throw new Error(`dirty-tree: real-dirt-present (${ticket}): ${realDirt.length} line(s)`);
    }

    // Only noise + deleted node_modules remain → clear each path mechanically.
    for (const line of lines) {
      const xy = line.slice(0, 2);
      const path = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!path) continue;
      if (xy.startsWith("??")) {
        // Untracked noise → remove from disk.
        unlink(join(worktreePath, path));
      } else if (isNodeModulesDeletion(line)) {
        // A deleted (tracked) node_modules path → restore from index.
        runGit(["-C", worktreePath, "checkout", "--", path]);
      } else {
        // Tracked noise modification → restore from index.
        runGit(["-C", worktreePath, "checkout", "--", path]);
      }
    }

    // Re-read porcelain and re-verify the tree is clean of real work after the
    // clear (fail-closed: never re-arm a worker on a tree we could not clean).
    const after = readPorcelain(worktreePath);
    if (after === null || after === undefined) {
      throw new Error(`dirty-tree: unreadable-porcelain-after-clear (${ticket})`);
    }
    const afterLines = after.split("\n").filter((l) => l.trim().length > 0);
    if (filterMachineLocalDirt(afterLines).length > 0) {
      throw new Error(`dirty-tree: real-dirt-after-clear (${ticket})`);
    }

    // Write the idempotency marker, then re-arm the worker (delete the stalled
    // signal so the scheduler's normal path re-dispatches the phase).
    writeMarker(marker);
    const ok = clearStall({ ticket, phase });
    if (ok === false) {
      log.warn({ ticket, phase }, "unstuck-act: clearStall returned false (CTL-1219)");
    }
  };
}

// ─── Phase 2: source-conflict act seam (force-push-with-lease, clean only) ────
//
// Force-pushes the feature branch ONLY when the LIVE worktree passes the full
// three-gate classifyCleanRebaseForcePush safety check at act time (clean tree,
// ours-only commits, strict descendant of origin/main). The decision is re-run
// against the LIVE tree here (not stale census evidence) — the whole point of
// --force-with-lease. THROWS on any failed gate or a non-zero push exit so the
// driver records report.failed (and never marks success / emits pushed). Reuses
// collectForcePushCandidates' probe shape so the gate stays single-sourced.
export function buildSourceConflictActSeam(deps = {}) {
  const {
    runGit = defaultRunGit,
    writeMarker = defaultWriteMarker,
    markerExists = defaultMarkerExists,
    orchDir = null,
  } = deps;

  return function sourceConflictActSeam(candidate, _decision) {
    const { ticket, phase, worktreePath } = candidate;
    if (!worktreePath) throw new Error(`source-conflict: no-worktree (${ticket})`);

    const marker = markerPath(orchDir, ticket, phase, "force-pushed");
    if (markerExists(marker)) return; // idempotent — already pushed this lifetime.

    // Re-run the three git probes against the LIVE tree (mirrors
    // collectForcePushCandidates probe shape — single-sourced gate logic).
    let porcelain = null;
    const pRes = runGit(["-C", worktreePath, "status", "--porcelain"]);
    if (!pRes?.error && (pRes?.status ?? 1) === 0) porcelain = pRes.stdout ?? "";

    let commitSubjects = [];
    const lRes = runGit([
      "-C",
      worktreePath,
      "log",
      "--no-merges",
      "--format=%s",
      "origin/main..HEAD",
    ]);
    if (!lRes?.error && (lRes?.status ?? 1) === 0) {
      commitSubjects = (lRes.stdout ?? "").split("\n").filter((s) => s.trim().length > 0);
    }

    const mRes = runGit(["-C", worktreePath, "merge-base", "--is-ancestor", "origin/main", "HEAD"]);
    const headIsDescendant = !mRes?.error && (mRes?.status ?? 1) === 0;

    const decision = classifyCleanRebaseForcePush({
      stalledReason: "source_conflict_ctl708_unavailable",
      ticket,
      porcelain,
      commitSubjects,
      headIsDescendant,
      liveSessionInWorktree: false,
      linearTerminal: candidate.evidence?.linearTerminal ?? false,
      alreadyPushed: false,
    });
    if (decision.action !== "force-push") {
      throw new Error(`source-conflict: ${decision.reason ?? "gate-failed"} (${ticket})`);
    }

    // Disable hooks for the push (mechanical action; no local hook side-effects).
    const push = runGit([
      "-C",
      worktreePath,
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--force-with-lease",
      "-u",
      "origin",
      "HEAD",
    ]);
    if (push?.error || (push?.status ?? 1) !== 0) {
      throw new Error(
        `source-conflict: push-failed (${ticket}): ${push?.stderr ?? push?.error?.message ?? "non-zero"}`
      );
    }

    writeMarker(marker);
  };
}

// ─── Phase 3: orphan-stale act seam (emit synthetic phase-complete if merged) ──
//
// Emits a synthetic phase.<phase>.complete.<ticket> event so teardown advances,
// ONLY when classifyOrphanMergedReconcile confirms the orphan-merge precondition
// against LIVE evidence (PR MERGED, bg job dead, signal stale past the cutoff, no
// terminal-done marker). THROWS on any failed gate or a failed emit so the driver
// records report.failed (and never marks success). Idempotent via the
// .unstuck-orphan-merge-<phase>.applied marker.
export function buildOrphanStaleActSeam(deps = {}) {
  const {
    resolvePrState = () => null,
    jobLifecycle = () => false,
    emitPhaseComplete = (a) => defaultEmitPhaseComplete({ ...a, orchDir }),
    markerExists = defaultMarkerExists,
    writeMarker = defaultWriteMarker,
    nowMs = () => Date.now(),
    orchDir = null,
  } = deps;

  return function orphanStaleActSeam(candidate, _decision) {
    const { ticket, phase, signal } = candidate;

    const marker = markerPath(orchDir, ticket, phase, "orphan-merge");
    if (markerExists(marker)) return; // idempotent — already emitted this lifetime.

    const terminalDoneApplied = markerExists(
      join(orchDir ?? ".", "workers", ticket, ".terminal-done.applied")
    );

    // Resolve LIVE evidence the way defaultCollectOrphanMergedCandidates does.
    let prState = null;
    try {
      const r = resolvePrState(ticket);
      prState = r && typeof r.then === "function" ? null : r;
    } catch {
      prState = null;
    }

    const bgJobId = signal?.bg_job_id ?? null;
    let bgJobAlive = false;
    try {
      bgJobAlive = bgJobId != null ? Boolean(jobLifecycle(bgJobId)) : false;
    } catch {
      bgJobAlive = false;
    }

    let signalUpdatedAt = null;
    try {
      if (signal?.updatedAt) signalUpdatedAt = new Date(signal.updatedAt).getTime();
    } catch {
      signalUpdatedAt = null;
    }

    const decision = classifyOrphanMergedReconcile({
      ticket,
      phase,
      prState,
      bgJobAlive,
      signalUpdatedAt,
      nowMs: nowMs(),
      alreadyEmitted: false, // marker already gated above
      terminalDoneApplied,
      linearTerminal: candidate.linearTerminal ?? false,
    });
    if (decision.action !== "emit-complete") {
      throw new Error(`orphan-stale: ${decision.reason ?? "gate-failed"} (${ticket})`);
    }

    const ok = emitPhaseComplete({ ticket, phase });
    if (ok === false) {
      throw new Error(`orphan-stale: emit-failed (${ticket})`);
    }

    writeMarker(marker);
  };
}

// ─── Phase 4: stale-label act seam (clear the stale attention label) ──────────
//
// Removes the stale attention label from a terminal ticket. Thin wrapper over
// clearStalledLabel (label-guard.mjs), which is best-effort + never throws — so
// the seam must inspect the OUTCOME and THROW on non-removal to satisfy the
// driver's fail-loud contract (report.failed → no cleared.stale-label event).
// Handles: the CTL-1078 back-off short-circuit (no real removal attempted), a
// removeLabel removed:false / thrown result, and a missing decision.label.
export function buildStaleLabelActSeam(deps = {}) {
  const {
    writeStatus = { removeLabel: () => ({ removed: true }) },
    orchDir = null,
    nowMs = () => Date.now(),
    // injectable for the back-off test; defaults to the real label-guard primitive.
    inRemovalBackoff: backoff = inRemovalBackoff,
    clearStalledLabel: clearLabel = clearStalledLabel,
  } = deps;

  return function staleLabelActSeam(candidate, decision) {
    const { ticket } = candidate;
    const label = decision?.label;
    if (!label) throw new Error(`stale-label: no-label (${ticket})`);

    // CTL-1078 back-off: clearStalledLabel short-circuits silently in back-off,
    // which would otherwise look like success. Detect it up front and fail loud.
    if (backoff(orchDir, ticket, label, nowMs())) {
      throw new Error(`stale-label: in-backoff (${ticket}/${label})`);
    }

    let removed = false;
    clearLabel(orchDir, ticket, label, writeStatus, {
      onRemoved: () => {
        removed = true;
      },
      now: nowMs,
    });
    // clearStalledLabel runs onRemoved synchronously only for a confirmed removal.
    if (!removed) {
      throw new Error(`stale-label: not-removed (${ticket}/${label})`);
    }
  };
}

// ─── buildUnstuckActSeams — registry factory ──────────────────────────────────
//
// Returns the frozen { category → seam fn } registry the scheduler passes to
// runUnstuckSweepPass as actByCategory. Keys are EXACTLY the four enforceable
// category strings (the escalate-only remediate-cap/unknown route to the separate
// escalate seam, NOT this registry). Every seam is pure-cored + injectable.
export function buildUnstuckActSeams(deps = {}) {
  return Object.freeze({
    "dirty-tree": buildDirtyTreeActSeam(deps),
    "source-conflict": buildSourceConflictActSeam(deps),
    "orphan-stale": buildOrphanStaleActSeam(deps),
    "stale-label": buildStaleLabelActSeam(deps),
  });
}
