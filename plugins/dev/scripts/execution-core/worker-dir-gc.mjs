// worker-dir-gc.mjs — CTL-1205. GC stale execution-core/workers/<TICKET>/ dirs.
//
// THE LEAK: phase-teardown archives workers/<T>/ to ~/catalyst/archives/<T>/ (cp -R)
// but never deletes the original; reaper/stall-janitor only remove worktrees and
// ghost sessions. Dirs accumulate (137 at the 2026-06-16 incident), taxing every
// scheduler tick with N readdirSync/readFileSync and aging the liveness snapshot
// past the CTL-731 30s hold threshold.
//
// THE FIX: a fail-CLOSED, bounded sweep that deletes a worker dir ONLY when ALL gates pass:
//   (0) fail-closed liveness — `claude agents` unreadable ({ok:false}) → ABORT, delete nothing.
//   (1) terminal — !isTicketInFlight(statuses); zero-signal residue is terminal (CAT-24).
//   (2) idle — none of the dir's recorded bg_job_id/sessionId short-ids ∈ live short-ids.
//   (3) mtime age >= retention (default 24h ≫ any pipeline duration).
//   (4) no PENDING operator inbox — a zero-signal dir whose inbox.jsonl is non-empty and
//       younger than retention holds unconsumed human input (CAT-24).
//   + batchCap bound; best-effort `workers.gc.swept` emit.
//
// DETACH BEFORE DELETE (CAT-24): the gates read an async snapshot, so a concurrent
// redispatch could write a fresh signal into the dir mid-`rm`. The dir is renamed to a
// GC-owned `.gc-<ticket>-<ts>` sibling FIRST (atomic), and only that inode is deleted.
//
// DELETE PRIMITIVE: fs.rm(dir, {recursive, force}) of the WORKER DIR ALONE — never `claude rm`
// (that tears down the worktree). teardown already archived; we reclaim the state dir only.

import { readdir, stat, readFile, rm as rmAsync, rename as renameAsync } from "node:fs/promises";
import { join } from "node:path";
import { log as defaultLog } from "./config.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";
import { isTicketInFlight } from "./scheduler.mjs";
import { emitReapIntent } from "./reap-intent.mjs";

const DEFAULT_RETENTION_SECONDS = 86_400; // 24h
const DEFAULT_BATCH_CAP = 100;
// CAT-24: prefix for the detach-before-delete quarantine path. A ticket id can
// never start with a dot, so a `.gc-` sibling is unambiguously GC-owned.
const QUARANTINE_PREFIX = ".gc-";

// defaultReadWorkerMeta — read one ticket's phase-*.json: {statuses, shortIds}.
// statuses feeds the terminal gate; shortIds (bg_job_id + sessionId short forms)
// feed the idle/liveness gate.
async function defaultReadWorkerMeta(workersRoot, ticket, { readDir, readFileFn } = {}) {
  const dir = join(workersRoot, ticket);
  const statuses = {};
  const shortIds = new Set();
  let files;
  try {
    files = await readDir(dir);
  } catch {
    return { statuses, shortIds, unreadable: true };
  }
  let unreadable = false;
  for (const f of files) {
    const m = /^phase-(.+)\.json$/.exec(f);
    if (!m || m[1].includes("-yield-")) continue; // skip CTL-702 yield tombstones
    try {
      const sig = JSON.parse(await readFileFn(join(dir, f), "utf8"));
      statuses[m[1]] = sig?.status ?? null;
      if (sig?.bg_job_id) shortIds.add(String(sig.bg_job_id).slice(0, 8));
      if (sig?.catalystSessionId) {
        let s = null;
        try {
          s = shortIdFromSessionId(sig.catalystSessionId);
        } catch {
          s = null;
        }
        if (s) shortIds.add(s);
      }
    } catch {
      // CAT-24 (Codex P1): a malformed/unreadable phase signal is NOT an absent
      // one. Swallowing it discards the bg_job_id / catalystSessionId the Gate-2
      // liveness correlation needs, so a dir belonging to a LIVE worker could
      // read as signal-less and be reclaimed. Fail closed — mark the whole dir
      // unreadable so the sweep skips it entirely.
      unreadable = true;
    }
  }
  return { statuses, shortIds, unreadable };
}

/**
 * sweepWorkerDirs — GC stale execution-core/workers/<TICKET>/ dirs. Fail-closed,
 * fail-safe, bounded. Every IO/clock/emit primitive is an injected, defaulted seam
 * so the unit test never reads real disk or spawns `claude`.
 *
 * @returns {Promise<{reclaimed, scanned, skippedInFlight, skippedLive, skippedRecent, errors, batchCapped, skipped?}>}
 */
export async function sweepWorkerDirs({
  orchDir,
  readDir = (p, opts) => readdir(p, opts),
  statDir = (p) => stat(p),
  readFileFn = (p, enc) => readFile(p, enc),
  rm = (p, opts) => rmAsync(p, opts),
  renameDir = (from, to) => renameAsync(from, to),
  readAgents = listClaudeAgentsResult,
  readWorkerMeta,
  now = () => Date.now(),
  retentionMs = (Number(process.env.CATALYST_WORKER_GC_RETENTION_SECONDS) ||
    DEFAULT_RETENTION_SECONDS) * 1000,
  batchCap = Number(process.env.CATALYST_WORKER_GC_BATCH_CAP) || DEFAULT_BATCH_CAP,
  emit = emitReapIntent,
  env = process.env,
  log = defaultLog,
} = {}) {
  const workersRoot = join(orchDir, "workers");
  const metaReader = readWorkerMeta
    ? readWorkerMeta
    : (ticket) => defaultReadWorkerMeta(workersRoot, ticket, { readDir, readFileFn });

  // Gate 0 — fail-closed liveness FIRST. A failed `claude agents` read ({ok:false})
  // is NOT a genuinely-empty fleet: deleting on a read failure would authorize
  // evicting a live worker's dir. Abort, delete nothing.
  let agentsResult;
  try {
    agentsResult = readAgents();
  } catch {
    agentsResult = { ok: false, agents: [] };
  }
  if (!agentsResult || agentsResult.ok !== true) {
    log.warn(
      { orchDir },
      "worker-dir-gc: `claude agents` unreadable — aborting sweep (fail-closed)"
    );
    return {
      reclaimed: 0,
      scanned: 0,
      skippedInFlight: 0,
      skippedLive: 0,
      skippedRecent: 0,
      errors: 0,
      batchCapped: false,
      skipped: "agents-unreadable",
    };
  }

  const liveShortIds = new Set();
  for (const a of agentsResult.agents ?? []) {
    let s = null;
    try {
      s = shortIdFromSessionId(a?.sessionId);
    } catch {
      s = null;
    }
    if (s) liveShortIds.add(s);
  }

  let tickets;
  let quarantined = [];
  try {
    const entries = (await readDir(workersRoot, { withFileTypes: true })).filter((d) =>
      d.isDirectory()
    );
    // CAT-24 (Codex P1): `.gc-*` are already-detached dirs from a previous sweep
    // (see the quarantine rename below) — never ticket state. A crash between the
    // rename and the rm leaves one behind, so purge them here rather than letting
    // the ticket loop treat `.gc-CAT-1-…` as a ticket id.
    tickets = entries.map((d) => d.name).filter((n) => !n.startsWith(QUARANTINE_PREFIX));
    quarantined = entries.map((d) => d.name).filter((n) => n.startsWith(QUARANTINE_PREFIX));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { workersRoot, err: err?.message },
        "worker-dir-gc: workers root unreadable; skipping sweep"
      );
    }
    return {
      reclaimed: 0,
      scanned: 0,
      skippedInFlight: 0,
      skippedLive: 0,
      skippedRecent: 0,
      errors: 0,
      batchCapped: false,
    };
  }

  const nowMs = now();
  let reclaimed = 0;
  let scanned = 0;
  let skippedInFlight = 0;
  let skippedLive = 0;
  let skippedRecent = 0;
  let skippedUnreadable = 0;
  let skippedPendingInbox = 0;
  let reclaimedZeroSignal = 0;
  const reclaimedTickets = [];
  let errors = 0;
  let batchCapped = false;

  for (const ticket of tickets) {
    scanned++;
    const { statuses, shortIds, unreadable = false } = await metaReader(ticket);

    if (unreadable) {
      skippedUnreadable++;
      continue;
    }

    // Gate 1 — terminal: not in-flight. A zero-signal residue is terminal by
    // definition and continues through the same liveness + retention gates (CAT-24).
    if (isTicketInFlight(statuses)) {
      skippedInFlight++;
      continue;
    }

    // Gate 2 — idle: no recorded id of this dir is a live session; never self.
    let live = false;
    for (const id of shortIds) {
      if (liveShortIds.has(id) || isSelfSession(id, env)) {
        live = true;
        break;
      }
    }
    if (live) {
      skippedLive++;
      continue;
    }

    // Gate 3 — mtime age >= retention. Per-dir stat failure (e.g. ENOENT because
    // the dir vanished between readdir and stat) → errors++, continue; never throw.
    const dir = join(workersRoot, ticket);
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

    // Gate 4 — CAT-24 (Codex P1): never reclaim UNCONSUMED operator input. The
    // clear-stall path deliberately preserves a non-empty inbox.jsonl for the next
    // worker, and appending a reply bumps the FILE's mtime, not the DIRECTORY's —
    // so a zero-signal dir can pass the retention gate above the instant a human
    // answers. Age the inbox on its own mtime and fail closed on a stat error.
    if (Object.keys(statuses).length === 0) {
      let pendingInbox = false;
      try {
        const ist = await statDir(join(dir, "inbox.jsonl"));
        const inboxMtimeMs = ist?.mtimeMs ?? nowMs;
        pendingInbox = (ist?.size ?? 0) > 0 && nowMs - inboxMtimeMs < retentionMs;
      } catch (err) {
        // ENOENT is the common, honest "no inbox" answer. Anything else is an
        // unknown — treat it as pending rather than delete what we cannot read.
        pendingInbox = err?.code !== "ENOENT";
      }
      if (pendingInbox) {
        skippedPendingInbox++;
        continue;
      }
    }

    if (reclaimed >= batchCap) {
      batchCapped = true;
      break;
    }

    // All gates passed — delete the WORKER DIR ALONE (never `claude rm`).
    //
    // CAT-24 (Codex P1): DETACH FIRST. Every gate above read an async snapshot;
    // dispatch can re-pull this ticket and write a fresh phase signal into the
    // same path while the recursive rm is still walking it. Rename the dir to a
    // GC-owned sibling inode first — that is atomic, so either we claimed the
    // stale dir (and a concurrent redispatch mkdirs a brand-new one that we can
    // no longer touch) or the rename fails and we delete nothing.
    const quarantine = join(workersRoot, `${QUARANTINE_PREFIX}${ticket}-${nowMs}`);
    let detached = false;
    try {
      await renameDir(dir, quarantine);
      detached = true;
    } catch (err) {
      // ENOENT — the dir vanished under us (already reclaimed elsewhere): benign.
      if (err?.code !== "ENOENT") {
        errors++;
        log.warn({ ticket, err: err?.message }, "worker-dir-gc: worker-dir detach failed");
      }
    }
    if (!detached) continue;
    try {
      await rm(quarantine, { recursive: true, force: true });
      reclaimed++;
      if (Object.keys(statuses).length === 0) reclaimedZeroSignal++;
      reclaimedTickets.push(ticket);
    } catch (err) {
      // The dir is already detached, so the ticket IS reclaimed as far as the
      // scheduler is concerned; only the byte removal failed. The next sweep's
      // quarantine purge retries it.
      errors++;
      log.warn({ ticket, err: err?.message }, "worker-dir-gc: worker-dir removal failed");
    }
  }

  // Purge leftovers from a previous sweep that crashed between detach and rm.
  // Already-detached and invisible to the scheduler — best-effort, never fatal.
  for (const name of quarantined) {
    try {
      await rm(join(workersRoot, name), { recursive: true, force: true });
    } catch (err) {
      log.warn({ name, err: err?.message }, "worker-dir-gc: quarantine purge failed");
    }
  }

  // Best-effort flag emit; only when we actually reclaimed something.
  if (reclaimed > 0) {
    try {
      await emit("workers.gc.swept", {
        reclaimed,
        reclaimedZeroSignal,
        skippedUnreadable,
        scanned,
        tickets: reclaimedTickets,
      });
    } catch (err) {
      log.warn({ err: err?.message }, "worker-dir-gc: workers.gc.swept emit failed");
    }
  }

  return {
    reclaimed,
    reclaimedZeroSignal,
    reclaimedTickets,
    scanned,
    skippedInFlight,
    skippedLive,
    skippedRecent,
    skippedUnreadable,
    skippedPendingInbox,
    errors,
    batchCapped,
  };
}
