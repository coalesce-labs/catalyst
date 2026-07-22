// delegate-runner-entry.mjs — CTL-1331. The standalone, DETACHED drainer body.
//
// This is the out-of-process worker the in-daemon timer (delegate-runner.mjs)
// spawns with spawn(process.execPath, [THIS_FILE], { detached:true }).unref().
// It drains the .delegate-queue once and exits. Everything HEAVY — the
// worktree provision + spawnSync(phase-agent-dispatch) + `claude --bg` (15-min
// SIGKILL ceiling, dispatch.mjs:59) — runs inside defaultInvokeRecoveryPass HERE,
// in this disposable child, so it NEVER blocks the daemon event loop or the
// scheduler tick (design §4).
//
// PHASE A — LAND INERT: with an empty queue, drainOnce does zero work and emits
// nothing. The detached child is only ever spawned by the timer, which the
// daemon starts gated CATALYST_DELEGATE_RUNNER=off by default → nothing drains.
//
// NAMESPACE: this module emits ONLY phase.dispatch.{requested,launched,failed}
// .<TICKET> (the `dispatch` slot is an allowed namespace exception) via the
// recovery.mjs appenders. It NEVER emits phase.recovery-pass.* — the recovery
// pass completion is emitted by the launched `claude --bg` worker itself, not
// here. `target_phase: "recovery-pass"` rides in the event PAYLOAD, not the slot.
//
// PURE/INJECTABLE: drainOnce(deps) takes every side-effecting seam as an
// injected dep (claimFn / invokeFn / countBackgroundAgents / isBgJobAlive /
// emit* / clock / fs) so tests drive it with NO real claude/git/worktree
// (mirrors worktree-refresh-timer.mjs + delegate-queue.test.mjs).

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { log, getExecutor } from "./config.mjs";
// CTL-1157 F3: route the detached delegate's dispatch through the node's executor
// (sdk vs bg) instead of the hardcoded bg path baked into defaultInvokeRecoveryPass.
import { dispatchForExecutor, dispatchTicket as dispatchTicketSeam } from "./dispatch.mjs";
import { resolveSdkBootExecutor } from "./sdk-run-phase-agent.mjs"; // auth-aware sdk→bg degrade (this detached child does NOT run the daemon-boot gate)
import { resolveCodexBootEligibility } from "./codex-run-phase-agent.mjs"; // CTL-1457 (N4): codex→bg degrade in the detached child (mirror of the sdk degrade)
import {
  delegateQueueDir,
  claimIntent as defaultClaimIntent,
  transitionIntent as defaultTransitionIntent,
  reclaimStaleClaims as defaultReclaimStaleClaims,
  DEFAULT_CLAIM_CEILING_MS,
} from "./delegate-queue.mjs";
import {
  defaultAppendDispatchRequestedEvent,
  defaultAppendDispatchLaunchedEvent,
  defaultAppendDispatchFailedEvent,
} from "./recovery.mjs";
import { defaultInvokeRecoveryPass } from "./recovery-reasoning.mjs";
import { countBackgroundAgents as defaultCountBackgroundAgents } from "./claude-agents.mjs";
import { isBgJobAlive as defaultIsBgJobAlive } from "./claude-agents.mjs";
import { countSdkInflight as defaultCountSdkInflight } from "./signal-reader.mjs"; // CTL-1157 Codex round-6: existing dispatched/running sdk workers occupancy (no bg job → countBg misses them)
import { computeFreeSlots, readMaxParallel } from "./scheduler.mjs";

const RECOVERY_PASS_PHASE = "recovery-pass";

// resolveMaxParallel — maxParallel may be a number or a () => number source.
function resolveMaxParallel(src) {
  const v = typeof src === "function" ? src() : src;
  return Number.isFinite(v) ? v : Infinity;
}

// intentPath — the canonical <orchDir>/.delegate-queue/<TICKET>.json path.
function intentPath(orchDir, ticket) {
  return join(delegateQueueDir(orchDir), `${ticket}.json`);
}

// readJsonFile — parse one file; null on absent/malformed (never throws).
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// recoveryPassWorkerLive — the supersede idempotency probe (design §4b-step2).
// A live recovery-pass worker for the anchor already exists when
// workers/<TICKET>/phase-recovery-pass.json is dispatched|running AND its
// bg_job_id is alive. Mirrors delegate-queue's enqueue-time live-worker check so
// the runner re-checks the same condition at DRAIN time (the worker may have
// launched between enqueue and drain).
//
// CTL-1157 (GROUP-3 #2): sdk-aware. Under executor=sdk the recovery-pass worker
// runs IN-PROCESS with no bg_job_id (dispatch.mjs E3); a dispatched|running sdk
// signal with no bg_job_id is LIVE, so a second drain scan dedups it instead of
// re-launching the same ticket. Under bg the discriminator is absent → byte-identical.
function recoveryPassWorkerLive(orchDir, ticket, isBgJobAlive, executor) {
  const sig = readJsonFile(
    join(orchDir, "workers", ticket, "phase-recovery-pass.json")
  );
  if (!sig) return false;
  if (sig.status !== "dispatched" && sig.status !== "running") return false;
  const bgJobId = sig.bg_job_id ?? null;
  if (!bgJobId) return executor === "sdk"; // sdk in-process worker: live with no bg id
  try {
    return isBgJobAlive(bgJobId) === true;
  } catch {
    return false;
  }
}

// listQueuedTickets — the <TICKET>.json canonical intent files whose status is
// "queued" (the only drainable status; claimed/launched/terminal are skipped).
// Skips claim sidecars (<TICKET>.json.claimed-…) and tmp artifacts. Never throws.
function listQueuedTickets(orchDir) {
  const dir = delegateQueueDir(orchDir);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.includes(".json.")) continue;
    const intent = readJsonFile(join(dir, name));
    if (intent && intent.status === "queued" && intent.ticket) {
      out.push(intent.ticket);
    }
  }
  return out;
}

/**
 * drainOnce — drain every currently-queued delegate intent once.
 *
 * For each queued <TICKET>.json:
 *   1. CLAIM (O_EXCL/rename single-flight). Lost → skip.
 *   2. RE-CHECK SUPERSEDE: a live recovery-pass worker now exists → mark the
 *      intent superseded, GC it, skip (no dispatch).
 *   3. RE-CHECK FREE SLOTS: computeFreeSlots(maxParallel, live) <= 0 → un-claim
 *      back to queued (leave for next cycle), skip (no dispatch).
 *   4. INVOKE the heavy path defaultInvokeRecoveryPass(ticket, {boardContext,
 *      reason}, {orchDir}) — emits phase.dispatch.requested FIRST.
 *   5. On {dispatched:true}: flip → launched + bg_job_id + worktreePath +
 *      launchedAt, emit phase.dispatch.launched. Else: flip → failed + reason,
 *      emit phase.dispatch.failed.
 *
 * Before the loop it reclaims stale claims (crash safety) so a runner that died
 * mid-flight doesn't permanently strand an intent.
 *
 * @param {object} deps  every seam injectable for deterministic tests.
 * @returns {{drained:number, superseded:number, failed:number, reclaimed:number}}
 */
export function drainOnce(deps = {}) {
  const orchDir = deps.orchDir;
  const result = { drained: 0, superseded: 0, failed: 0, reclaimed: 0 };
  if (!orchDir) return result;

  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const pid = deps.pid ?? process.pid;
  const claimFn = deps.claimFn ?? defaultClaimIntent;
  const transitionFn = deps.transitionFn ?? defaultTransitionIntent;
  const reclaimFn = deps.reclaimFn ?? defaultReclaimStaleClaims;
  const invokeFn = deps.invokeFn ?? defaultInvokeRecoveryPass;
  const countBg = deps.countBackgroundAgents ?? defaultCountBackgroundAgents;
  const countSdkInflight = deps.countSdkInflight ?? defaultCountSdkInflight;
  const isBgJobAlive = deps.isBgJobAlive ?? defaultIsBgJobAlive;
  const appendRequested =
    deps.appendRequested ?? defaultAppendDispatchRequestedEvent;
  const appendLaunched =
    deps.appendLaunched ?? defaultAppendDispatchLaunchedEvent;
  const appendFailed = deps.appendFailed ?? defaultAppendDispatchFailedEvent;
  const orchId = deps.orchId ?? null;
  const ceilingMs = Number.isFinite(deps.claimCeilingMs)
    ? deps.claimCeilingMs
    : DEFAULT_CLAIM_CEILING_MS;
  const max = resolveMaxParallel(deps.maxParallel);
  // CTL-1157 GROUP C: the executor this drain dispatches through. An sdk dispatch
  // settles SYNCHRONOUSLY with no bg job, so countBg cannot see it on the next
  // loop iteration — without a local counter, multiple queued intents would each
  // pass the free-slot check and overrun the scheduler's slot limit at
  // maxParallel=1. Track the synchronous launches already performed in THIS pass
  // and count them toward the capacity check when executor==="sdk". bg launches
  // DO surface in countBg, so for bg this counter is unused and behavior is
  // byte-identical.
  const executor = deps.executor ?? null;
  let localLaunched = 0;
  // CTL-1157 (Codex round-6, corrected): the sdk slot budget is the SUM of three
  // DISJOINT terms — countBg (bg workers, re-read per iteration) + the PRE-EXISTING
  // sdk in-flight workers sampled ONCE below + localLaunched (this pass's sdk launches).
  // This mirrors the scheduler's sample-once occupiedCount + per-launch increment
  // (scheduler.mjs). The tempting one-liner "re-read countSdkInflight each iteration AND
  // add localLaunched" DOUBLE-COUNTS every launch: an sdk dispatch's synchronous
  // prelaunch writes workers/<ticket>/phase-<phase>.json (dispatched, no bg_job_id)
  // BEFORE invokeFn returns, so a per-iteration countSdkInflight already sees this pass's
  // launches — adding localLaunched on top halves effective parallelism at maxParallel≥2.
  // Sampling ONCE here (no this-pass launch has happened yet) keeps the two terms disjoint.
  let sdkInflightBaseline = 0;
  let sdkBaselineOk = true;
  // CTL-1157 F P1: under executor=sdk each dispatch launches an IN-PROCESS query()
  // that settles asynchronously (invokeFn returns the settled chain in
  // details.pendingSdk). This disposable child must await those before exiting or
  // process.exit kills the just-launched workers. Collect them here; the entrypoint
  // awaits result.pending before process.exit(0). bg dispatch is synchronous, so
  // pendingSdk is null and this array stays empty (byte-identical to before).
  const pending = [];

  // (0) Crash safety: reclaim claimed-* sidecars older than one ceiling window
  //     back to queued so a dead runner doesn't strand an intent forever.
  try {
    result.reclaimed = reclaimFn(orchDir, now(), ceilingMs);
  } catch (err) {
    log.warn({ err: err?.message }, "delegate-runner: reclaim failed");
  }

  // (0b) Sample the PRE-EXISTING sdk in-flight occupancy ONCE (dispatched/running sdk
  // phase workers, no bg job → invisible to countBg). Disjoint from localLaunched below.
  // A count failure fails CLOSED (the drain holds every intent), matching the per-item
  // countBg posture (CTL-731: never over-spawn on an untrustworthy live count). bg stays
  // 0 (bg workers surface in countBg) → byte-identical to before.
  if (executor === "sdk") {
    try {
      sdkInflightBaseline = countSdkInflight(orchDir) ?? 0;
    } catch (err) {
      sdkBaselineOk = false;
      log.warn(
        { err: err?.message },
        "delegate-runner: sdk in-flight baseline count failed — fail-closed (holding all intents this pass)"
      );
    }
  }

  for (const ticket of listQueuedTickets(orchDir)) {
    // (1) CLAIM — O_EXCL/rename single-flight. The loser's source is already
    //     gone (a racer renamed it away) → claimed:false → skip.
    let claim;
    try {
      claim = claimFn(orchDir, ticket, pid, now());
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "delegate-runner: claim threw");
      continue;
    }
    if (!claim?.claimed) continue; // lost the race
    const claimPath = claim.claimPath;

    // (2) RE-CHECK SUPERSEDE — a live recovery-pass worker launched between
    //     enqueue and now → don't double-launch. The intent has done its job
    //     (the work it would have started already exists), so it is removed:
    //     it must NOT keep reserving a slot, and there is nothing to re-drain.
    //     We unlink the consumed claim sidecar and the canonical intent file.
    if (recoveryPassWorkerLive(orchDir, ticket, isBgJobAlive, executor)) {
      for (const p of [claimPath, intentPath(orchDir, ticket)]) {
        try {
          unlinkSync(p);
        } catch {
          /* already gone — best effort */
        }
      }
      result.superseded++;
      continue;
    }

    // (3) RE-CHECK FREE SLOTS — compete fairly for the same slots as real work
    //     at DRAIN time. No headroom → un-claim back to queued (next cycle).
    //     The live count is read here; if it CANNOT be read (countBg threw) we
    //     fail CLOSED — treat it as no headroom and un-claim — rather than
    //     launching on an unknown live count. This matches the scheduler tick's
    //     own fail-safe posture (CTL-731: a stale/untrustworthy live count holds
    //     new-work admission, never over-spawns) and preserves the §3b
    //     conservative-only invariant: a delegate launches ONLY when there is
    //     provably free headroom.
    let live;
    let countOk = true;
    try {
      live = countBg({});
    } catch (err) {
      countOk = false;
      log.warn(
        { ticket, err: err?.message },
        "delegate-runner: bg count failed — un-claiming (fail-closed, no launch on unknown count)"
      );
    }
    // effectiveLive = live bg workers (re-read each iteration) + PRE-EXISTING sdk
    // workers (sampled once in step 0b) + THIS pass's sdk launches (localLaunched). All
    // three are disjoint, so the slot limit is honored across queued intents AND
    // concurrent sdk phase workers with no double-count. bg path is byte-identical
    // (sdkInflightBaseline and localLaunched both stay 0). A failed sdk baseline sample
    // (sdkBaselineOk=false) holds every intent this pass (fail-closed).
    const effectiveLive =
      executor === "sdk" ? (live ?? 0) + sdkInflightBaseline + localLaunched : live;
    if (!countOk || !sdkBaselineOk || computeFreeSlots(max, effectiveLive) <= 0) {
      try {
        transitionFn(orchDir, ticket, { from: claimPath, status: "queued" });
      } catch (err) {
        log.warn(
          { ticket, err: err?.message },
          "delegate-runner: un-claim failed"
        );
      }
      continue;
    }

    // (4) INVOKE the heavy path. requested FIRST (it's a dispatch DECISION
    //     marker, emitted before the spawn — matching dispatch.requested
    //     semantics), then the worktree provision + claude --bg happens INSIDE
    //     defaultInvokeRecoveryPass, here in the disposable child.
    const claimed = readJsonFile(claimPath) ?? {};
    const kind = claimed.kind ?? "board-health";

    // CTL-1331 FU-1: build the invoke args by intent kind. A board-health delegate
    // carries {boardContext, reason}; a per-item "recovery-item" carries the full
    // briefObj (diagnostician evidence + failure reason + brief) that
    // reasoningRecoveryPass assembled on the tick. Either way the dispatched phase
    // is RECOVERY_PASS_PHASE (defaultInvokeRecoveryPass always dispatches that).
    const invokeArgs =
      kind === "recovery-item"
        ? { ...(claimed.briefObj ?? {}) }
        : {
            boardContext: claimed.boardContext ?? null,
            reason: claimed.reason ?? null,
            phase: RECOVERY_PASS_PHASE,
          };

    try {
      appendRequested({
        orchId,
        orchDir,
        ticket,
        target_phase: RECOVERY_PASS_PHASE,
        reason: kind,
      });
    } catch {
      /* best-effort telemetry — never block the drain */
    }

    let r;
    try {
      r = invokeFn(ticket, invokeArgs, { orchDir });
    } catch (err) {
      r = { dispatched: false, reason: `invoke threw: ${err?.message}` };
    }

    // (5) Apply the result.
    if (r && r.dispatched) {
      const bgJobId = r.details?.bg_job_id ?? null;
      const worktreePath = r.details?.worktreePath ?? null;
      try {
        transitionFn(orchDir, ticket, {
          from: claimPath,
          status: "launched",
          bg_job_id: bgJobId,
          worktreePath,
          launchedAt: now(),
        });
      } catch (err) {
        log.warn(
          { ticket, err: err?.message },
          "delegate-runner: launched transition failed"
        );
      }
      try {
        appendLaunched({
          orchId,
          orchDir,
          ticket,
          target_phase: RECOVERY_PASS_PHASE,
          bg_job_id: bgJobId,
          worktree_path: worktreePath,
        });
      } catch {
        /* best-effort */
      }
      // Count this dispatch toward the in-pass slot reservation. Only consulted
      // when executor==="sdk" (synchronous, invisible to countBg); for bg the
      // launched job is counted by countBg on the next iteration instead.
      localLaunched++;
      result.drained++;
      // CTL-1157 F P1: hold the in-process sdk query's settled chain so the
      // entrypoint can await it before process.exit. Null on the bg path.
      const pendingSdk = r.details?.pendingSdk;
      if (pendingSdk && typeof pendingSdk.then === "function") pending.push(pendingSdk);
    } else {
      const failReason = r?.reason ?? "dispatch-failed";
      try {
        transitionFn(orchDir, ticket, {
          from: claimPath,
          status: "failed",
          reason: failReason,
        });
      } catch (err) {
        log.warn(
          { ticket, err: err?.message },
          "delegate-runner: failed transition failed"
        );
      }
      try {
        appendFailed({
          orchId,
          ticket,
          target_phase: RECOVERY_PASS_PHASE,
          reason: failReason,
        });
      } catch {
        /* best-effort */
      }
      result.failed++;
    }
  }

  // CTL-1157 F P1: expose the in-process sdk query promises so the detached
  // entrypoint can await them before process.exit. Empty on the bg path.
  result.pending = pending;
  return result;
}

// ── single-instance top-level lock (design §4a) ──────────────────────────────
//
// A top-level O_EXCL lock at <orchDir>/.delegate-runner.lock guards against two
// detached drainers overlapping. open(O_CREAT|O_EXCL) ("wx") creates-or-fails:
// the winner writes its pid; a loser that finds the file checks whether the
// recorded pid is still alive — a STALE lock (dead pid) is reclaimed, a LIVE one
// makes the loser exit immediately. Mirrors claim.mjs's "wx" discipline.

export function runnerLockPath(orchDir) {
  return join(orchDir, ".delegate-runner.lock");
}

// pidAlive — process.kill(pid, 0) probes liveness without signalling. Injectable
// for tests via deps.pidAlive.
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = alive but not ours (treat alive).
    return e.code === "EPERM";
  }
}

/**
 * acquireRunnerLock — take the single-instance lock. Returns
 * { acquired:true, release } for the winner, { acquired:false } when a LIVE
 * runner already holds it. A stale lock (dead recorded pid) is reclaimed.
 *
 * deps: { pid, pidAlive } injectable for tests.
 */
export function acquireRunnerLock(orchDir, deps = {}) {
  const path = runnerLockPath(orchDir);
  const pid = deps.pid ?? process.pid;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;

  const tryCreate = () => {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid, acquiredAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
  };

  try {
    tryCreate();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A lock exists — is its owner alive?
    const held = readJsonFile(path);
    const heldPid = held?.pid ?? null;
    if (heldPid && pidAlive(heldPid)) {
      return { acquired: false };
    }
    // Stale lock — reclaim it (unlink + recreate). If a racer beats us to the
    // recreate we lose the EEXIST again and bail conservatively.
    try {
      unlinkSync(path);
      tryCreate();
    } catch {
      return { acquired: false };
    }
  }

  return {
    acquired: true,
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

// resolveEffectiveDelegateExecutor — CTL-1157 F3 + CTL-1457 (N4): the executor this
// DETACHED child dispatches through. It re-resolves getExecutor() (env→Layer-1→node
// default) and applies the SAME boot degrades the daemon does — because this child
// does NOT run the daemon-boot gate, so it must not trust a raw config value the
// daemon has already degraded away:
//   - resolveSdkBootExecutor degrades sdk→bg when the subscription-auth precondition
//     fails (no CLAUDE_CODE_OAUTH_TOKEN);
//   - resolveCodexBootEligibility degrades codex-exec→bg when the codex auth.json /
//     `codex --version` precondition fails. WITHOUT this the daemon degrades codex→bg
//     at boot but this inherited-env child re-resolves getExecutor()==="codex-exec"
//     and keeps launching unusable codex for every recovery-pass delegate (N4).
// On a bg/sdk fleet the codex branch is never taken → byte-identical. Pure-cored; every
// seam is injectable so the degrade is unit-testable without the entrypoint side effects.
export function resolveEffectiveDelegateExecutor({
  getExecutor: getExec = getExecutor,
  resolveSdkBoot = resolveSdkBootExecutor,
  resolveCodexBoot = resolveCodexBootEligibility,
  logger = log,
} = {}) {
  let { executor } = resolveSdkBoot(getExec(), { log: logger });
  if (executor === "codex-exec") {
    // Empty routing map + bootExecutor:"codex-exec" arms the gate for a node whose
    // DEFAULT executor is codex (every phase routes to codex). No emitEvent — the
    // daemon already emitted execution-core.executor.codex-fallback at boot; this is
    // a silent local degrade so the detached child agrees with the daemon.
    const elig = resolveCodexBoot({}, { bootExecutor: "codex-exec", log: logger });
    if (!elig.eligible) executor = "bg";
  }
  return executor;
}

// ── top-level detached-entry body ────────────────────────────────────────────
//
// When this file is run directly (the detached child the timer spawns), take the
// single-instance lock, drain once, release, exit. Guarded so importing the
// module for tests (drainOnce) does NOT run the drain.
const isEntrypoint =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const orchDir =
    process.env.CATALYST_EXECUTION_CORE_DIR ||
    process.env.CATALYST_ORCH_DIR ||
    null;
  if (!orchDir) {
    log.warn({}, "delegate-runner-entry: no orchDir resolved — nothing to drain");
    process.exit(0);
  }
  const lock = acquireRunnerLock(orchDir);
  if (!lock.acquired) {
    // Another runner is live — exit immediately (single-instance).
    process.exit(0);
  }
  try {
    // Resolve a FINITE maxParallel so the drain-time free-slot re-check (drainOnce
    // step 3) actually competes for headroom. Without it resolveMaxParallel(undefined)
    // → Infinity, which would let the runner launch a delegate past maxParallel even
    // when the board is full. readMaxParallel(orchDir, {}) reads the same state.json
    // ceiling the scheduler tick uses.
    // CTL-1157 F3 + CTL-1457 (N4): re-resolve the executor in this DETACHED child (it
    // does NOT run the daemon-boot gate), degrading sdk→bg on a failing subscription-auth
    // precondition AND codex-exec→bg on a failing codex precondition — so a detached
    // delegate never launches an executor the daemon already degraded away. On a bg fleet
    // this is a pure no-op (dispatchForExecutor("bg") === defaultDispatch), so the launched
    // delegate is byte-identical to today. The invokeFn wrapper curries the resolved
    // dispatch into defaultInvokeRecoveryPass via its deps.dispatchTicket seam.
    const executor = resolveEffectiveDelegateExecutor({ logger: log });
    const executorDispatch = dispatchForExecutor(executor);
    const invokeFn = (ticket, briefObj, invokeDeps) =>
      defaultInvokeRecoveryPass(ticket, briefObj, {
        ...invokeDeps,
        dispatchTicket: (o, t, p) => dispatchTicketSeam(o, t, p, { dispatch: executorDispatch }),
      });
    const r = drainOnce({ orchDir, maxParallel: readMaxParallel(orchDir, {}), invokeFn, executor });
    // CTL-1157 F P1: under executor=sdk each launched delegate is an IN-PROCESS
    // query() that resolves only AFTER the whole recovery-pass runs. drainOnce
    // returns those settled chains in r.pending. Await them here — otherwise the
    // process.exit(0) below kills the just-launched worker mid-run (the intent is
    // already marked "launched", so the recovery item would never actually run). The
    // chains NEVER reject (settleDispatchSync swallows), so allSettled is belt-and-
    // suspenders. On bg, r.pending is empty and this resolves immediately (the bg job
    // is a separate OS process that survives this child's exit — byte-identical).
    if (Array.isArray(r.pending) && r.pending.length > 0) {
      log.info(
        { executor, pending: r.pending.length },
        "delegate-runner-entry: awaiting in-process sdk delegate(s) before exit"
      );
      await Promise.allSettled(r.pending);
    }
    const { pending: _pending, ...summary } = r;
    log.info({ ...summary, executor }, "delegate-runner-entry: drain complete");
  } catch (err) {
    log.warn({ err: err?.message }, "delegate-runner-entry: drain threw");
  } finally {
    lock.release();
  }
  process.exit(0);
}
