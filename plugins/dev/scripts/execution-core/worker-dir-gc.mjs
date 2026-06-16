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
//   (1) terminal — has ≥1 phase signal AND !isTicketInFlight(statuses).
//   (2) idle — none of the dir's recorded bg_job_id/sessionId short-ids ∈ live short-ids.
//   (3) mtime age >= retention (default 24h ≫ any pipeline duration).
//   + batchCap bound; best-effort `workers.gc.swept` emit.
//
// DELETE PRIMITIVE: fs.rm(dir, {recursive, force}) of the WORKER DIR ALONE — never `claude rm`
// (that tears down the worktree). teardown already archived; we reclaim the state dir only.

import { readdir, stat, readFile, rm as rmAsync } from "node:fs/promises";
import { join } from "node:path";
import { log as defaultLog } from "./config.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";
import { isTicketInFlight } from "./scheduler.mjs";
import { emitReapIntent } from "./reap-intent.mjs";

const DEFAULT_RETENTION_SECONDS = 86_400; // 24h
const DEFAULT_BATCH_CAP = 100;

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
    return { statuses, shortIds };
  }
  for (const f of files) {
    const m = /^phase-(.+)\.json$/.exec(f);
    if (!m || m[1].includes("-yield-")) continue; // skip CTL-702 yield tombstones
    try {
      const sig = JSON.parse(await readFileFn(join(dir, f), "utf8"));
      statuses[m[1]] = sig?.status ?? null;
      if (sig?.bg_job_id) shortIds.add(String(sig.bg_job_id).slice(0, 8));
      if (sig?.catalystSessionId) {
        let s = null;
        try { s = shortIdFromSessionId(sig.catalystSessionId); } catch { s = null; }
        if (s) shortIds.add(s);
      }
    } catch { /* unreadable/malformed → treated as absent */ }
  }
  return { statuses, shortIds };
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
    try { s = shortIdFromSessionId(a?.sessionId); } catch { s = null; }
    if (s) liveShortIds.add(s);
  }

  let tickets;
  try {
    tickets = (await readDir(workersRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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
  let errors = 0;
  let batchCapped = false;

  for (const ticket of tickets) {
    scanned++;
    const { statuses, shortIds } = await metaReader(ticket);

    // Gate 1 — terminal: must have ≥1 signal AND not be in-flight.
    if (Object.keys(statuses).length === 0 || isTicketInFlight(statuses)) {
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

    if (reclaimed >= batchCap) {
      batchCapped = true;
      break;
    }

    // All gates passed — delete the WORKER DIR ALONE (never `claude rm`).
    try {
      await rm(dir, { recursive: true, force: true });
      reclaimed++;
    } catch {
      errors++;
    }
  }

  // Best-effort flag emit; only when we actually reclaimed something.
  if (reclaimed > 0) {
    try {
      await emit("workers.gc.swept", { reclaimed, scanned });
    } catch (err) {
      log.warn({ err: err?.message }, "worker-dir-gc: workers.gc.swept emit failed");
    }
  }

  return { reclaimed, scanned, skippedInFlight, skippedLive, skippedRecent, errors, batchCapped };
}
