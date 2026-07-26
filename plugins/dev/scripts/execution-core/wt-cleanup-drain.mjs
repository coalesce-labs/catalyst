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

// CTL-1524: this sweep runs on the 600s orphan-reaper timer in the SAME process and
// event loop as the daemon's heartbeat setInterval, and every probe it makes is
// SYNCHRONOUS. Measured on mini: event-loop delay inside a drain burst had a median
// of 77.5s (p90 88.6s, max 97.7s) against 6.1s outside one; 46 of 46 readings >60s
// fell inside a burst and ZERO outside. With HEARTBEAT_INTERVAL_MS=30000 that
// contiguous block IS the observed node.heartbeat starvation. The decisive detail:
// 692 of 692 deferred markers failed on `unknown-provenance` alone — a free
// existsSync — yet each one still paid TWO `gh` round-trips (confirmMerged) plus a
// recursive `lsof -nP +D <worktree>` (1.85s on a 104,525-file tree) and a
// `git status` before reaching a conclusion that was already available. Three fixes
// below: C1 instruments the sweep, C2 evaluates the free deterministic gate FIRST,
// C3 bounds the per-fire burst regardless of queue depth.

import { readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeTeardownWorktree, listOrchDirs, hasOrchProvenance } from "./worktree-safety.mjs";
import { getExecutionCoreDir, log as defaultLog } from "./config.mjs";
import { makePrView } from "./scan-adapters.mjs";
import { defaultResolvePrForEvent } from "./reaper.mjs";

const DEFAULT_QUEUE_DIR = join(homedir(), "catalyst", "wt-cleanup-queue");
// CTL-1524 (C3): 2, not 100. The old cap could never trip at the observed n=15, so
// the burst length was set by queue depth rather than by any bound. Each EXPENSIVE
// re-attempt costs ~2 synchronous `gh` round-trips + a recursive lsof descent
// (~1.85s measured) + a `git status`, so a cap of 2 keeps one fire to a couple of
// seconds of event-loop occupancy. Throughput is unaffected in practice: 2 expensive
// attempts x 144 fires/day = 288/day against a queue that has held ~15 markers.
// Override with CATALYST_WT_DRAIN_BATCH_CAP (existing env idiom).
const DEFAULT_BATCH_CAP = 2;

// Per-fire bound on short-circuit marker WRITES. The refresh below is idempotent,
// so steady state is zero writes; this only paces the one-time backfill when a
// large pre-existing queue is swept for the first time. Override with
// CATALYST_WT_DRAIN_SC_WRITE_CAP.
const DEFAULT_SHORT_CIRCUIT_WRITE_CAP = 100;

// DEFAULT_ATTEMPT_MEMO — in-process rotation clock, keyed by marker file path.
// stampAttempt records the attempt here REGARDLESS of whether persisting
// `lastAttemptAt` to disk succeeded. Without it, a marker the daemon cannot rewrite
// (read-only/full queue dir, bad perms) keeps the oldest sort key forever, sorts
// first on every fire, and — once batchCap such markers exist — consumes the whole
// batch budget in perpetuity so no other worktree ever gets an expensive attempt.
// The daemon is long-lived and sweeps run in-process, so this survives across fires.
// Pruned to the live marker set each sweep, so it cannot outgrow the queue.
const DEFAULT_ATTEMPT_MEMO = new Map();

// attemptOrderMs — the marker's last EXPENSIVE attempt as an epoch-ms sort key.
// Never-attempted (and unparseable) sorts to 0 ⇒ picked first. Used to rotate the
// bounded batch least-recently-attempted-first so a stable readdir order cannot
// starve a marker at the tail of the queue forever (C3). Takes the LATER of the
// on-disk stamp and the in-process memo: when the write succeeded they agree, and
// when it failed the memo is the only truthful record.
function attemptOrderMs(marker, file, memo) {
  const disk = Date.parse(marker?.lastAttemptAt ?? "");
  const diskMs = Number.isFinite(disk) ? disk : 0;
  const memoMs = Number(memo?.get(file)) || 0;
  return Math.max(diskMs, memoMs);
}

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
 *   { scanned, cleared, reattempted, removed, stillDeferred, shortCircuited,
 *     errors, batchCapped, durationMs }
 *
 * Per-marker cost ladder, cheapest first (CTL-1524 C2) — the sweep never pays a
 * rung it does not need:
 *   1. pathExists   — one stat; gone ⇒ clear the marker.
 *   2. provenance   — one existsSync per orchDir; absent ⇒ removal is IMPOSSIBLE
 *                     this sweep, so refresh the marker and stop here.
 *   3. confirmMerged (2 gh round-trips) + safeTeardown (lsof descent + git status),
 *                     bounded by batchCap.
 *
 * @returns {Promise<object>}
 */
export async function sweepWtCleanupQueue({
  queueDir = DEFAULT_QUEUE_DIR,
  orchDir = getExecutionCoreDir(),
  readDir = (p) => readdirSync(p),
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileFn = (p, s) => writeFileSync(p, s),
  pathExists = (p) => existsSync(p),
  clearMarker = (file) => rmSync(file, { force: true }),
  safeTeardown = safeTeardownWorktree,
  confirmMerged = (marker) => defaultConfirmMerged(marker),
  // CTL-1524 (C2): the SAME predicate safeTeardownWorktree resolves internally, run
  // up-front with the SAME orchDirs. Injected so the unit test can drive both sides.
  hasProvenance = hasOrchProvenance,
  batchCap = Number(process.env.CATALYST_WT_DRAIN_BATCH_CAP) || DEFAULT_BATCH_CAP,
  shortCircuitWriteCap = Number(process.env.CATALYST_WT_DRAIN_SC_WRITE_CAP) ||
    DEFAULT_SHORT_CIRCUIT_WRITE_CAP,
  attemptMemo = DEFAULT_ATTEMPT_MEMO,
  now = () => Date.now(),
  log = defaultLog,
} = {}) {
  const startedMs = now();
  const result = {
    scanned: 0,
    cleared: 0,
    reattempted: 0,
    removed: 0,
    stillDeferred: 0,
    shortCircuited: 0, // CTL-1524 (C2): resolved by the free provenance gate alone
    shortCircuitWrites: 0, // marker refreshes actually written (idempotent ⇒ ~0 at rest)
    errors: 0,
    batchCapped: false,
    shortCircuitWriteCapped: false,
    durationMs: 0,
  };

  // finish — CTL-1524 (C1). ONE structured line per fire, including a no-op sweep,
  // so `duration_ms` is the acceptance-criteria surface for the event-loop block.
  // Cheap and never-throwing: instrumentation must not be able to break the sweep.
  const finish = () => {
    result.durationMs = Math.max(0, now() - startedMs);
    try {
      log?.info?.(
        {
          duration_ms: result.durationMs,
          scanned: result.scanned,
          cleared: result.cleared,
          reattempted: result.reattempted,
          removed: result.removed,
          deferred: result.stillDeferred,
          errors: result.errors,
          batchCapped: result.batchCapped,
          shortCircuited: result.shortCircuited,
          shortCircuitWrites: result.shortCircuitWrites,
          shortCircuitWriteCapped: result.shortCircuitWriteCapped,
        },
        "wt-cleanup-drain: sweep timing"
      );
    } catch {
      /* never let instrumentation break the sweep */
    }
    return result;
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
    return finish();
  }

  const orchDirs = [orchDir, ...listOrchDirs()];

  // Parse every marker up-front (JSON.parse of a few hundred bytes each) so the
  // bounded batch below can rotate by last-attempt instead of readdir order (C3).
  const entries = [];
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
    entries.push({ file, marker, worktreePath });
  }

  // Prune the rotation memo to the live marker set, so it is bounded by queue depth
  // and cannot retain keys for markers that have been cleared.
  try {
    const live = new Set(entries.map((e) => e.file));
    for (const k of attemptMemo.keys()) if (!live.has(k)) attemptMemo.delete(k);
  } catch {
    /* memo is an optimisation only — never let it break the sweep */
  }

  // C3 — least-recently-attempted first. Array.prototype.sort is stable, so markers
  // that have never had an expensive attempt (key 0) keep their relative order.
  entries.sort(
    (a, b) =>
      attemptOrderMs(a.marker, a.file, attemptMemo) -
      attemptOrderMs(b.marker, b.file, attemptMemo)
  );

  for (const { file, marker, worktreePath } of entries) {
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

    // CTL-1524 (C2) — THE FIX. hasOrchProvenance is a pure existsSync over orchDirs
    // (worktree-safety.mjs), and isSafeToRemoveWorktree pushes "unknown-provenance"
    // unconditionally when it is false, so `safe` can NEVER be true for this marker
    // this sweep. Learn that here, for free, instead of after two gh round-trips and
    // a full-tree lsof descent. This ONLY skips work: the drain performs no removal
    // on this path, so the set of things it removes can only shrink, never grow.
    let provenance;
    try {
      provenance = hasProvenance(marker.ticket ?? null, { orchDirs }) === true;
    } catch {
      provenance = false; // fail-closed: unreadable provenance is not evidence
    }
    if (!provenance) {
      result.shortCircuited++;
      // The refresh is IDEMPOTENT. This cohort is strictly monotonic — once a
      // worker dir is GC'd at teardown, provenance can never be re-established —
      // so rewriting every retained marker on every 600s fire would make write
      // volume scale with queue depth forever, writing content that never changes
      // after the first time. Write only when the marker does not already record
      // this short-circuit; at rest this cohort therefore costs ZERO writes and
      // its per-marker work is one stat plus one existsSync. The cap paces the
      // one-time backfill when a large pre-existing queue is first swept.
      const alreadyRecorded =
        marker.shortCircuit === "unknown-provenance" && marker.reasonsPartial === true;
      if (alreadyRecorded) continue;
      if (result.shortCircuitWrites >= shortCircuitWriteCap) {
        result.shortCircuitWriteCapped = true;
        continue;
      }
      result.shortCircuitWrites++;
      try {
        writeFileFn(
          file,
          JSON.stringify({
            ...marker,
            // HONEST ABBREVIATION: unlike isSafeToRemoveWorktree — which deliberately
            // collects ALL failing gates with no short-circuit so a defer record is
            // diagnostically complete — this reason set is PARTIAL. The merge, dirty-
            // tree and liveness probes were never run, so their absence here is NOT
            // evidence that they would have passed. `shortCircuit`/`reasonsPartial`
            // exist so nobody later misreads the marker as "provenance was the only
            // failing gate".
            reasons: ["unknown-provenance"],
            shortCircuit: "unknown-provenance",
            reasonsPartial: true,
            // WRITE-ONCE, so this is when the short-circuit was FIRST recorded —
            // not the latest sweep that observed it. Named accordingly.
            shortCircuitSince: new Date(now()).toISOString(),
          })
        );
      } catch {
        /* best-effort refresh — the marker already on disk stays valid either way */
      }
      continue;
    }

    // Surviving worktree WITH provenance → the full, unchanged gated teardown.
    // The cap counts ONLY these expensive attempts, and `continue` (not `break`)
    // so the free paths above keep draining the rest of the queue this fire.
    if (result.reattempted >= batchCap) {
      result.batchCapped = true;
      continue;
    }
    result.reattempted++;
    const attemptedAt = new Date(now()).toISOString();

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
      stampAttempt({ file, marker, attemptedAt, readFileFn, writeFileFn, pathExists, attemptMemo });
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
      stampAttempt({ file, marker, attemptedAt, readFileFn, writeFileFn, pathExists, attemptMemo });
    }
  }

  return finish();
}

// stampAttempt — record the expensive attempt on the retained marker so the next
// sweep's batch rotates past it (C3). Re-reads first so it merges onto whatever
// deferWorktreeCleanup just wrote (its FULL reason set) rather than clobbering it
// with the pre-attempt copy. Best-effort and never throws: a failed stamp costs at
// most one unfair rotation, never correctness.
function stampAttempt({
  file,
  marker,
  attemptedAt,
  readFileFn,
  writeFileFn,
  pathExists,
  attemptMemo,
}) {
  // Record the attempt in-process FIRST, before any fallible IO. This is what keeps
  // rotation fair when the on-disk stamp cannot be persisted: a marker the daemon
  // cannot rewrite would otherwise keep the oldest sort key, sort first on every
  // fire, and permanently consume the batch budget (with batchCap=1, ONE unwritable
  // marker is enough to starve every other worktree forever).
  try {
    const ms = Date.parse(attemptedAt);
    if (Number.isFinite(ms)) attemptMemo?.set?.(file, ms);
  } catch {
    /* memo is an optimisation only */
  }
  try {
    if (!pathExists(file)) return; // teardown cleared it mid-flight — never resurrect
  } catch {
    /* probe failed → fall through and attempt the stamp */
  }
  let current = marker;
  try {
    current = JSON.parse(readFileFn(file));
  } catch {
    /* unreadable → stamp onto the pre-attempt copy */
  }
  try {
    writeFileFn(file, JSON.stringify({ ...current, lastAttemptAt: attemptedAt }));
  } catch {
    /* best-effort */
  }
}
