/**
 * Pure-function helper for stamping orchestrator attribution on github.* events
 * (CTL-234).
 *
 * Webhook fan-out (CTL-209) is repo-level — it doesn't know which orchestrator
 * a PR belongs to, so events arrive without `.scope.orchestrator`. Filters of
 * the form `(.orchestrator == "orch-foo") and (...)` then silently drop every
 * github event. This helper resolves a (repo, pr?, headRef?) tuple to an
 * orchestrator ID by checking the PRs known to each active orchestrator and,
 * as a fallback, matching the head ref against the orchestrator's branch
 * prefix.
 *
 * No I/O — caller supplies the active-orchestrator list.
 */

export interface ActiveOrchestrator {
  /** Orchestrator ID (basename of the run directory, e.g. `orch-foo-2026-05-04`). */
  id: string;
  /**
   * Branch prefix used by the orchestrator's workers — typically `${id}-`.
   * Match must include the trailing separator so `orch-foo-` does not
   * accidentally match `orch-foobar-1`.
   */
  branchPrefix: string;
  /** PR numbers known to belong to this orchestrator (from worker signal files). */
  prs: Array<{ repo: string; number: number }>;
}

export interface OrchestratorResolverInput {
  repo: string;
  /** PR-number resolution path — exact match is authoritative. */
  pr?: number;
  /** Branch-name resolution path — used when pr is unknown or unmatched. */
  headRef?: string;
}

export function resolveOrchestrator(
  input: OrchestratorResolverInput,
  active: ActiveOrchestrator[],
): string | null {
  if (active.length === 0) return null;

  if (typeof input.pr === "number" && input.pr > 0) {
    for (const orch of active) {
      for (const pr of orch.prs) {
        if (pr.repo === input.repo && pr.number === input.pr) return orch.id;
      }
    }
  }

  const headRef = input.headRef ?? "";
  if (headRef.length === 0) return null;

  let best: ActiveOrchestrator | null = null;
  for (const orch of active) {
    if (orch.branchPrefix.length === 0) continue;
    if (!headRef.startsWith(orch.branchPrefix)) continue;
    if (best === null || orch.branchPrefix.length > best.branchPrefix.length) {
      best = orch;
    }
  }
  return best?.id ?? null;
}
