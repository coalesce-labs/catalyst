// cluster-capacity.ts — CTL-1092 Phase 3. Pure cluster-wide capacity aggregation
// and host-labeled slot assignment. Consumed by ControlTower + SlotDeck in Phase 4.
// Single-host fleets never reach this code — isClusterMode gates all callers.

import type { BoardWorker } from "../../board/types";
import { assignSlots } from "./queue-model";

export interface ClusterSignalNode {
  host: string;
  status: string;
  maxParallel?: number;
  inFlightCount?: number;
  /** CTL-1581: running/dispatched subset — the slot-OCCUPANCY count. inFlightCount
   *  also counts parked (needs-human) dirs, which hold no slot; consumers prefer
   *  this and fall back to inFlightCount for old-daemon peers. */
  activeCount?: number | null;
  freeSlots?: number;
  tickets?: string[];
}

export interface ClusterSignalLike {
  singleHost: boolean;
  nodes: { host?: string | null; status?: string }[];
}

export interface ClusterCapacity {
  maxParallel: number;
  inFlight: number;
  freeSlots: number;
}

export interface ClusterSlot {
  host: string;
  slotIndex: number;
  occupied: boolean;
  worker?: BoardWorker;
  ticket?: string;
}

/**
 * aggregateClusterCapacity — sum per-node capacity across non-offline nodes.
 */
export function aggregateClusterCapacity(nodes: ClusterSignalNode[]): ClusterCapacity {
  let maxParallel = 0;
  let inFlight = 0;
  let freeSlots = 0;
  for (const n of nodes) {
    if (n.status === "offline") continue;
    // CTL-1581: occupancy (activeCount) over ownership (inFlightCount) — a
    // parked needs-human dir must not count a slot as in use.
    const occ = n.activeCount ?? n.inFlightCount ?? 0;
    maxParallel += n.maxParallel ?? 0;
    inFlight += occ;
    freeSlots += Math.max(0, (n.maxParallel ?? 0) - occ);
  }
  return { maxParallel, inFlight, freeSlots };
}

/**
 * assignClusterSlots — produce an ordered ClusterSlot[] for the whole cluster.
 * Local node: uses assignSlots (rich worker refs). Remote nodes: ticket-id labels
 * from in_flight_tickets. Offline nodes are excluded entirely.
 */
export function assignClusterSlots({
  nodes,
  localHost,
  localWorkers,
}: {
  nodes: ClusterSignalNode[];
  localHost: string;
  localWorkers: readonly BoardWorker[];
}): ClusterSlot[] {
  const slots: ClusterSlot[] = [];
  for (const n of nodes) {
    if (n.status === "offline" || !n.maxParallel) continue;
    if (n.host === localHost) {
      // Rich local slots via existing assignSlots. CTL-1581: over-capacity
      // workers are real processes — surface them as EXTRA occupied slots so
      // the box-derived headline shows the true 5/4 instead of clamping to 4/4.
      const { occupied, emptyCount, overCapacity } = assignSlots(localWorkers, n.maxParallel);
      const localOccupied = [...occupied, ...overCapacity];
      for (let i = 0; i < localOccupied.length; i++) {
        slots.push({ host: n.host, slotIndex: i, occupied: true, worker: localOccupied[i] });
      }
      for (let i = 0; i < emptyCount; i++) {
        slots.push({ host: n.host, slotIndex: localOccupied.length + i, occupied: false });
      }
    } else if (Array.isArray(n.tickets)) {
      // Remote node with KNOWN occupancy labels ([] = known idle). May exceed
      // maxParallel (over-dispatch) — render every real ticket, never clamp.
      const total = Math.max(n.maxParallel, n.tickets.length);
      for (let i = 0; i < total; i++) {
        if (i < n.tickets.length) {
          slots.push({ host: n.host, slotIndex: i, occupied: true, ticket: n.tickets[i] });
        } else {
          slots.push({ host: n.host, slotIndex: i, occupied: false });
        }
      }
    } else {
      // CTL-1581: remote node WITHOUT ticket labels (old daemon / anchor
      // transport) — fall back to the occupancy COUNT so a busy node renders
      // label-less occupied boxes instead of a false all-Open deck.
      const occ = n.activeCount ?? n.inFlightCount ?? 0;
      const total = Math.max(n.maxParallel, occ);
      for (let i = 0; i < total; i++) {
        slots.push({ host: n.host, slotIndex: i, occupied: i < occ });
      }
    }
  }
  return slots;
}

/**
 * filterSlotsByNode — return only slots belonging to the given host.
 */
export function filterSlotsByNode(slots: ClusterSlot[], host: string): ClusterSlot[] {
  return slots.filter((s) => s.host === host);
}

/**
 * nodeCapacity — capacity for a single node by host name.
 */
export function nodeCapacity(nodes: ClusterSignalNode[], host: string): ClusterCapacity {
  const n = nodes.find((node) => node.host === host);
  if (!n || n.status === "offline") return { maxParallel: 0, inFlight: 0, freeSlots: 0 };
  // CTL-1581: occupancy over ownership (same rule as aggregateClusterCapacity).
  const occ = n.activeCount ?? n.inFlightCount ?? 0;
  return {
    maxParallel: n.maxParallel ?? 0,
    inFlight: occ,
    freeSlots: Math.max(0, (n.maxParallel ?? 0) - occ),
  };
}

/**
 * isClusterMode — true only when the roster has >1 host and singleHost is false.
 * Single-host fleets always use the legacy rendering path.
 */
export function isClusterMode(signal: ClusterSignalLike | null | undefined): boolean {
  if (!signal) return false;
  if (signal.singleHost) return false;
  return (signal.nodes?.length ?? 0) > 1;
}
