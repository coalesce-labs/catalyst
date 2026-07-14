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
import { sdkRunPhaseAgent, defaultEmitBackstop, scrubSecrets } from "./sdk-run-phase-agent.mjs"; // CTL-1365b: the executor=sdk launch verb (in-process Agent SDK query()); CTL-1367 P1: shared failed-terminal backstop for a rejected async dispatch; CTL-1367 item 11: scrub token-shaped substrings out of a rejected-dispatch reason before it is backstopped/logged
import { codexRunPhaseAgent } from "./codex-run-phase-agent.mjs"; // CTL-1457: the executor=codex-exec launch verb (spawns `codex exec --json` as a child process)
import { hasFreshClaim } from "./signal-reader.mjs"; // CTL-1367 P2-G: a young single-flight claim makes a missing SDK signal a benign claim-lost no-op
import { log, resolveExecutorForPhase } from "./config.mjs"; // CTL-1367 P1: log a swallowed async-dispatch rejection before the backstop fires; CTL-1457: per-phase executor routing hook (the default seam threaded into makePhaseAwareDispatchFn)

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
    // CTL-1457: attribute the bg launch verb — phase-agent-dispatch reads this
    // (defaulting to "bg" when absent) to write executor:"bg" into the signal
    // file + carry it into the worker env, so bg workers are attributed too.
    CATALYST_EXECUTOR_ID: "bg",
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
// CTL-1396 (Codex P2): `emitEvent` is the unified-event-log appender the DAEMON
// injects (see daemon.mjs's dispatchFn binding). When present, bind it onto the
// async sdk launch verb so sdkRunPhaseAgent's telemetry — `execution-core.sdk.phase-turns`
// (the turn-cap calibration signal) plus .overloaded/.auth.misconfigured — reaches the
// JSONL event log / Loki instead of only sdkRunPhaseAgent's stderr default. Absent
// (other callers / unit tests) → sdkRunPhaseAgent keeps its dependency-free stderr
// default, byte-identical to before.
export function sdkDispatch(args, { runPhaseAgent = sdkRunPhaseAgent, emitEvent, ...seams } = {}) {
  // CTL-1405: sdkRunPhaseAgent reads `emitEvent` from its SECOND (options) param,
  // NOT the first (input) object — so bind it there. The prior CTL-1396 shape
  // `runPhaseAgent({ ...a, emitEvent })` spread it into the input object, where
  // sdkRunPhaseAgent never reads it → it silently kept the stderr defaultEmitEvent,
  // so phase-turns/overloaded/auth telemetry never reached the JSONL event log.
  const launch = emitEvent ? (a) => runPhaseAgent(a, { emitEvent }) : runPhaseAgent;
  return defaultDispatch(args, { runPhaseAgent: launch, ...seams });
}

// codexDispatch — CTL-1457: the executor=codex-exec dispatch function. IDENTICAL
// to sdkDispatch except the LAUNCH VERB: it injects codexRunPhaseAgent (the
// `codex exec --json` child-process worker) in place of sdkRunPhaseAgent. It reuses
// defaultDispatch's resolve-project → create-worktree → run-phase pipeline verbatim
// (the resolveProject/createWorktree/… seams pass straight through), so the ONLY
// behavioral delta vs sdk is which runPhaseAgent runs. codexRunPhaseAgent — like
// sdkRunPhaseAgent — reads `emitEvent` from its SECOND (options) param, so the
// daemon-injected unified-event-log appender is bound there when present (absent →
// codexRunPhaseAgent keeps its dependency-free stderr default, byte-identical).
// Because codexRunPhaseAgent is async, defaultDispatch's thenable branch composes
// worktreePath onto the awaited result, so codexDispatch returns a
// Promise<{code,…,worktreePath}> exactly as sdkDispatch does.
// CTL-1457 (finding 4): `configPath` is threaded into the runner's SECOND (options)
// param alongside `emitEvent` so codexRunPhaseAgent's runtime codexConfig({configPath})
// resolves the SAME Layer-1 catalyst.orchestration.codex.* (codexHome/model/writableRoots)
// the daemon's boot eligibility gate validated — without it a Layer-1-only codexHome
// would be honored at boot but NOT at dispatch (the runtime auth guard + buildCodexArgs
// would fall back to the default home). When configPath is undefined the launch wrapper
// is byte-identical to the prior emitEvent-only shape (codexConfig treats an undefined
// configPath the same as an omitted one).
export function codexDispatch(
  args,
  { runPhaseAgent = codexRunPhaseAgent, emitEvent, configPath, ...seams } = {}
) {
  const launch =
    emitEvent || configPath ? (a) => runPhaseAgent(a, { emitEvent, configPath }) : runPhaseAgent;
  return defaultDispatch(args, { runPhaseAgent: launch, ...seams });
}

// dispatchForExecutor — CTL-1365b Stage C / CTL-1457: map a resolved executor to
// the dispatch function threaded into the daemon's dispatch entry points. Resolved
// per dispatch by makePhaseAwareDispatchFn (per-phase routing) — and still resolved
// once at boot for the node default — so a node never split-brains.
//   - "bg" | "oneshot-legacy" → defaultDispatch (the `claude --bg` path). Returned
//     BY IDENTITY (the `?? defaultDispatch` fallback), so the existing
//     dispatch.test.mjs arg-array `toEqual` assertions are unaffected — the
//     dispatched behavior is byte-identical to today.
//   - "sdk" → sdkDispatch (injects sdkRunPhaseAgent — the in-process SDK worker).
//   - "codex-exec" → codexDispatch (injects codexRunPhaseAgent — the `codex exec`
//     child-process worker).
// Pure + identity-stable (the SAME function object per executor value) so the
// daemon's multi-entry-point wiring is assertable by reference.
const DISPATCH_BY_EXECUTOR = Object.freeze({
  sdk: sdkDispatch,
  "codex-exec": codexDispatch,
});
export function dispatchForExecutor(executor) {
  return DISPATCH_BY_EXECUTOR[executor] ?? defaultDispatch;
}

// Module refs captured so makePhaseAwareDispatchFn's SAME-named injectable params
// can default to the real implementations without a TDZ self-reference in the
// destructuring default (`{ dispatchForExecutor = dispatchForExecutor }` would
// reference the param binding itself, not the module symbol).
const _defaultResolveExecutorForPhase = resolveExecutorForPhase;
const _defaultDispatchForExecutor = dispatchForExecutor;

// makePhaseAwareDispatchFn — CTL-1457: build the SINGLE dispatchFn closure the
// daemon threads to ALL FIVE dispatch entry points (scheduler pull-loop, monitor
// →Triage one-shot, comment-wake re-dispatch, boot-resume, approved-resume). Per
// dispatch it consults resolveExecutorForPhase(phase) so a routed phase runs on its
// configured executor while every other phase runs on the boot executor — replacing
// the CTL-1365b single-boot-executor selection without changing any entry-point
// wiring.
//
// ZERO-CHANGE-WHEN-UNROUTED INVARIANT: only a phase EXPLICITLY present in
// executorByPhase (resolveExecutorForPhase → source === "executorByPhase")
// overrides the boot executor; an unrouted phase keeps `effective === bootExecutor`.
// With an empty map (the default) NO phase is routed ⇒ every phase runs on the boot
// executor ⇒ the selected dispatch fn + emitEvent wrapping are byte-identical to the
// pre-CTL-1457 boot wiring. Gating on `source` (not merely on a truthy executor) is
// deliberate: resolveExecutorForPhase's fallback for an unrouted phase is the raw
// node executor from resolveExecutor, which for executor=sdk+failing-boot-auth is
// still "sdk" — so a bare `if (routed) effective = routed` would silently UNDO the
// CTL-1367 boot auth-gate degrade (sdk→bg). Honoring only the explicit-route source
// preserves that degrade (bootExecutor already carries it).
//
// Seams: resolveExecutorForPhase + dispatchForExecutor default to the real module
// implementations but are injectable so the unit test drives the routing decision
// with fakes (no config file, no real dispatch). `emitEvent` is the daemon's
// one-arg { "event.name", payload } unified-event-log appender; it is wrapped into
// the two-arg (name, payload) shape sdk/codex runners expect for the sdk AND
// codex-exec arms only (the bg/oneshot arm never emits, byte-identical to today).
export function makePhaseAwareDispatchFn({
  bootExecutor,
  codexBootEligible,
  configPath,
  emitEvent,
  resolveExecutorForPhase = _defaultResolveExecutorForPhase,
  dispatchForExecutor = _defaultDispatchForExecutor,
  log: logger = log,
} = {}) {
  return (args, seams = {}) => {
    // Per-phase routing. Only an EXPLICITLY-routed phase (source "executorByPhase")
    // overrides the boot executor; an unrouted phase keeps the boot executor (which
    // already carries the sdk→bg boot auth-gate degrade). resolveExecutorForPhase
    // THROWS on an invalid routed value — caught here so a typo degrades that dispatch
    // to the boot executor (loud-but-non-fatal) instead of crashing the daemon.
    let effective = bootExecutor;
    try {
      const routed = resolveExecutorForPhase(args.phase, { configPath });
      if (routed?.source === "executorByPhase" && routed.executor) {
        effective = routed.executor;
      }
    } catch (err) {
      logger?.error?.(
        { err: err.message, phase: args.phase },
        "executorByPhase routing invalid — using boot executor"
      );
      effective = bootExecutor;
    }
    // Codex degrade: a routed codex-exec phase falls back to the boot executor when
    // the codex boot precondition (auth + binary) failed — the boot check already
    // WARNed + emitted execution-core.executor.codex-fallback. Defense-in-depth
    // (finding 1): when the boot executor is ITSELF codex-exec (a codex node whose
    // boot gate should already have degraded it, but did not reach here degraded),
    // fall back to "bg" — a concrete non-codex executor — never back to codex-exec,
    // which would dispatch to the same unusable codex.
    if (effective === "codex-exec" && !codexBootEligible) {
      effective = bootExecutor === "codex-exec" ? "bg" : bootExecutor;
    }
    const fn = dispatchForExecutor(effective);
    if (effective === "sdk" || effective === "codex-exec") {
      return fn(args, {
        emitEvent: (name, payload) => emitEvent({ "event.name": name, payload }),
        // CTL-1457 (finding 4): the codex runner resolves its runtime codexConfig from
        // configPath — thread it so the runtime auth guard + buildCodexArgs honor the
        // SAME Layer-1 codex.* the boot gate checked. Scoped to the codex arm (the sdk
        // dispatch ignores unknown seams, so this is a no-op there either way).
        ...(effective === "codex-exec" ? { configPath } : {}),
        ...seams,
      });
    }
    return fn(args, seams);
  };
}

// makeCommentWakeDispatch — CTL-1365b Stage C: bind the resolved executor dispatch
// into the positional (orchDir,ticket,phase,opts) shape handleCommentWake invokes,
// so a comment-wake re-dispatch routes through the SAME executor as the
// scheduler/monitor/boot-resume — closing the split-brain the plan-review flagged
// (without it, comment-wakes would still route to bg under executor=sdk). For
// executor=bg, `dispatch` === defaultDispatch, so this is byte-identical to the
// prior `dispatch: dispatchTicket` wiring (dispatchTicket's own default dispatch IS
// defaultDispatch).
//
// CTL-1367 P2-D: comment-wake is the 6th dispatch entry point and was the ONLY one
// NOT settling its async (executor=sdk) result. handleCommentWake ignores the
// returned promise, so a rejection after the synchronous prelaunch wrote
// status:"dispatched" (e.g. buildSdkEnv/buildQueryOptions throwing) left the
// no-bg_job_id SDK signal with no terminal event — and surfaced as an unhandled
// rejection. Settle through settleDispatchSync + backstopOnRejection (exactly like
// the scheduler/monitor/recovery entry points): on a rejected SDK promise it emits
// the failed-terminal backstop (stalled signal + phase.<phase>.failed). For the bg
// path dispatchTicket returns a SYNC result and settleDispatchSync passes it through
// UNCHANGED (same object reference) → byte-identical.
export function makeCommentWakeDispatch(dispatch, { emitBackstop } = {}) {
  return (orchDir, ticket, phase, opts = {}) =>
    settleDispatchSync(
      dispatchTicket(orchDir, ticket, phase, { ...opts, dispatch }),
      { onSettled: backstopOnRejection({ orchDir, ticket, phase, log }, { emitBackstop }) },
    );
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
//
// CTL-1367 P2-G: a missing signal is NOT a failure when a YOUNG single-flight claim
// exists — that is a benign claim-lost (a concurrent dispatcher won the O_EXCL claim
// and is mid-dispatch; the loser writes no signal). Return runnable so a valid
// concurrent triage dispatch is a no-op, not a recorded "triage dispatch failed".
// This function is the SDK verifySync ONLY, so the bg path is untouched.
export function sdkSignalRunnable(orchDir, ticket, phase) {
  try {
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"));
    const st = sig?.status;
    return st === "dispatched" || st === "running" || st === "done";
  } catch {
    // signal absent/unparseable → benign only if a fresh claim is in flight (claim-lost).
    return hasFreshClaim(orchDir, ticket, phase);
  }
}

export function settleDispatchSync(result, { verifySync, onSettled } = {}) {
  if (isThenable(result)) {
    // (a) Detached settle handler — the query runs to completion in the background;
    // its terminal event is emitted by the worker/backstop. Swallow the settlement
    // so it can never surface as an unhandled rejection on the daemon event loop.
    // CTL-1157 F P1: capture the settled chain as `pending`. Both handlers RETURN
    // (never re-throw), so `pending` NEVER rejects — awaiting it is always safe. The
    // long-lived daemon entry points ignore it (byte-identical to before: the chain is
    // still detached + swallowed). The ONE caller that must await it is the disposable,
    // out-of-process delegate-runner child, whose executor=sdk query() runs IN-PROCESS
    // and would be killed by the child's process.exit if it exited before the query
    // finished (delegate-runner-entry). It reads `pending` and awaits it before exiting.
    const pending = Promise.resolve(result).then(
      (r) => { if (onSettled) { try { onSettled(r, null); } catch { /* best-effort */ } } return r; },
      (err) => { if (onSettled) { try { onSettled(null, err); } catch { /* best-effort */ } } return { code: 1, error: err }; },
    );
    // (b) Synchronous provisional: the prelaunch signal IS the launch confirmation.
    const ok = verifySync ? verifySync() !== false : true;
    return { code: ok ? 0 : 1, async: true, pending };
  }
  return result;
}

// backstopOnRejection — CTL-1367 P1: the `onSettled` handler the THREE async-dispatch
// entry points (scheduler dispatchAndVerify, monitor dispatchTriage, recovery
// defaultReviveDispatch) thread into settleDispatchSync. Without it a REJECTED
// dispatch promise was silently swallowed: the synchronous prelaunch had already
// written a runnable "dispatched" signal (counted as a successful launch), but an
// escape that rejects the Promise AFTER that write — e.g. buildSdkEnv /
// buildQueryOptions throwing in the window between the synchronous prelaunch and the
// query()'s own try/catch (a non-array spec.env makes `for (const kv of specEnv)`
// throw) — left the in-process SDK worker (no bg_job_id, no liveness probe) with no
// terminal event, pinning the ticket at status:"dispatched" until stale GC. This is
// exactly the silent-stall class this PR exists to eliminate.
//
// On a REJECTION (err != null) it (1) logs the swallowed rejection and (2) emits the
// FAILED terminal backstop — mirroring the SDK worker's own abnormal-termination
// backstop (defaultEmitBackstop): flip the phase signal to "stalled" (only when
// non-terminal — the P3 guard in defaultWriteSignalStalled never clobbers a done/
// complete success) and emit phase.<phase>.failed.<ticket> so the broker wakes the
// orchestrator and the ticket advances/reclaims instead of stranding. On a clean
// RESOLUTION (err == null) it is a no-op — the worker/skill emitted its own terminal
// event. Best-effort throughout; a throw here is swallowed by settleDispatchSync.
// `emitBackstop` is injectable (default = the real defaultEmitBackstop) so the three
// entry points are testable without spawning the emit binary.
export function backstopOnRejection(
  { orchDir, ticket, phase, log: logger = log },
  { emitBackstop = defaultEmitBackstop } = {}
) {
  return (_res, err) => {
    if (!err) return; // clean resolution → the worker/skill owns the terminal event
    // CTL-1367 item 11 (security): this DETACHED-rejection path bypasses the
    // resolved-result scrub (sdkRunPhaseAgent scrubs its returned stderr), so a
    // rejection whose message echoes the SDK env we built (CLAUDE_CODE_OAUTH_TOKEN /
    // ANTHROPIC_*) would otherwise persist a credential into BOTH the worker signal
    // file AND the unified event log (emitBackstop writes `reason` into the stalled
    // signal and the --reason event arg) — and into the warn log. Scrub the actual
    // env token VALUES + token-shaped substrings out of the rejection text BEFORE
    // composing `reason` and BEFORE logging, mirroring the sdkRunPhaseAgent
    // resolved-result call style: scrubSecrets(text, secrets).
    const secrets = [
      process.env.CLAUDE_CODE_OAUTH_TOKEN,
      process.env.ANTHROPIC_API_KEY,
      process.env.ANTHROPIC_AUTH_TOKEN,
    ];
    const scrubbed = scrubSecrets(err?.message ?? String(err), secrets);
    const reason = `sdk-dispatch-rejected: ${scrubbed}`;
    try {
      logger.warn(
        { ticket, phase, err: scrubbed },
        "execution-core: async sdk dispatch promise rejected — emitting failed backstop (stalled signal + phase.<phase>.failed) so the ticket does not strand at dispatched"
      );
    } catch {
      /* logging must never break the detached handler */
    }
    try {
      const signalFile = join(orchDir, "workers", ticket, `phase-${phase}.json`);
      emitBackstop({ phase, ticket, status: "failed", reason, orchDir, signalFile });
    } catch {
      /* best-effort — a failing backstop must not surface as an unhandled rejection */
    }
  };
}
