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
    maxParallel += n.maxParallel ?? 0;
    inFlight += n.inFlightCount ?? 0;
    freeSlots += n.freeSlots ?? 0;
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
      // Rich local slots via existing assignSlots
      const { occupied, emptyCount } = assignSlots(localWorkers, n.maxParallel);
      for (let i = 0; i < occupied.length; i++) {
        slots.push({ host: n.host, slotIndex: i, occupied: true, worker: occupied[i] });
      }
      for (let i = 0; i < emptyCount; i++) {
        slots.push({ host: n.host, slotIndex: occupied.length + i, occupied: false });
      }
    } else {
      // Remote node: ticket labels from in_flight_tickets
      const remoteTickets = n.tickets ?? [];
      for (let i = 0; i < n.maxParallel; i++) {
        if (i < remoteTickets.length) {
          slots.push({ host: n.host, slotIndex: i, occupied: true, ticket: remoteTickets[i] });
        } else {
          slots.push({ host: n.host, slotIndex: i, occupied: false });
        }
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
  return {
    maxParallel: n.maxParallel ?? 0,
    inFlight: n.inFlightCount ?? 0,
    freeSlots: n.freeSlots ?? 0,
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
