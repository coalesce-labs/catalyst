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
import { fileURLToPath } from "node:url";
import { getProjectConfig } from "./registry.mjs";
import { createWorktree as defaultCreateWorktree } from "./worktree.mjs";

// phase-agent-dispatch sits one directory up from execution-core/.
const PHASE_AGENT_DISPATCH_BIN = fileURLToPath(
  new URL("../phase-agent-dispatch", import.meta.url),
);

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
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt },
  { spawn = spawnSync } = {},
) {
  const args = ["--phase", phase, "--ticket", ticket, "--orch-dir", orchDir, "--orch-id", ticket];
  if (resumeSession) args.push("--resume-session", resumeSession);
  if (attempt != null) args.push("--attempt", String(attempt)); // CTL-761
  const extraEnv = {};
  if (handoffPath) extraEnv.CATALYST_HANDOFF_PATH = handoffPath;
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
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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
  { orchDir, ticket, phase, expectedWorktreePath, resumeSession, handoffPath, attempt },
  {
    resolveProject = defaultResolveProject,
    createWorktree = defaultCreateWorktree,
    runPhaseAgent = defaultRunPhaseAgent,
  } = {},
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
  const res = runPhaseAgent({ orchDir, ticket, phase, worktreePath: wt.worktreePath, resumeSession, handoffPath, attempt }); // CTL-761
  return { ...res, worktreePath: wt.worktreePath };
}

// dispatchTicket — thin seam over the injectable dispatch function.
// CTL-705: forwards optional resumeSession so the resume re-dispatch path can
// pass a resume UUID. Omitted when absent — the legacy toEqual assertions stay
// green because the key is not added when the value is falsy.
export function dispatchTicket(
  orchDir, ticket, phase,
  { dispatch = defaultDispatch, resumeSession, handoffPath, attempt } = {},
) {
  const args = { orchDir, ticket, phase };
  if (resumeSession) args.resumeSession = resumeSession;
  if (handoffPath) args.handoffPath = handoffPath;
  if (attempt != null) args.attempt = attempt; // CTL-761
  return dispatch(args);
}
