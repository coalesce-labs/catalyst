// dispatch.mjs — execution-core worker-dispatch adapter (CTL-565, CTL-582).
//
// The single executor seam (D9): the trigger/state layer emits a phase-owed
// intent { orchDir, ticket, phase }; the executor is pluggable. A cloud fork
// swaps the injected dispatch function at one call site.
//
// CTL-582 made defaultDispatch self-contained: resolve the ticket's project
// from the central registry, create (or reuse) its git worktree, then run
// phase-agent-dispatch IN that worktree. It no longer shells out to
// orchestrate-dispatch-next — the daemon has no orchestrator/worktreeBase to
// satisfy that script's wave-dispatch contract.
//
// Extracted from scheduler.mjs so both the scheduler's pull loop AND the
// monitor's →Triage one-shot dispatch share one adapter.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectConfig } from "./registry.mjs";
import { createWorktree as defaultCreateWorktree } from "./worktree.mjs";
import { sdkRunPhaseAgent } from "./sdk-run-phase-agent.mjs"; // CTL-1365b: the executor=sdk launch verb (in-process Agent SDK query())

// phase-agent-dispatch sits one directory up from execution-core/.
const PHASE_AGENT_DISPATCH_BIN = fileURLToPath(new URL("../phase-agent-dispatch", import.meta.url));

// teamOf — "CTL-123" → "CTL". Null for anything not <prefix>-<n>. The team
// prefix is the registry key that resolves a ticket to its repo.
export function teamOf(ticket) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-[0-9]+$/.exec(ticket ?? "");
  return m ? m[1] : null;
}

// defaultResolveProject — registry lookup: a ticket's team → { team, repoRoot }.
// Null when the ticket is malformed or no registry entry exists for its team.
function defaultResolveProject(ticket) {
  const team = teamOf(ticket);
  if (!team) return null;
  const entry = getProjectConfig(team);
  return entry ? { team, repoRoot: entry.repoRoot } : null;
}

// defaultRunPhaseAgent — spawn phase-agent-dispatch with cwd === the worktree so
// its --config ancestor-walk and prior-artifact globs (thoughts/shared/…)
// resolve against the worker's checkout. The orchId is the ticket itself
// (execution-core has no long-lived orchestrator); CATALYST_EXECUTION_CORE
// tells phase-agent-dispatch to compose OTEL attrs for the one-worktree-per-
// ticket path. Returns { code, stdout, stderr } — never throws.
//
// CTL-658: when `resumeSession` is set (the daemon resolved a `claude --resume`-
// compatible UUID from the dead worker's bg_job_id), append `--resume-session
// <uuid>` so phase-agent-dispatch spawns `claude --bg --resume <uuid>` (continue
// the dead session) instead of a fresh phase-0 `$PROMPT` start. Omitted entirely
// when null/undefined → today's fresh-start behaviour. `spawn` is injectable so
// the unit test can assert the built arg array without a real spawn.
// CTL-990: hard ceiling on the synchronous phase-agent-dispatch spawn. A
// wedged dispatch (the recreate→rebase-refused exec recursion looped here for
// hours, invisible — no rc, no failure ladder) must surface as a failed
// dispatch, not block the daemon. Generous: worktree provisioning (bun
// install et al) can legitimately take minutes. Read lazily so tests and
// operators can override at runtime.
const getDispatchTimeoutMs = () =>
  Number(process.env.CATALYST_DISPATCH_TIMEOUT_MS) || 15 * 60 * 1000;

export function defaultRunPhaseAgent(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  { spawn = spawnSync } = {}
) {
  const args = ["--phase", phase, "--ticket", ticket, "--orch-dir", orchDir, "--orch-id", ticket];
  if (resumeSession) args.push("--resume-session", resumeSession);
  if (attempt != null) args.push("--attempt", String(attempt)); // CTL-761
  const extraEnv = {};
  if (handoffPath) extraEnv.CATALYST_HANDOFF_PATH = handoffPath;
  // CTL-864: cross-host fencing token. Present only on multi-host dispatch;
  // absent → worker performs no fence check (single-host no-op).
  if (clusterGeneration != null) extraEnv.CATALYST_CLUSTER_GENERATION = String(clusterGeneration);
  const env = {
    ...process.env,
    CATALYST_ORCHESTRATOR_DIR: orchDir,
    CATALYST_ORCHESTRATOR_ID: ticket,
    CATALYST_PHASE: phase,
    CATALYST_TICKET: ticket,
    CATALYST_EXECUTION_CORE: "1",
    ...extraEnv,
  };
  // CTL-990: the recreate-once marker is PER DISPATCH CHAIN — only the chain's
  // own exec may set it. An ambient daemon-env value would pre-spend every
  // fresh dispatch's single recreate attempt.
  delete env.CATALYST_RECREATE_ATTEMPTED;
  const res = spawn(PHASE_AGENT_DISPATCH_BIN, args, {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: getDispatchTimeoutMs(), // CTL-990
    killSignal: "SIGKILL", // CTL-990: a wedged dispatch may ignore SIGTERM mid-exec-loop
    env,
  });
  // CTL-1004/CTL-1056 Bug 2: thread the spawn error code (res.error?.code, e.g.
  // ETIMEDOUT from the CTL-990 timeout) and the kill signal (res.signal, e.g.
  // SIGKILL) up so the scheduler's "dispatch failed" log is diagnosable. On a
  // spawn error preserve any stderr captured before the kill, falling back to
  // the error message when the child wrote nothing. `signal` is carried on every
  // result (null on a clean exit) so the scheduler reads one consistent shape.
  if (res.error) {
    const stderr = res.stderr && res.stderr.length ? res.stderr : res.error.message;
    return {
      code: 127,
      stdout: res.stdout ?? "",
      stderr,
      spawnError: res.error.code ?? res.error.message,
      signal: res.signal ?? null,
    };
  }
  return {
    code: res.status ?? 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    signal: res.signal ?? null,
  };
}

// defaultDispatch — execution-core worker dispatch. Resolve the project, create
// (or reuse) the worktree, run phase-agent-dispatch in it. The three steps are
// injectable seams so the unit test never spawns a real script. A failure at
// any step returns a non-zero code with a descriptive stderr — never silent.
//
// CTL-615: now also threads `expectedBranch: ticket` into createWorktree
// (which forwards --expected-branch to the script) and, when callers pass
// `expectedWorktreePath`, cross-checks that against the path createWorktree
// actually resolved. A mismatch returns `revive-aborted-wrong-cwd` without
// launching the phase agent — so a revive can never land in a stranger's
// worktree even if the registry resolution chain is corrupt. The dispatch
// result always carries `worktreePath` so callers (defaultReviveDispatch)
// can record / cross-check on later cycles.
// CTL-658: `resumeSession` (when the daemon resolved a resume UUID) is forwarded
// verbatim to runPhaseAgent so the spawned phase-agent-dispatch carries
// `--resume-session`. Absent on every cold dispatch — only the revive path sets it.
export function defaultDispatch(
  {
    orchDir,
    ticket,
    phase,
    expectedWorktreePath,
    resumeSession,
    handoffPath,
    attempt,
    clusterGeneration,
  },
  {
    resolveProject = defaultResolveProject,
    createWorktree = defaultCreateWorktree,
    runPhaseAgent = defaultRunPhaseAgent,
  } = {}
) {
  const project = resolveProject(ticket);
  if (!project) {
    return {
      code: 1,
      stdout: "",
      stderr: `dispatch: no registry entry for the team of ${ticket}`,
    };
  }
  const wt = createWorktree({ ticket, repoRoot: project.repoRoot, expectedBranch: ticket });
  if (wt.code !== 0 || !wt.worktreePath) {
    return {
      code: wt.code || 1,
      stdout: "",
      stderr: `dispatch: worktree provisioning failed for ${ticket}: ${wt.stderr}`,
      worktreePath: wt.worktreePath ?? null,
    };
  }
  if (expectedWorktreePath && expectedWorktreePath !== wt.worktreePath) {
    return {
      code: 1,
      stdout: "",
      stderr:
        `dispatch: revive-aborted-wrong-cwd — expected ${expectedWorktreePath}, ` +
        `got ${wt.worktreePath} for ${ticket}`,
      worktreePath: wt.worktreePath,
    };
  }
  const res = runPhaseAgent({
    orchDir,
    ticket,
    phase,
    worktreePath: wt.worktreePath,
    resumeSession,
    handoffPath,
    attempt,
    clusterGeneration,
  }); // CTL-761, CTL-864
  // CTL-1365b: the sdk launch verb (sdkRunPhaseAgent) is ASYNC — it returns a
  // Promise; the bg launch verb (defaultRunPhaseAgent) is SYNCHRONOUS — it returns
  // a plain object. Detect a thenable and compose worktreePath onto the AWAITED
  // result so an sdk dispatch resolves to the same {code,…,worktreePath} shape. The
  // synchronous bg path takes the unchanged object branch below → byte-identical to
  // today (the existing dispatch.test.mjs `toEqual` assertions use sync stubs and
  // never reach the thenable branch).
  if (res && typeof res.then === "function") {
    return res.then((r) => ({ ...r, worktreePath: wt.worktreePath }));
  }
  return { ...res, worktreePath: wt.worktreePath };
}

// sdkDispatch — CTL-1365b: the executor=sdk dispatch function. IDENTICAL to
// defaultDispatch except the LAUNCH VERB: it injects sdkRunPhaseAgent (the
// in-process Agent SDK query() worker) in place of defaultRunPhaseAgent (the
// `claude --bg` spawn). It reuses defaultDispatch's resolve-project →
// create-worktree → run-phase pipeline verbatim, so the ONLY behavioral delta vs
// bg is which runPhaseAgent runs (the seam the whole cutover turns on). Because
// sdkRunPhaseAgent is async, defaultDispatch's thenable branch composes
// worktreePath onto the awaited result, so sdkDispatch returns a
// Promise<{code,…,worktreePath}>. `runPhaseAgent` stays an injectable default so
// the unit test can assert the wiring without the real SDK; the remaining seams
// (resolveProject/createWorktree/…) pass straight through to defaultDispatch.
export function sdkDispatch(args, { runPhaseAgent = sdkRunPhaseAgent, ...seams } = {}) {
  return defaultDispatch(args, { runPhaseAgent, ...seams });
}

// dispatchForExecutor — CTL-1365b Stage C: map a resolved executor
// (config.mjs:getExecutor) to the dispatch function the daemon threads into ALL
// FOUR dispatch entry points (scheduler pull-loop, monitor →Triage one-shot,
// comment-wake re-dispatch, boot-resume crash-recovery). Resolved ONCE per boot
// and threaded to every site so a node never split-brains (some sites bg, others
// sdk).
//   - "bg" | "oneshot-legacy" → defaultDispatch (the `claude --bg` path). Returned
//     BY IDENTITY, so the existing dispatch.test.mjs arg-array `toEqual`
//     assertions are unaffected — the dispatched behavior is byte-identical to
//     today.
//   - "sdk" → sdkDispatch (injects sdkRunPhaseAgent — the in-process SDK worker).
// Pure + identity-stable (the SAME function object per executor) so the daemon's
// four-entry-point wiring is assertable by reference.
export function dispatchForExecutor(executor) {
  return executor === "sdk" ? sdkDispatch : defaultDispatch;
}

// makeCommentWakeDispatch — CTL-1365b Stage C: bind the resolved executor dispatch
// into the positional (orchDir,ticket,phase,opts) shape handleCommentWake invokes,
// so a comment-wake re-dispatch routes through the SAME executor as the
// scheduler/monitor/boot-resume — closing the split-brain the plan-review flagged
// (without it, comment-wakes would still route to bg under executor=sdk). For
// executor=bg, `dispatch` === defaultDispatch, so this is byte-identical to the
// prior `dispatch: dispatchTicket` wiring (dispatchTicket's own default dispatch IS
// defaultDispatch).
export function makeCommentWakeDispatch(dispatch) {
  return (orchDir, ticket, phase, opts = {}) =>
    dispatchTicket(orchDir, ticket, phase, { ...opts, dispatch });
}

// dispatchTicket — thin seam over the injectable dispatch function.
// CTL-705: forwards optional resumeSession so the resume re-dispatch path can
// pass a resume UUID. Omitted when absent — the legacy toEqual assertions stay
// green because the key is not added when the value is falsy.
export function dispatchTicket(
  orchDir,
  ticket,
  phase,
  { dispatch = defaultDispatch, resumeSession, handoffPath, attempt, clusterGeneration } = {}
) {
  const args = { orchDir, ticket, phase };
  if (resumeSession) args.resumeSession = resumeSession;
  if (handoffPath) args.handoffPath = handoffPath;
  if (attempt != null) args.attempt = attempt; // CTL-761
  if (clusterGeneration != null) args.clusterGeneration = clusterGeneration; // CTL-864
  return dispatch(args);
}

// ── CTL-1367 P1: async-dispatch settlement seam ─────────────────────────────
//
// The bg launch verb (defaultRunPhaseAgent) is SYNCHRONOUS — it returns a plain
// result the moment `claude --bg` is launched. The sdk launch verb
// (sdkRunPhaseAgent) is ASYNC — it returns a Promise that resolves only AFTER the
// in-process query() runs the WHOLE phase. The dispatch consumers (the scheduler's
// dispatchAndVerify, the monitor's dispatchTriage, the boot-resume/recovery
// reviveDispatch) all read `result.code` SYNCHRONOUSLY; under executor=sdk that read
// saw a Promise (`undefined` code) and recorded a dispatch FAILURE while the query
// ran detached — the P1 bug.
//
// The fix exploits a structural fact: the sdk launch verb runs the SAME synchronous
// shared pre-launch (spawnSync phase-agent-dispatch --launch-mode prelaunch-only)
// BEFORE its first `await`, so by the time the Promise is returned the
// status:"dispatched" signal has ALREADY been written to disk. So a synchronous
// consumer does NOT need to await the (long-running) query — it treats the sdk
// dispatch exactly like a bg dispatch: the launch already happened, success is
// confirmed by the signal file, and the eventual terminal event (emitted by the
// phase skill, or the backstop on abnormal termination) wakes the orchestrator
// later — identical to how a `claude --bg` worker's events drive advancement.
//
// settleDispatchSync bridges the two:
//   • a SYNC result → returned unchanged (bg path is byte-identical; the existing
//     toEqual tests that inject sync stubs never reach the async branch).
//   • a Promise (sdk) → (a) a DETACHED settle handler is attached so the query runs
//     to completion in the background and its settlement never escapes as an
//     unhandled rejection, and (b) a synchronous provisional { code, async:true } is
//     returned, where `code` reflects whether the synchronously-written prelaunch
//     signal is runnable (the SDK-aware verification — NO bg_job_id required, since
//     the SDK prelaunch intentionally has none). The caller then proceeds exactly as
//     it does for a bg dispatch.
export function isThenable(x) {
  return x != null && (typeof x === "object" || typeof x === "function") && typeof x.then === "function";
}

// sdkSignalRunnable — read workers/<ticket>/phase-<phase>.json and report whether
// it is in a runnable/launched state for the SDK path. Accepts dispatched|running
// (the prelaunch wrote dispatched; the skill flips it to running) AND done (an
// idempotent duplicate dispatch of an already-completed phase). Crucially it does
// NOT require a bg_job_id — the SDK prelaunch never writes one (E3). false when the
// signal is absent, unparseable, or failed/stalled (a failed prelaunch).
export function sdkSignalRunnable(orchDir, ticket, phase) {
  try {
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"));
    const st = sig?.status;
    return st === "dispatched" || st === "running" || st === "done";
  } catch {
    return false;
  }
}

export function settleDispatchSync(result, { verifySync, onSettled } = {}) {
  if (isThenable(result)) {
    // (a) Detached settle handler — the query runs to completion in the background;
    // its terminal event is emitted by the worker/backstop. Swallow the settlement
    // so it can never surface as an unhandled rejection on the daemon event loop.
    Promise.resolve(result).then(
      (r) => { if (onSettled) { try { onSettled(r, null); } catch { /* best-effort */ } } },
      (err) => { if (onSettled) { try { onSettled(null, err); } catch { /* best-effort */ } } },
    );
    // (b) Synchronous provisional: the prelaunch signal IS the launch confirmation.
    const ok = verifySync ? verifySync() !== false : true;
    return { code: ok ? 0 : 1, async: true };
  }
  return result;
}
