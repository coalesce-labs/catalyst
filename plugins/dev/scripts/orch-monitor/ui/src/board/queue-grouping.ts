// queue-grouping.ts — the PURE per-node grouping of the waiting queue (SURF2 /
// CTL-910). Pulled out of the QueueSurface view so the node-attribution contract
// is unit-testable without a DOM, matching the surface.ts / board-logic.ts /
// list-order.ts pattern. The view reads `queueHostMode` to decide whether the
// node column/grouping is even shown, and `groupQueueByHost` to render the
// grouped tables.
//
// SINGLE-HOST IDENTITY NO-OP (operator hard-constraint): with hosts.json absent
// or length 1, board-data stamps `host:null` (or a single repeated host) on every
// queue entity, so `queueHostMode` returns "single" and the surface renders
// EXACTLY today's flat ranked table — zero node column, zero added rows, zero
// latency. The N>1 branch (a real node column + group-by-node) only lights up
// when the read-model resolves two or more DISTINCT HRW owner hosts; that branch
// is the same code path, just yielding more than one bucket.
import type { BoardQueueItem, BoardHostRef } from "./types";

/** Whether the waiting table should surface a node column / group affordance. */
export type QueueHostMode = "single" | "multi";

/** Bucket label shown for queue rows the read-model could not attribute to a host
 *  (host:null — un-stamped during a single-node fleet or before a fence claim). */
export const UNATTRIBUTED_HOST_LABEL = "Unassigned";

/** One node's slice of the waiting queue, items kept in global-rank order. */
export interface QueueHostGroup {
  /** The owning node, or null for the un-attributed bucket. */
  host: BoardHostRef | null;
  /** Display label (host name, or UNATTRIBUTED_HOST_LABEL when host is null). */
  label: string;
  /** This node's queued rows, preserving the scheduler's global rank order. */
  items: BoardQueueItem[];
}

/** The stable bucket key for a queue row: the host id, or "" when un-attributed.
 *  Dedup is by id (not display name) so the same node under two names is one
 *  bucket — see groupByHost() in the read-model contract for the same rule. */
function hostKey(item: BoardQueueItem): string {
  return item.host?.id ?? "";
}

/**
 * Detect whether the waiting queue spans more than one DISTINCT owner node.
 *
 * Returns "single" (the identity no-op) when the queue is empty, every row shares
 * one host id, or every row is un-attributed. Returns "multi" only when two or
 * more distinct buckets exist (two named hosts, or a named host alongside
 * un-attributed rows) — i.e. when a node column actually carries information. A
 * "single" result means the surface must add no node column and no visual noise.
 */
export function queueHostMode(queue: readonly BoardQueueItem[]): QueueHostMode {
  const keys = new Set<string>();
  for (const item of queue) {
    keys.add(hostKey(item));
    if (keys.size > 1) return "multi";
  }
  return "single";
}

/**
 * Group the waiting queue by owning node WITHOUT disturbing the scheduler's
 * global rank order.
 *
 * Groups appear in the order their first row is encountered (the queue is already
 * globally ranked, so this is first-by-rank), and each group's items stay in that
 * same ascending-rank order. The un-attributed bucket (host:null) participates
 * like any other node. This is total — every input row lands in exactly one group
 * (no drops, no dups). Single-host input yields exactly one group, so callers can
 * always iterate `groupQueueByHost(...)` whether or not the node column is shown.
 */
export function groupQueueByHost(queue: readonly BoardQueueItem[]): QueueHostGroup[] {
  const byKey = new Map<string, QueueHostGroup>();
  // `groups` preserves first-appearance order; each entry is the SAME object
  // reference stored in `byKey`, so pushing to `group.items` below mutates the
  // array entry too — no second lookup, no non-null assertion.
  const groups: QueueHostGroup[] = [];
  for (const item of queue) {
    const key = hostKey(item);
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const group: QueueHostGroup = {
      host: item.host ?? null,
      label: item.host?.name ?? UNATTRIBUTED_HOST_LABEL,
      items: [item],
    };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}
