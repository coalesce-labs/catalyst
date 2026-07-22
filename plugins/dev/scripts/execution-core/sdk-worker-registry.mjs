// sdk-worker-registry.mjs — CTL-1410 Phase B: the ONE authoritative in-process
// registry of live SDK phase workers. An in-process worker has bg_job_id null,
// so every bg-keyed liveness probe (isBgJobAlive, jobLifecycle, `claude agents`)
// is blind to it; this registry is the SDK-native answer that the watchdog
// (Phase C), preemption cancel (Phase D), and reclaim/boot-resume (Phases E/F)
// all consume. LEAF MODULE: node:fs/node:path only — importers must never be
// imported back from here, or the split-brain this consolidates returns as an
// import cycle.
//
// Liveness is process-local by design: the daemon's `settleDispatchSync`
// detaches the query promise onto the SAME event loop, so a Map here IS the
// ground truth for this daemon. The disk projection (<orchDir>/.sdk-workers/)
// exists only for OTHER processes (delegate-runner child, doctor) and for boot
// reconcile — pid-alive is its primary check, freshness the secondary.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A worker whose projection hasn't been touched in this long is presumed dead
// even if a same-numbered pid exists (pid reuse). In-memory entries never
// expire — the daemon owns them for exactly as long as the query runs.
export const SDK_WORKER_FRESH_MS = 30 * 60 * 1000;

// Sentinel abort reason for CTL-705 preemption: the runner must resolve a
// preempted query cleanly (no phase.*.failed, no signal clobber), so it needs
// to distinguish "the scheduler preempted me" from a genuine failure abort.
export const PREEMPTION_ABORT_REASON = "catalyst-sdk-preempted";

export function isPreemptionAbort(reasonOrError) {
  if (reasonOrError == null) return false;
  const msg = typeof reasonOrError === "string" ? reasonOrError : String(reasonOrError?.message ?? "");
  return msg === PREEMPTION_ABORT_REASON;
}

// Throttle for projection rewrites from touch(): streamed SDK messages can
// arrive many times a second; the projection only needs coarse freshness.
const PROJECTION_TOUCH_THROTTLE_MS = 30_000;

const PROJECTION_DIR = ".sdk-workers";

/** @type {Map<string, object>} ticket → live entry */
const _live = new Map();
/** @type {Map<string, string>} worktreePath → ticket (reverse index) */
const _byWorktree = new Map();
let _tokenSeq = 0;

function projectionDir(orchDir) {
  return join(orchDir, PROJECTION_DIR);
}

function projectionPath(orchDir, ticket) {
  return join(projectionDir(orchDir), `${ticket}.json`);
}

// Every disk effect is best-effort: an unwritable orchDir must never take down
// the dispatch path — the in-memory registry stays correct regardless.
function writeProjection(entry) {
  if (!entry.orchDir) return;
  try {
    mkdirSync(projectionDir(entry.orchDir), { recursive: true });
    const file = projectionPath(entry.orchDir, entry.ticket);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify({
        ticket: entry.ticket,
        phase: entry.phase,
        worktreePath: entry.worktreePath,
        generation: entry.generation ?? null,
        pid: entry.pid,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        sessionId: entry.sessionId ?? null,
        // CTL-1457: executor attribution (additive, opaque). null for pre-CTL-1457
        // projections / when the caller omits it; cross-process readers (doctor,
        // boot reconcile) see which launch verb owns the worker.
        executor: entry.executor ?? null,
        // CTL-1457 (N2): the REAL child subprocess pid for an OUT-of-process executor
        // (codex-exec spawns `codex exec`). The projection's `pid` is process.pid (the
        // DAEMON) for EVERY worker; a codex child is a genuine subprocess that can
        // OUTLIVE a daemon crash, so its own pid must be durable here to let boot
        // reconcile kill the orphan. null for in-process sdk/bg (never set).
        childPid: entry.childPid ?? null,
      }),
    );
    renameSync(tmp, file);
    entry.lastProjectionWriteAt = entry.updatedAt;
  } catch {
    /* best-effort */
  }
}

function removeProjection(entry) {
  if (!entry.orchDir) return;
  try {
    unlinkSync(projectionPath(entry.orchDir, entry.ticket));
  } catch {
    /* already gone / unwritable */
  }
}

function removeEntry(entry) {
  _live.delete(entry.ticket);
  if (_byWorktree.get(entry.worktreePath) === entry.ticket) _byWorktree.delete(entry.worktreePath);
  removeProjection(entry);
}

function publicView(entry) {
  return {
    ticket: entry.ticket,
    phase: entry.phase,
    worktreePath: entry.worktreePath,
    generation: entry.generation,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    pid: entry.pid,
    orchDir: entry.orchDir,
    aborted: entry.aborted,
    sessionId: entry.sessionId,
    executor: entry.executor, // CTL-1457: which launch verb owns this worker
    childPid: entry.childPid, // CTL-1457 (N2): out-of-process child pid (codex-exec) or null
  };
}

// Same fence as flipSignalDoneOnSuccess / claim.mjs isCurrentGeneration: bow
// out iff BOTH generations are plain ints AND the caller's is older. Anything
// non-numeric fails open (the cancel proceeds).
function isPlainInt(v) {
  return (typeof v === "number" || typeof v === "string") && /^[0-9]+$/.test(String(v));
}

/**
 * Register a live in-process SDK worker. Idempotent per ticket: a resume
 * re-register replaces the entry in place (new token), so the superseded
 * handle's deregister becomes a no-op (compare-and-delete).
 *
 * @param {{ticket:string, phase?:string, worktreePath?:string, generation?:number|string, orchDir?:string}} spec
 * @param {{now?: () => number}} [opts] injectable clock
 * @returns handle {setAbortController, touch, deregister, aborted}
 */
export function registerSdkWorker(
  // CTL-1422 review fix (D): a warm resume KNOWS its session UUID at register
  // time (spec.resumeSession) — seed it so a crash between register and the
  // first streamed message doesn't lose the warm chain.
  // CTL-1457: executor is an additive, opaque attribution field (the launch verb
  // that owns this worker: "bg" | "sdk" | "codex-exec"). null when omitted; every
  // liveness/abort/reconcile path stays executor-agnostic.
  { ticket, phase, worktreePath, generation, orchDir, sessionId = null, executor = null },
  { now = Date.now } = {},
) {
  if (!ticket) throw new TypeError("registerSdkWorker: ticket is required");
  const prev = _live.get(ticket);
  if (prev && _byWorktree.get(prev.worktreePath) === ticket) _byWorktree.delete(prev.worktreePath);

  const ts = now();
  const entry = {
    ticket,
    phase,
    worktreePath,
    generation,
    orchDir,
    pid: process.pid,
    startedAt: ts,
    updatedAt: ts,
    lastProjectionWriteAt: 0,
    token: ++_tokenSeq,
    abortController: null,
    abortReason: null,
    aborted: false,
    sessionId,
    executor,
    // CTL-1457 (N2): the out-of-process child pid (codex-exec). Unknown at register
    // time (the child spawns later) → null; set via setChildPid after spawn.
    childPid: null,
    now,
  };
  _live.set(ticket, entry);
  if (worktreePath) _byWorktree.set(worktreePath, ticket);
  writeProjection(entry);

  return {
    // Abort is STICKY on the registration, not on one controller: an abort can
    // land before any controller is installed, or between retry attempts while
    // the stored controller is a previous attempt's already-settled one (the
    // 429/529 backoff window). Every future controller of an aborted
    // registration is aborted on install, so a cancelled worker can never
    // resurrect on its next retry (Phase B review catch).
    setAbortController(ac) {
      entry.abortController = ac;
      if (entry.aborted && ac && !ac.signal.aborted) {
        ac.abort(entry.abortReason);
      }
    },
    touch() {
      // Same token fence as deregister: a superseded handle's touch must never
      // clobber — or, after the successor deregisters, resurrect — the shared
      // projection file (Phase B review catch).
      if (_live.get(ticket)?.token !== entry.token) return;
      entry.updatedAt = entry.now();
      if (entry.updatedAt - entry.lastProjectionWriteAt >= PROJECTION_TOUCH_THROTTLE_MS) {
        writeProjection(entry);
      }
    },
    // CTL-1422: the live SDK session UUID (from the query's init message) — the
    // warm-resume key. Written to the projection IMMEDIATELY (not touch-throttled):
    // the projection outliving a daemon crash is the entire point, so the id must
    // be durable the moment it is known. Token-fenced like touch/deregister.
    setSessionId(sessionId) {
      if (_live.get(ticket)?.token !== entry.token) return;
      entry.sessionId = sessionId;
      entry.updatedAt = entry.now();
      writeProjection(entry);
    },
    // CTL-1457 (N2): record the REAL child subprocess pid (codex-exec) so a crash of
    // THIS daemon leaves a durable pointer to any orphaned child on the projection.
    // Written immediately (durability is the point) and token-fenced like touch/
    // setSessionId. A non-integer pid clears it to null. No-op for in-process sdk/bg.
    setChildPid(pid) {
      if (_live.get(ticket)?.token !== entry.token) return;
      entry.childPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      entry.updatedAt = entry.now();
      writeProjection(entry);
    },
    deregister() {
      const current = _live.get(ticket);
      if (current?.token !== entry.token) return; // superseded by a resume re-register
      removeEntry(current);
    },
    get aborted() {
      return entry.aborted;
    },
  };
}

/** Force-remove regardless of handle token (daemon-level cleanup). */
export function deregisterSdkWorker(ticket) {
  const entry = _live.get(ticket);
  if (entry) removeEntry(entry);
}

export function isSdkWorkerLive(ticket) {
  return _live.has(ticket);
}

export function sdkWorkerForTicket(ticket) {
  const entry = _live.get(ticket);
  return entry ? publicView(entry) : null;
}

export function sdkWorkerForWorktree(worktreePath) {
  const ticket = _byWorktree.get(worktreePath);
  return ticket ? sdkWorkerForTicket(ticket) : null;
}

export function countLiveSdkWorkers() {
  return _live.size;
}

/**
 * Abort a live worker (watchdog / operator kill). Sticky: marks the whole
 * registration aborted (even with a nullish reason), aborts the current
 * controller when one is installed and un-aborted, and guarantees every
 * FUTURE controller (next retry attempt) is aborted on install — so an abort
 * landing in the overload-backoff window can never be lost.
 * `aborted` reports whether a live controller was aborted NOW (or already
 * was); a pre-controller abort returns aborted:false (queued, fires on
 * install).
 * @returns {{found: boolean, aborted: boolean}}
 */
export function abortSdkWorker(ticket, reason) {
  const entry = _live.get(ticket);
  if (!entry) return { found: false, aborted: false };
  entry.aborted = true;
  entry.abortReason = reason;
  const ac = entry.abortController;
  if (ac && !ac.signal.aborted) {
    ac.abort(reason);
    return { found: true, aborted: true };
  }
  return { found: true, aborted: ac ? ac.signal.aborted : false };
}

/**
 * Preemption cancel (CTL-705 re-point): aborts with the preemption sentinel so
 * the runner resolves cleanly instead of emitting a failed backstop. The
 * generation fence protects a NEWER dispatch from a stale scheduler decision:
 * stale iff both generations are plain ints and the caller's is older.
 * @returns {{found: boolean, stale: boolean, aborted: boolean}}
 */
export function cancelSdkRun({ ticket, generation, reason = PREEMPTION_ABORT_REASON } = {}) {
  const entry = _live.get(ticket);
  if (!entry) return { found: false, stale: false, aborted: false };
  if (isPlainInt(generation) && isPlainInt(entry.generation) && Number(generation) < Number(entry.generation)) {
    return { found: true, stale: true, aborted: false };
  }
  const res = abortSdkWorker(ticket, reason);
  return { found: true, stale: false, aborted: res.aborted };
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // alive but owned by another user
  }
}

// CTL-1457 (N2): best-effort SIGTERM to an orphaned out-of-process child (codex-exec)
// on boot reconcile. Returns true when the signal was delivered. Never throws.
function defaultKillChild(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-process liveness read from the disk projection (for the delegate-runner
 * child and other non-daemon processes). pid-alive is primary; freshness is the
 * pid-reuse guard. Missing/corrupt projection reads as not-live, never throws.
 *
 * ADVISORY, not authoritative (Phase B review, deferred): the projection is
 * touched only while the query streams, so a worker parked at the semaphore
 * longer than freshMs reads as dead here while isSdkWorkerLive (in-process) is
 * still true. Until a consumer needs stronger on-disk freshness (Phase F
 * delegate-runner re-point), treat a dead read as "probably not live", never
 * as license to clobber the worker's signal/worktree.
 */
export function isSdkWorkerLiveOnDisk(orchDir, ticket, { pidAlive = defaultPidAlive, now = Date.now, freshMs = SDK_WORKER_FRESH_MS } = {}) {
  let proj;
  try {
    proj = JSON.parse(readFileSync(projectionPath(orchDir, ticket), "utf8"));
  } catch {
    return false;
  }
  if (!pidAlive(proj?.pid)) return false;
  const updatedAt = Number(proj?.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return now() - updatedAt <= freshMs;
}

/**
 * Boot reconcile: no in-process worker survives a daemon restart, so any
 * projection whose pid is dead (or that is unreadable) is a leftover from the
 * previous daemon and is deleted. Runs before any dispatch entry point.
 * CTL-1457 (N2): an OUT-of-process codex-exec child can OUTLIVE a daemon crash;
 * such a projection is (a) never warm-resumed (its worker is a `codex exec` child,
 * not a resumable in-process SDK session) and (b) if its recorded childPid is still
 * alive, SIGTERM'd BEFORE the projection is deleted — so the signal-based boot-resume
 * cold re-dispatches the phase exactly once instead of racing a surviving orphan.
 * @returns {{removed: string[], kept: string[], harvested: object[], killedChildren: object[]}}
 */
// CTL-1422: harvested sessions older than this are orphans, not resume
// candidates — the lookback window that stops an ancient never-stopped
// projection from resurrecting forever.
export const WARM_HARVEST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function reconcileSdkRegistryOnBoot(
  orchDir,
  { pidAlive = defaultPidAlive, now = Date.now, killChild = defaultKillChild } = {},
) {
  const removed = [];
  const kept = [];
  // CTL-1457 (N2): { ticket, childPid } for each orphaned codex child SIGTERM'd here.
  // Empty on a pure sdk/bg fleet (childPid is only ever set by the codex runner).
  const killedChildren = [];
  // CTL-1422: dead-pid projections that carry a FRESH sessionId are the
  // warm-resume inventory — no in-process worker survives a daemon restart, so
  // each one is an interrupted run whose SDK session can be continued via
  // options.resume. Review fix (B): harvested projections are KEPT on disk
  // (the file is the only durable copy of the UUID; a candidate dropped by a
  // downstream selection guard must survive to the next boot). The file is
  // superseded when the resumed run re-registers, or aged out here at
  // WARM_HARVEST_MAX_AGE_MS. Only unharvestable dead projections (corrupt, no
  // session, stale) are deleted.
  const harvested = [];
  let files;
  try {
    files = readdirSync(projectionDir(orchDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { removed, kept, harvested, killedChildren };
  }
  for (const f of files) {
    const ticket = f.slice(0, -".json".length);
    const file = join(projectionDir(orchDir), f);
    let proj = null;
    try {
      proj = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* corrupt → remove below */
    }
    if (proj && pidAlive(proj.pid)) {
      kept.push(ticket);
      continue;
    }
    const updatedAt = Number(proj?.updatedAt);
    const fresh = Number.isFinite(updatedAt) && now() - updatedAt <= WARM_HARVEST_MAX_AGE_MS;
    // CTL-1457 (N2): a codex-exec projection is NEVER a warm-resume candidate — its
    // worker is an out-of-process `codex exec` child, not a resumable in-process SDK
    // session. It always falls through to the reap branch below (where a surviving
    // orphan is killed), so the signal-based boot-resume re-dispatches the phase once.
    const isCodex = proj?.executor === "codex-exec";
    if (!isCodex && proj && typeof proj.sessionId === "string" && proj.sessionId && fresh) {
      harvested.push({
        ticket,
        sessionId: proj.sessionId,
        phase: proj.phase,
        generation: proj.generation,
        worktreePath: proj.worktreePath,
      });
      continue; // keep the file — it is the durable copy of the UUID
    }
    // CTL-1457 (N2): kill a still-alive orphaned codex child BEFORE deleting its
    // projection. Gated on isCodex + freshness + pidAlive so a long-dead projection
    // (whose childPid may have been reused) is never signalled — best-effort orphan
    // cleanup, not a guaranteed kill. bg/sdk projections carry no childPid → no-op.
    const childPid = Number(proj?.childPid);
    if (isCodex && Number.isInteger(childPid) && childPid > 0 && fresh && pidAlive(childPid)) {
      if (killChild(childPid)) killedChildren.push({ ticket, childPid });
    }
    try {
      rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
    removed.push(ticket);
  }
  return { removed, kept, harvested, killedChildren };
}

/** Test seam: clear all in-memory state (projections are per-test tmp dirs). */
export function resetSdkWorkerRegistry() {
  _live.clear();
  _byWorktree.clear();
}
