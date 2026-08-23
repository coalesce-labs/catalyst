// sdk-worker-registry.mjs — CTL-1410 Phase B: the ONE authoritative in-process
// registry of live SDK phase workers. An in-process worker has bg_job_id null,
// so every bg-keyed liveness probe (isBgJobAlive, jobLifecycle, `claude agents`)
// is blind to it; this registry is the SDK-native answer that the watchdog
// (Phase C), preemption cancel (Phase D), and reclaim/boot-resume (Phases E/F)
// all consume. NEAR-LEAF MODULE: node:fs/node:path, plus ONE sibling leaf —
// sdk-child-discovery.mjs (node:child_process only, and it imports nothing from
// here, so no cycle is constructible). Importers must never be imported back
// from here, or the split-brain this consolidates returns as an import cycle.
//
// Liveness is process-local by design: the daemon's `settleDispatchSync`
// detaches the query promise onto the SAME event loop, so a Map here IS the
// ground truth for this daemon. The disk projection (<orchDir>/.sdk-workers/)
// exists only for OTHER processes (delegate-runner child, doctor) and for boot
// reconcile — pid-alive is its primary check, freshness the secondary.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// CTL-2192: the boot reap SIGNALS a pid. `kill -0` is not identity — it only
// says SOMETHING answers to that number — so the target is confirmed by the same
// structured per-pid cwd field the discovery probe uses to attribute it in the
// first place. Sibling leaf; it imports nothing from this module.
import { cwdOfPid } from "./sdk-child-discovery.mjs";

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
        // CTL-2192 (Phase 2): did we LOOK for a child? Distinguishes "no child"
        // from "never asked" — the two are byte-identical without this marker,
        // and classifySdkWorkerLiveness must answer `dead` for the first and
        // `unknown` for the second (a legacy projection, or a worker parked at
        // the semaphore before its child exists).
        childPidResolved: entry.childPidResolved === true,
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
    childPidResolved: entry.childPidResolved, // CTL-2192: did we look for a child?
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
    // CTL-2192 (Phase 2): the SDK runner now populates it too, via a per-pid
    // ppid+cwd join (sdk-child-discovery.mjs).
    childPid: null,
    // CTL-2192 (Phase 2): false until setChildPid runs, whatever it discovers.
    childPidResolved: false,
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
    // CTL-2192 (Phase 2): stamps childPidResolved: true REGARDLESS of what was
    // discovered. A null pid here means "we looked and found none" — a fact the
    // liveness oracle reads as dead; without the stamp it must read `unknown`.
    setChildPid(pid) {
      if (_live.get(ticket)?.token !== entry.token) return;
      entry.childPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      entry.childPidResolved = true;
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

// CTL-2192 (Phase 4): confirm a SIGTERM'd orphan actually died. The grace is one
// tick — deliberately short, because the point is to LEARN whether SDK children
// honour SIGTERM (the reapFailed path makes that measurable) rather than to
// guarantee a kill. Escalating to SIGKILL is a follow-up, not a guess made now.
export const REAP_CONFIRM_GRACE_MS = 2_000;

// The confirm POLLS rather than sleeping the whole grace, so a child that exits
// promptly (the overwhelmingly common case) costs one poll interval, not the
// full grace. That matters because the confirm is synchronous inside startDaemon's
// boot ordering — it runs AFTER the pid file is published, so every liveness
// consumer reads the frozen process as healthy for as long as it blocks.
export const REAP_CONFIRM_POLL_MS = 100;

// The CODEX path is a REGRESSION surface, not a new one. Before this ticket an
// orphaned codex child was SIGTERM'd and its projection removed immediately with
// no confirmation at all; adding the 2 s confirm means a codex child that
// flushes and exits at t+3 s is now recorded reapFailed, its projection kept,
// and boot-resume charges it a slot and refuses to resume it — one boot of lost
// work for a child that died normally a second later. Because the confirm POLLS,
// a longer grace costs nothing for a child that exits promptly; it is only paid
// by one that genuinely lingers, and the shared total budget still bounds it.
export const REAP_CONFIRM_GRACE_CODEX_MS = 5_000;

// …and the whole reconcile shares ONE deadline, so N surviving orphans cost
// N-independent time. Without it a host bounced with a saturated board whose
// children all survive pays N x grace with no aggregate bound at all.
export const REAP_CONFIRM_TOTAL_BUDGET_MS = 10_000;

function sleepSync(ms) {
  if (!(ms > 0)) return;
  // Synchronous by necessity: reconcileSdkRegistryOnBoot runs inside startDaemon's
  // synchronous boot ordering. Atomics.wait on a throwaway buffer is the portable
  // sync sleep; a busy-wait would burn a core for the grace (the very incident the
  // repo's background-process rule exists to prevent).
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SAB (locked-down runtime) → return immediately; a false reapFailed is the safe direction */
  }
}

function defaultConfirmReap(
  pid,
  { pidAlive = defaultPidAlive, graceMs = REAP_CONFIRM_GRACE_MS, pollMs = REAP_CONFIRM_POLL_MS, now = Date.now } = {},
) {
  // graceMs <= 0 means the shared budget is spent: probe once and answer on what
  // we can see NOW. A still-alive pid then reports reapFailed, which keeps the
  // projection and drops the ticket from candidacy — the safe direction.
  if (!pidAlive(pid)) return true;
  if (!(graceMs > 0)) return false;
  const deadline = now() + graceMs;
  const step = pollMs > 0 ? pollMs : graceMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    sleepSync(Math.min(step, remaining));
    if (!pidAlive(pid)) return true;
  }
  return !pidAlive(pid);
}

// CTL-2192: `kill -0` proves a pid ANSWERS, not that it is OURS. Before the boot
// reap signals a recorded childPid, confirm the target is the process the
// projection describes, by the same structured per-pid cwd field the discovery
// probe used to attribute it. The repo already holds this discipline for pid
// files ("matched by process identity, not just kill -0 ... a recycled pid is
// never a kill target"), and this ticket widened the exposed population from
// codex-only (~0 on a pure sdk/bg fleet) to EVERY sdk projection.
//
// THREE-VALUED, and the caller must treat the three differently:
//   "ours"          — cwd read and equal to worktreePath → signal it.
//   "foreign"       — cwd read and different → the pid was REUSED. Never signal;
//                     our child is gone, so the projection is ordinarily reapable.
//   "unverifiable"  — cwd unreadable, or no worktreePath to join on. Never signal
//                     an unidentified pid — and never delete the projection
//                     either, because something answering to that pid may still
//                     be our worker. Fail CLOSED to reapFailed.
function defaultClassifyChildIdentity(childPid, worktreePath, { cwdOf = cwdOfPid } = {}) {
  if (typeof worktreePath !== "string" || worktreePath === "") return "unverifiable";
  let cwd;
  try {
    cwd = cwdOf(childPid);
  } catch {
    return "unverifiable";
  }
  if (typeof cwd !== "string" || cwd === "") return "unverifiable";
  return cwd === worktreePath ? "ours" : "foreign";
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

export const SDK_LIVENESS = Object.freeze({ LIVE: "live", DEAD: "dead", UNKNOWN: "unknown" });

/**
 * CTL-2192: the ONE liveness question the re-dispatch paths (preemption sweep,
 * boot-resume) may ask about an SDK worker.
 *
 * Three-valued ON PURPOSE. A two-valued answer has shipped both failure modes:
 * collapsing "I could not look" into `dead` re-claims a live worker every ~2
 * minutes (AC1), and collapsing it into `live` strands a genuinely dead one
 * (AC2). Measured during planning: 6 projections carried the live daemon's pid
 * while only 3 SDK children existed — `childPid: null` on a live registration is
 * NORMAL (registerSdkWorker runs before sem.acquire()), not evidence of death.
 *
 * Deliberately NOT a re-point of isSdkWorkerLiveOnDisk: that one's ADVISORY
 * contract has existing consumers, and promoting it would change them.
 *
 * @returns {{state: "live"|"dead"|"unknown", reason: string, childPid: number|null}}
 */
export function classifySdkWorkerLiveness(orchDir, ticket, { pidAlive = defaultPidAlive, selfPid = process.pid } = {}) {
  // 1. Same-daemon authority. The query promise runs on THIS event loop, so the
  //    Map is ground truth here and beats every disk read — including a missing
  //    or corrupt projection (a worker registered with no orchDir writes none).
  if (_live.has(ticket)) return { state: SDK_LIVENESS.LIVE, reason: "in-memory", childPid: _live.get(ticket)?.childPid ?? null };

  let proj;
  try {
    proj = JSON.parse(readFileSync(projectionPath(orchDir, ticket), "utf8"));
  } catch (err) {
    // 2. Absent and corrupt are DISTINCT reasons: one says the worker was never
    //    projected, the other says we could not read what was projected. Both
    //    are `unknown` — neither is evidence of death.
    return {
      state: SDK_LIVENESS.UNKNOWN,
      reason: err?.code === "ENOENT" ? "no-projection" : "corrupt-projection",
      childPid: null,
    };
  }

  try {
    const childPidRaw = Number(proj?.childPid);
    const childPid = Number.isInteger(childPidRaw) && childPidRaw > 0 ? childPidRaw : null;

    if (pidAlive(proj?.pid)) {
      // 3/4. The projection's `pid` is the DAEMON's, never the worker's. A live
      //      daemon pid that is us means the file outlived its registration
      //      (deregistered, not yet unlinked) — do not infer death from it. A
      //      live pid that is NOT us means another daemon owns the answer.
      return {
        state: SDK_LIVENESS.UNKNOWN,
        reason: Number(proj?.pid) === Number(selfPid) ? "self-daemon-not-registered" : "foreign-daemon",
        childPid,
      };
    }

    // 5. Dead daemon + a recorded child: the child's own pid is the only durable
    //    fact, and it can outlive its daemon as a PID-1 orphan (measured: 14 min).
    if (childPid != null) {
      return pidAlive(childPid)
        ? { state: SDK_LIVENESS.LIVE, reason: "orphan-child-alive", childPid }
        : { state: SDK_LIVENESS.DEAD, reason: "orphan-child-dead", childPid };
    }

    // 6. We LOOKED for a child and there was none (Phase 2 stamps the marker
    //    whatever discovery returns) — with the daemon gone too, that is dead.
    if (proj?.childPidResolved === true) {
      return { state: SDK_LIVENESS.DEAD, reason: "no-child-resolved", childPid: null };
    }

    // 7. Legacy projection written before CTL-2192 Phase 2: no marker means we
    //    never asked, which is not the same as "no child". The rollout
    //    population drains as workers cycle — see the plan's Migration Notes.
    return { state: SDK_LIVENESS.UNKNOWN, reason: "legacy-projection-no-child-record", childPid: null };
  } catch {
    return { state: SDK_LIVENESS.UNKNOWN, reason: "threw", childPid: null };
  }
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
 * CTL-2192 (Phase 4): the reap arm now covers SDK projections too — an SDK child
 * can outlive its daemon as a PID-1 orphan exactly like a codex one (measured: 14
 * minutes on `mini`), and boot-resume then manufactures a fresh generation beside
 * it. The reap is also CONFIRMED: a child still alive after the grace is reported
 * as `reapFailed`, its projection is KEPT, and it is NOT harvested — deleting the
 * file would erase the only durable pointer to a live orphan and let a second
 * generation into the same worktree. Fail closed.
 * CTL-2192 (remediation): the reap now confirms the target's IDENTITY before
 * signalling (a recycled pid is never a kill target), draws every confirm from
 * ONE shared deadline so a saturated bounce cannot stall boot per-orphan, and
 * covers the stale-projection-with-a-live-child hole that used to delete the
 * only pointer to a running worker. `reapFailed` entries carry a `reason`:
 * `survived-sigterm` | `signal-failed` | `identity-unverifiable` |
 * `stale-projection-child-alive`.
 * @returns {{removed: string[], kept: string[], harvested: object[], killedChildren: object[], reapFailed: object[]}}
 */
// CTL-1422: harvested sessions older than this are orphans, not resume
// candidates — the lookback window that stops an ancient never-stopped
// projection from resurrecting forever.
export const WARM_HARVEST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function reconcileSdkRegistryOnBoot(
  orchDir,
  {
    pidAlive = defaultPidAlive,
    now = Date.now,
    killChild = defaultKillChild,
    // CTL-2192 (Phase 4): re-probe after the SIGTERM. Injectable so the tests
    // never sleep; production waits one bounded grace and re-reads the pid.
    // Set to one tick deliberately — if an SDK child routinely ignores SIGTERM
    // the reapFailed path will SHOW it, and escalating to SIGKILL is a
    // follow-up rather than a guess made now.
    confirmReap = defaultConfirmReap,
    // CTL-2192 (remediation): identity before signal. See
    // defaultClassifyChildIdentity — a recycled pid is never a kill target.
    classifyChildIdentity = defaultClassifyChildIdentity,
    // The ONE deadline every confirm in this reconcile draws from.
    confirmTotalBudgetMs = REAP_CONFIRM_TOTAL_BUDGET_MS,
    confirmGraceMs = REAP_CONFIRM_GRACE_MS,
    confirmGraceCodexMs = REAP_CONFIRM_GRACE_CODEX_MS,
  } = {},
) {
  const removed = [];
  const kept = [];
  // CTL-2192: { ticket, childPid } for each orphan that survived its SIGTERM.
  const reapFailed = [];
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
  // Shared confirm budget for the whole pass (see REAP_CONFIRM_TOTAL_BUDGET_MS).
  // Anchored on the injected clock so a test never sleeps for real.
  let confirmBudgetLeftMs = Number.isFinite(confirmTotalBudgetMs) ? confirmTotalBudgetMs : REAP_CONFIRM_TOTAL_BUDGET_MS;
  let files;
  try {
    files = readdirSync(projectionDir(orchDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { removed, kept, harvested, killedChildren, reapFailed };
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

    // CTL-1457 (N2) + CTL-2192 (Phase 4): kill a still-alive orphaned child
    // BEFORE deciding anything else about this projection. Gated on freshness +
    // pidAlive so a long-dead projection (whose childPid may have been reused) is
    // never signalled — best-effort orphan cleanup, not a guaranteed kill. The
    // gate is NOT widened beyond that: no childPid, or no freshness evidence,
    // means no signal.
    //
    // ⚠️ ORDER IS LOAD-BEARING and this block must stay ABOVE the warm-harvest
    // branch. Warm-resuming a session whose process is still running would put
    // two live generations in one worktree — the exact harm this ticket is about.
    const childPid = Number(proj?.childPid);
    let reapFailedHere = false;
    let reapFailedReason = null;
    if (Number.isInteger(childPid) && childPid > 0 && fresh && pidAlive(childPid)) {
      // ⛔ IDENTITY FIRST. `fresh` is the 48h warm-harvest window, which is a
      // weak pid-reuse guard and NOT a freshness assertion about the child; and
      // this pid is re-probed on every boot for as long as the projection lives.
      // Signalling on `kill -0` alone would SIGTERM whatever unrelated process
      // inherited the number. (Deliberately NOT narrowed to SDK_WORKER_FRESH_MS
      // instead: the plan forbids re-pointing that constant — CTL-2193 owns it —
      // and 30 minutes would also miss the real orphans of a long-down daemon,
      // which are precisely what this reap exists for.)
      const identity = classifyChildIdentity(childPid, proj?.worktreePath);
      if (identity === "ours") {
        if (killChild(childPid)) {
          // CONFIRM it. An assumed kill is not a kill: without the re-probe a
          // surviving orphan's projection is deleted and boot-resume dispatches a
          // second generation into its worktree.
          const perOrphanGrace = isCodex ? confirmGraceCodexMs : confirmGraceMs;
          const graceMs = Math.max(0, Math.min(perOrphanGrace, confirmBudgetLeftMs));
          const startedAt = now();
          const confirmed = confirmReap(childPid, { pidAlive, graceMs });
          confirmBudgetLeftMs -= Math.max(0, now() - startedAt);
          if (confirmed) {
            killedChildren.push({ ticket, childPid });
          } else {
            reapFailedHere = true;
            reapFailedReason = "survived-sigterm";
          }
        } else {
          reapFailedHere = true;
          reapFailedReason = "signal-failed";
        }
      } else if (identity === "unverifiable") {
        // We could not prove the pid is ours, so we must not signal it — and we
        // must not conclude our child is gone either. Fail CLOSED.
        reapFailedHere = true;
        reapFailedReason = "identity-unverifiable";
      }
      // identity === "foreign": the pid was reused by an unrelated process. Our
      // child is gone; leave the stranger alone and let the projection take the
      // ordinary harvest/removal path below.
    } else if (Number.isInteger(childPid) && childPid > 0 && !fresh && pidAlive(childPid)) {
      // ⚠️ The STALE-projection hole. `fresh` gates BOTH the reap and the
      // harvest, and the fall-through is rmSync. A projection older than
      // WARM_HARVEST_MAX_AGE_MS whose child is still running was therefore
      // DELETED with no signal and no reapFailed entry — after which the oracle
      // answers no-projection/unknown and boot-resume cold-dispatches a second
      // generation into a worktree that still has a live worker.
      //
      // The projection is the only durable pointer to that worker, so keep it
      // and exclude the ticket. Deliberately NO signal: the plan's rule is "no
      // freshness evidence means no signal", and this branch self-clears — once
      // the child exits, the next boot takes the ordinary removal path.
      //
      // ONLY on a CONFIRMED identity. At >48h the pid-reuse prior dominates, so
      // an unverifiable identity here falls through to the pre-existing deletion
      // rather than stranding the ticket on a pid we cannot attribute.
      if (classifyChildIdentity(childPid, proj?.worktreePath) === "ours") {
        reapFailedHere = true;
        reapFailedReason = "stale-projection-child-alive";
      }
    }
    if (reapFailedHere) {
      // Fail CLOSED: keep the file (it is the only durable pointer to the live
      // orphan), do not harvest, do not mark removed. reconcileBootResume and
      // processApprovedResumes both drop these tickets from candidacy.
      reapFailed.push({ ticket, childPid, reason: reapFailedReason });
      continue;
    }

    // CTL-1457 (N2): a codex-exec projection is NEVER a warm-resume candidate — its
    // worker is an out-of-process `codex exec` child, not a resumable in-process SDK
    // session. It always falls through to the removal below, so the signal-based
    // boot-resume re-dispatches the phase once.
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
    try {
      rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
    removed.push(ticket);
  }
  return { removed, kept, harvested, killedChildren, reapFailed };
}

/** Test seam: clear all in-memory state (projections are per-test tmp dirs). */
export function resetSdkWorkerRegistry() {
  _live.clear();
  _byWorktree.clear();
}
