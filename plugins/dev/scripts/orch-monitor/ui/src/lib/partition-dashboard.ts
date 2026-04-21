import type {
  CollectedAttention,
  OrchestratorState,
  SessionTimeFilter,
} from "./types";
import { filterOrchestrators } from "./session-filters";

export interface DashboardPartitionInput {
  orchestrators: OrchestratorState[];
  attention: CollectedAttention[];
  timeFilter: SessionTimeFilter;
}

export interface DashboardPartition {
  needsMe: CollectedAttention[];
  shipping: OrchestratorState[];
  recent: OrchestratorState[];
}

/**
 * Partition dashboard state into the three IA zones per CTL-107.
 *
 * - `needsMe`  — pre-collected attention items (blocked PRs, failed/stalled
 *                workers, died workers). Sourced from `collectAttention`.
 * - `shipping` — orchestrators the operator should care about now: anything
 *                with an active worker, plus done orchs within the active/time
 *                window.
 * - `recent`   — done orchestrators in the 7-day trailing window that fell
 *                outside the current filter's active cutoff.
 *
 * The split between `shipping` and `recent` is delegated to `filterOrchestrators`
 * so the two zone layouts stay consistent with the existing Show-Recent
 * disclosure semantics.
 */
export function partitionDashboard(
  input: DashboardPartitionInput,
): DashboardPartition {
  const { visible, recent } = filterOrchestrators(
    input.orchestrators,
    input.timeFilter,
  );
  return {
    needsMe: input.attention,
    shipping: visible,
    recent,
  };
}
