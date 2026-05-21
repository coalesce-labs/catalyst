// scan.mjs — execution-core deterministic per-event scan (CTL-533).
//
// The Phase-4 orchestrator monitor scan body, extracted from
// orchestrate/SKILL.md as an LLM-free function. On each event it walks
// Steps A/C/E/F/G over the unified worker-signal set and returns an
// aggregate of patches + attentions + events + incident-handler invocations
// for a thin caller to apply. All non-determinism is injected via `adapters`,
// so the whole scan is testable without a real repo or network.
//
//   Step A — gather ground truth (git branch/commits, PR) per worker
//   Step C — merge confirmation        → nextMergeState
//   Step E — deploy state machine      → nextDeployState
//   Step F — comms-channel drain       → drainComms
//   Step G — stalled detection         → detectStalled
//
// Steps B/D/K (dashboard render, broker refresh, deregister) and Step 0
// (healthcheck) are intentionally out of scope — they carry non-deterministic
// side effects or are already standalone scripts.

import { readWorkerSignals } from "./signal-reader.mjs";
import { nextMergeState } from "./merge-state.mjs";
import { nextDeployState } from "./deploy-state.mjs";
import { drainComms } from "./comms-drain.mjs";
import { detectStalled } from "./stalled-detector.mjs";

// Worker statuses for which the Step E deploy sub-loop runs.
const DEPLOY_RELEVANT = new Set(["merged", "deploying", "deploy-failed"]);

// runScan — the deterministic per-event scan entry point.
//
// inputs: {
//   orchDir, orchId, event (unified-log event | null), nowMs,
//   commsCursor, adapters:{ git, gh, deploy, comms },
// }
// returns: {
//   patches:[{signalPath, patch}], attentions:[], events:[],
//   handlerInvocations:[{name, args}], newCommsCursor,
// }
export function runScan({
  orchDir,
  orchId,
  event,
  nowMs,
  commsCursor = 0,
  adapters,
}) {
  const signals = readWorkerSignals(orchDir);
  const patches = [];
  const attentions = [];
  const events = [];

  for (const sig of signals) {
    const derived = gatherWorkerState(sig, adapters); // Step A

    // Step C — merge confirmation.
    collect(
      { patches, attentions, events },
      sig,
      nextMergeState(mergeInputs(sig, derived, adapters)),
    );

    // Step E — deploy state machine (only deploy-relevant workers).
    if (DEPLOY_RELEVANT.has(sig.status)) {
      collect(
        { patches, attentions, events },
        sig,
        nextDeployState(deployInputs(sig, derived, adapters, nowMs, event)),
      );
    }

    // Step G — stalled detection.
    collect(
      { patches, attentions, events },
      sig,
      detectStalled(stalledInputs(sig, derived, nowMs)),
    );
  }

  // Step F — comms-channel drain (orchestrator-scoped, runs once).
  const messages = adapters.comms.readSince(commsCursor);
  const { attentions: commsAtt, newCursor } = drainComms({
    messages,
    cursor: commsCursor,
  });
  attentions.push(...commsAtt);

  return {
    patches,
    attentions,
    events,
    handlerInvocations: incidentHandlers(orchDir, orchId),
    newCommsCursor: newCursor,
  };
}

// gatherWorkerState — Step A: re-derive ground truth (git branch, commit
// count, remote-branch existence, PR + merge view) through injected adapters.
// The signal file is advisory only; GitHub/git are authoritative.
function gatherWorkerState(sig, adapters) {
  const ticket = sig.ticket;
  const branch = adapters.git.branch(ticket) || "";
  const commitCount = branch ? adapters.git.commitCount(ticket) : 0;
  const remoteBranchExists = branch
    ? adapters.git.remoteBranchExists(ticket)
    : false;

  // Discover the PR: prefer the one recorded on the signal, else by branch.
  const signalPr = sig.pr && sig.pr.number ? sig.pr : null;
  const discovered = branch ? adapters.gh.prForBranch(ticket, branch) : null;
  const pr = signalPr ?? discovered ?? null;

  // Authoritative merge view, only when a PR is known.
  const prView = pr ? adapters.gh.prView(ticket, pr) : null;

  return { branch, commitCount, remoteBranchExists, pr, prView };
}

// mergeInputs — shape a worker's state for nextMergeState (Step C).
function mergeInputs(sig, derived, adapters) {
  const view = derived.prView;
  const repo = repoFor(sig, derived);
  return {
    ticket: sig.ticket,
    prState: view?.state ?? "NONE",
    mergeStateStatus: view?.mergeStateStatus ?? "UNKNOWN",
    prNumber: derived.pr?.number ?? null,
    mergedAt: view?.mergedAt ?? null,
    mergeCommitSha: view?.mergeCommitSha ?? null,
    signalMergedAt: sig.pr?.mergedAt ?? null,
    skipDeployVerification: adapters.deploy.skipDeployVerification(repo),
    currentStatus: sig.status,
  };
}

// deployInputs — shape a worker's state for nextDeployState (Step E).
function deployInputs(sig, derived, adapters, nowMs, event) {
  const deploy = sig.raw?.deploy ?? {};
  const repo = repoFor(sig, derived);
  return {
    nowMs,
    currentStatus: sig.status,
    mergeCommitSha: sig.pr?.mergeCommitSha ?? derived.pr?.mergeCommitSha ?? null,
    productionEnvironment: adapters.deploy.productionEnvironment(repo),
    timeoutSec: adapters.deploy.timeoutSec(repo),
    skipDeployVerification: adapters.deploy.skipDeployVerification(repo),
    deployStartedAtMs: deploy.startedAt ? Date.parse(deploy.startedAt) : null,
    failedAttempts: deploy.failedAttempts ?? 0,
    maxAttempts: 3,
    event: toDeployEvent(event),
  };
}

// stalledInputs — shape a worker's state for detectStalled (Step G).
function stalledInputs(sig, derived, nowMs) {
  return {
    ticket: sig.ticket,
    nowMs,
    updatedAtMs: sig.updatedAt ? Date.parse(sig.updatedAt) : null,
    currentStatus: sig.status,
    prState: derived.prView?.state ?? derived.pr?.state ?? "NONE",
    commitCount: derived.commitCount,
    remoteBranchExists: derived.remoteBranchExists,
    branch: derived.branch,
  };
}

// toDeployEvent — narrow a unified-log event to the DeployEvent shape
// nextDeployState expects; null for unrelated events or polling ticks.
function toDeployEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  if (!event.type.startsWith("github.deployment") &&
      event.type !== "github.pr.merged") {
    return null;
  }
  return {
    type: event.type,
    environment: event.environment ?? null,
    state: event.state ?? null,
    sha: event.sha ?? "",
  };
}

// repoFor — the GitHub "<owner>/<repo>" slug for a worker, used to look up
// per-repo deploy config through the deploy adapter. Null when unknown.
function repoFor(sig, derived) {
  return derived.pr?.repo ?? sig.raw?.repo ?? null;
}

// incidentHandlers — the bash scan runs all three unconditionally after the
// loops. We return them as descriptors for the thin caller to exec.
function incidentHandlers(orchDir, orchId) {
  const args = ["--orch-dir", orchDir, "--orch-id", orchId];
  return [
    { name: "orchestrate-revive", args },
    { name: "orchestrate-auto-fixup", args },
    { name: "orchestrate-auto-rebase", args },
  ];
}

// collect — the single place patches/attentions/events are appended. Patches
// are keyed by signalPath so the caller knows which file to merge into.
function collect(acc, sig, result) {
  if (!result) return;
  if (result.patch && Object.keys(result.patch).length > 0) {
    acc.patches.push({ signalPath: sig.signalPath, patch: result.patch });
  }
  if (result.attention) acc.attentions.push(result.attention);
  if (Array.isArray(result.events) && result.events.length > 0) {
    acc.events.push(...result.events);
  }
}
