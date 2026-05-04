/**
 * Pure-function transition table for the orchestrator-driven deploy state machine.
 *
 * The orchestrator's Phase 4 loop reads its current view of a worker's signal +
 * the next event from the unified event log, asks `nextDeployState` what to do,
 * and applies the returned patch + raises any attention message.
 *
 * Splitting this from the bash glue lets us test every transition mechanically.
 *
 * State machine (CTL-211):
 *
 *   merging → merged → deploying → done
 *                              ↘ deploy-failed → (retry within budget) → deploying
 *                              ↘ stalled (on timeout / budget exhausted)
 *
 * Shortcut: when `skipDeployVerification: true`, MERGED jumps straight to `done`
 * (preserves CTL-133 behavior for repos without GitHub Deployments).
 */

export type DeployRelevantStatus =
  | "merging"
  | "merged"
  | "deploying"
  | "deploy-failed"
  | "done"
  | "failed"
  | "stalled";

export interface DeployEvent {
  /** Topic from the unified event log. */
  type:
    | "github.pr.merged"
    | "github.deployment.created"
    | "github.deployment_status";
  /** GitHub deployment environment, when applicable. `null` for `pr.merged`. */
  environment: string | null;
  /** Deployment state, only meaningful for `deployment_status`. */
  state: "success" | "failure" | "error" | "in_progress" | "pending" | null;
  /** Commit SHA the event applies to. */
  sha: string;
}

export interface DeployStateInputs {
  /** Current ms-since-epoch (injected for testability). */
  nowMs: number;
  /** Worker's current signal-file status. Accepts arbitrary strings so this
   *  doesn't have to import the canonical signal-schema status enum, but the
   *  state machine only acts on the deploy-relevant subset (see TERMINAL set
   *  and the event-handling branches below). */
  currentStatus: string;
  /** Merge commit SHA (resolved when PR went MERGED). */
  mergeCommitSha: string | null;
  /** Production environment to gate `done` on. */
  productionEnvironment: string;
  /** Hard timeout for the whole deploy phase. */
  timeoutSec: number;
  /** When true, MERGED → done immediately. */
  skipDeployVerification: boolean;
  /** Wall clock when we first observed `merged` (i.e. PR became MERGED).
   *  Null until we transition into `merged`. Used for timeout detection. */
  deployStartedAtMs: number | null;
  /** Number of `deployment_status.failure|error` observed so far. */
  failedAttempts: number;
  /** Hard cap on retries (one attention per cap). */
  maxAttempts: number;
  /** Next event from the log; null if this is a polling tick. */
  event: DeployEvent | null;
}

export interface DeployStatePatch {
  status?: DeployRelevantStatus;
  /** Set when first observing the merge — clock for timeout detection. */
  deployStartedAtMs?: number;
  /** Bumped on every observed failure event. */
  failedAttempts?: number;
}

export interface DeployStateResult {
  patch: DeployStatePatch;
  /** Non-null when we want to raise an `attention` to the orchestrator. */
  attention: string | null;
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "stalled"]);

function envMatches(
  ev: DeployEvent,
  inputs: DeployStateInputs,
): boolean {
  if (ev.environment === null) return false;
  if (ev.environment !== inputs.productionEnvironment) return false;
  if (inputs.mergeCommitSha !== null && ev.sha !== inputs.mergeCommitSha) return false;
  return true;
}

export function nextDeployState(inputs: DeployStateInputs): DeployStateResult {
  // 1. Terminal states absorb everything.
  if (TERMINAL.has(inputs.currentStatus)) {
    return { patch: {}, attention: null };
  }

  // 2. Timeout escalation runs even when no event arrived (orchestrator polling tick).
  if (
    inputs.deployStartedAtMs !== null &&
    inputs.nowMs - inputs.deployStartedAtMs > inputs.timeoutSec * 1000
  ) {
    return {
      patch: { status: "stalled" },
      attention: `deploy timeout after ${inputs.timeoutSec}s`,
    };
  }

  // 3. Without an event, no further transition possible.
  if (inputs.event === null) {
    return { patch: {}, attention: null };
  }

  const ev = inputs.event;

  // 4. PR merge — moves merging → merged (or → done when verification is skipped).
  if (ev.type === "github.pr.merged") {
    if (inputs.skipDeployVerification) {
      return { patch: { status: "done" }, attention: null };
    }
    return {
      patch: { status: "merged", deployStartedAtMs: inputs.nowMs },
      attention: null,
    };
  }

  // 5. Deployment created for production env on the merge SHA → deploying.
  if (ev.type === "github.deployment.created" && envMatches(ev, inputs)) {
    return { patch: { status: "deploying" }, attention: null };
  }

  // 6. Deployment status events — success / failure / error.
  if (ev.type === "github.deployment_status" && envMatches(ev, inputs)) {
    if (ev.state === "success") {
      return { patch: { status: "done" }, attention: null };
    }
    if (ev.state === "failure" || ev.state === "error") {
      const newAttempts = inputs.failedAttempts + 1;
      const exhausted = newAttempts >= inputs.maxAttempts;
      return {
        patch: { status: "deploy-failed", failedAttempts: newAttempts },
        attention: exhausted
          ? `deploy-retry budget exhausted after ${newAttempts} attempts`
          : `production deploy ${ev.state} (attempt ${newAttempts}/${inputs.maxAttempts})`,
      };
    }
    // pending / in_progress are just signals — no transition needed.
    return { patch: {}, attention: null };
  }

  return { patch: {}, attention: null };
}
