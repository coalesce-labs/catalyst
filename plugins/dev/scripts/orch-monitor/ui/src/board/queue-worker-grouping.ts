// queue-worker-grouping.ts — PURE, DOM-free grouping of the in-flight worker
// list by activity state (CTL-947). Extracted from the QueueView render so the
// grouping contract is unit-testable under `bun test` without a DOM, matching
// the queue-grouping.ts / worker-grouping.ts / board-grouping.ts pattern.
//
// The five groups, in display order:
//   active          — worker is in-loop, generating (activeState === "active")
//   waiting-on-user — worker is parked for a human prompt (waitingOnUser === true)
//   waiting         — worker is idle / between-phases (activeState === null)
//   stuck           — worker is stale / terminal-marker (activeState === "stuck")
//   blocked         — ticket hold held === "blocked" with blockers[] — ALWAYS LAST
//
// Within each group workers keep the existing priority rank (sortWorkers order:
// longest runtimeMs first within a group). The BLOCKED group always renders last
// regardless of runtimeMs so the operator can always find it at the bottom.
//
// The grouper is ticket-aware ONLY through the injected `ticketHeld` lookup
// (a plain Record<ticketId, "blocked"|"waiting"|null>) so it remains React-free.
import type { BoardWorker } from "./types";
import {
  rankWorker,
  workerActivityGroup,
  type WorkerActivityGroup,
} from "./list-order";

/** Human-readable label for each activity group, used as the section header. */
export const WORKER_GROUP_LABEL: Record<WorkerActivityGroup, string> = {
  active: "Active",
  "waiting-on-user": "Waiting on you",
  waiting: "Waiting",
  stuck: "Stuck",
  blocked: "Blocked",
};

/** One activity-state section of the in-flight worker list. */
export interface WorkerActivitySection {
  /** The activity group key. */
  group: WorkerActivityGroup;
  /** Human-readable section header label. */
  label: string;
  /** Workers in this section, in sortWorkers order within the group. */
  workers: BoardWorker[];
}

/**
 * Group the in-flight worker list by activity state, yielding one section per
 * non-empty group in display order. Empty groups are omitted (no ghost headers).
 *
 * `ticketHeld` maps ticket ids to their `held` field — pass the result of
 * `Object.fromEntries(tickets.map(t => [t.id, t.held]))` or an empty object
 * when ticket data is unavailable.
 *
 * Workers within each section are ordered by `runtimeMs` descending
 * (longest-running first), which is the existing `sortWorkers` tie-break.
 *
 * The BLOCKED group is ALWAYS last (rank 4) — even if no other groups exist.
 * Within each group the existing priority rank (`rankWorker` without a held
 * override, i.e. just activeState/waitingOnUser) is used for tie-breaking.
 */
export function groupWorkersByActivity(
  workers: readonly BoardWorker[],
  ticketHeld: Record<string, "blocked" | "waiting" | null | undefined>,
): WorkerActivitySection[] {
  // Sort first: rank including ticket-held so blocked sinks to bottom; ties
  // broken by runtimeMs descending (longest-running first, matching sortWorkers).
  const sorted = [...workers].sort((a, b) => {
    const ra = rankWorker(a, ticketHeld[a.ticket] ?? null);
    const rb = rankWorker(b, ticketHeld[b.ticket] ?? null);
    return ra - rb || (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0);
  });

  // Bucket into sections preserving the sorted order (first-appearance order =
  // the group rank order already enforced by the sort above).
  const byGroup = new Map<WorkerActivityGroup, BoardWorker[]>();
  for (const w of sorted) {
    const g = workerActivityGroup(w, ticketHeld[w.ticket] ?? null);
    const bucket = byGroup.get(g);
    if (bucket) bucket.push(w);
    else byGroup.set(g, [w]);
  }

  // Emit sections in insertion order (which mirrors the rank sort above).
  return [...byGroup.entries()].map(([group, ws]) => ({
    group,
    label: WORKER_GROUP_LABEL[group],
    workers: ws,
  }));
}
