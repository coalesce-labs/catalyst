// list-group-data.ts — PURE (React-/jotai-/DOM-free) default-grouping engine for
// the CTL-955 TanStack Data Table rebuild of BoardList. Encodes the two default
// grouping rules:
//
//   kind="ticket" + swimlane="none"  → group by pipeline STAGE (the column key the
//     row was resolved from — i.e. `ListRow.col`, which is the LinearState or phase
//     column label depending on the lens). Column order from LINEAR_COLUMNS /
//     PHASE_COLUMNS so the table groups appear top-to-bottom in pipeline order.
//
//   kind="worker" + swimlane="none"  → group by activity STATUS (the
//     `workerActivityGroup(w)` bucket: active → waiting-on-user → waiting → stuck →
//     blocked). Group order mirrors WORKER_GROUP_RANK ascending.
//
//   swimlane !== "none" (any axis)   → the BOARD3 swimlane engine takes over:
//     `groupListRows` already handles this — the caller maps swimlane lanes to
//     TanStack groups. This module only encodes the *default* (no swimlane) path.
//
// UNIT-TESTED under `bun test` (list-group-data.test.ts). PURE — no imports of
// React, jotai, or DOM types.

import type { BoardTicket, BoardWorker } from "./types";
import type { ListRow } from "./list-data";
import type { ListLens } from "./list-order";
import { workerActivityGroup, type WorkerActivityGroup } from "./list-order";
import { LINEAR_COLUMNS, PHASE_COLUMNS } from "./board-display";

// ── ticket default grouping: by pipeline stage ───────────────────────────────

/** A resolved stage group for the ticket default grouping. The `key` is the
 *  column key (e.g. "Implement" for linear, "implement" for phase); `label` is
 *  the human label (e.g. "Implement"); `color` is the board accent; `order` is
 *  the 0-based position in the pipeline column set (for stable sorting). */
export interface StageGroup {
  key: string;
  label: string;
  color: string;
  order: number;
  live: "live" | "degraded" | "offline" | null;
  items: ListRow<BoardTicket>[];
}

/**
 * Group a flat ticket row stream by pipeline stage — the column key that
 * `flattenTicketRows` stamped on each row as `row.col`. Groups appear in
 * PIPELINE order (LINEAR_COLUMNS or PHASE_COLUMNS index), so the table renders
 * Todo → Triage → Research → Plan → Implement → Validate → PR → Done (linear)
 * or triage → research → plan → implement → verify → review → pr → … (phase).
 * Empty groups are OMITTED (no columns for non-existent items).
 *
 * PURE — never mutates `rows`.
 */
export function groupTicketsByStage(
  rows: ListRow<BoardTicket>[],
  lens: ListLens,
): StageGroup[] {
  const defs = lens === "linear" ? LINEAR_COLUMNS : PHASE_COLUMNS;
  // Build an index from column key → (label, color, 0-based order in pipeline).
  const defIdx = new Map(defs.map((d, i) => [d.key, { label: d.label, c: d.c, order: i }]));

  // Collect rows into buckets keyed by col.
  const byKey = new Map<string, ListRow<BoardTicket>[]>();
  for (const row of rows) {
    const bucket = byKey.get(row.col);
    if (bucket) bucket.push(row);
    else byKey.set(row.col, [row]);
  }

  // Build the group list, ordered by pipeline index.
  const groups: StageGroup[] = [];
  for (const [key, items] of byKey) {
    const def = defIdx.get(key) ?? { label: key, c: "#94a3b8", order: defs.length };
    const live =
      items.some((r) => r.entity.activeState === "active")
        ? ("live" as const)
        : null;
    groups.push({ key, label: def.label, color: def.c, order: def.order, live, items });
  }
  groups.sort((a, b) => a.order - b.order);
  return groups;
}

// ── worker default grouping: by activity status ──────────────────────────────

/** A resolved activity group for the worker default grouping. */
export interface ActivityGroup {
  key: WorkerActivityGroup;
  label: string;
  rank: number;
  live: "live" | "degraded" | "offline" | null;
  items: ListRow<BoardWorker>[];
}

const WORKER_GROUP_META: Record<WorkerActivityGroup, { label: string; rank: number }> = {
  active: { label: "Active", rank: 0 },
  "waiting-on-user": { label: "Waiting on user", rank: 1 },
  waiting: { label: "Waiting", rank: 2 },
  stuck: { label: "Stuck", rank: 3 },
  blocked: { label: "Blocked", rank: 4 },
};

/**
 * Group a flat worker row stream by activity status bucket (active →
 * waiting-on-user → waiting → stuck → blocked). Empty groups omitted.
 * PURE — never mutates `rows`.
 */
export function groupWorkersByActivity(
  rows: ListRow<BoardWorker>[],
): ActivityGroup[] {
  const byKey = new Map<WorkerActivityGroup, ListRow<BoardWorker>[]>();
  for (const row of rows) {
    const g = workerActivityGroup(row.entity);
    const bucket = byKey.get(g);
    if (bucket) bucket.push(row);
    else byKey.set(g, [row]);
  }

  const groups: ActivityGroup[] = [];
  for (const [key, items] of byKey) {
    const meta = WORKER_GROUP_META[key];
    const live: "live" | null =
      items.some((r) => r.entity.activeState === "active") ? "live" : null;
    groups.push({ key, label: meta.label, rank: meta.rank, live, items });
  }
  groups.sort((a, b) => a.rank - b.rank);
  return groups;
}

// ── unified group row shape (used by the TanStack table model) ───────────────

/** A group header descriptor — shape shared by stage + activity groups and the
 *  swimlane lanes so the GroupHeaderRow component is generic. */
export interface ListGroupHeader {
  key: string;
  label: string;
  count: number;
  /** accent color (stage only; null for activity/swimlane groups). */
  color: string | null;
  live: "live" | "degraded" | "offline" | null;
}

/** Extract a ListGroupHeader from a StageGroup. */
export function stageGroupHeader(g: StageGroup): ListGroupHeader {
  return { key: g.key, label: g.label, count: g.items.length, color: g.color, live: g.live };
}

/** Extract a ListGroupHeader from an ActivityGroup. */
export function activityGroupHeader(g: ActivityGroup): ListGroupHeader {
  return { key: g.key, label: g.label, count: g.items.length, color: null, live: g.live };
}
