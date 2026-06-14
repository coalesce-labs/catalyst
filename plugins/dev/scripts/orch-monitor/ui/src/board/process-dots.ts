// process-dots.ts — CTL-1101 Phase 5. Pure dot-placement helper for the process
// canvas live-presence overlay. No @xyflow/react, no DOM. BoardTicket is
// structurally assignable to DotTicket (no cast needed at call-sites).
import { C, LIVE } from "./board-tokens";

export const MAX_VISIBLE_DOTS = 5;

export interface DotTicket {
  id: string;
  phase: string;
  status: string;
  activeState: "active" | "stuck" | "dead" | null;
  working?: boolean;
}

export interface DotEntry {
  id: string;
  color: string;
}

export interface PhaseDotGroup {
  phase: string;
  dots: DotEntry[];
  overflow: number;
  total: number;
}

const TERMINAL = new Set([
  "done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled",
]);

function dotColor(ticket: DotTicket): string {
  if (ticket.activeState === "active") return LIVE;
  if (ticket.activeState === "stuck" || ticket.status === "failed") return C.red;
  return C.fgDim;
}

/** Group in-flight tickets by phase node, collapsing >MAX_VISIBLE_DOTS to overflow. */
export function buildPhaseDots(tickets: DotTicket[], nodeIds: Set<string>): PhaseDotGroup[] {
  // Bucket in-flight tickets (non-terminal status) by phase, drop phases not in nodeIds.
  const buckets = new Map<string, DotTicket[]>();
  for (const ticket of tickets) {
    if (TERMINAL.has(ticket.status)) continue;
    if (!nodeIds.has(ticket.phase)) continue;
    const existing = buckets.get(ticket.phase);
    if (existing) {
      existing.push(ticket);
    } else {
      buckets.set(ticket.phase, [ticket]);
    }
  }

  // Iterate nodeIds for deterministic group order.
  const groups: PhaseDotGroup[] = [];
  for (const nodeId of nodeIds) {
    const bucket = buckets.get(nodeId);
    if (!bucket || bucket.length === 0) continue;
    // Sort by ticket id for stable ordering.
    const sorted = bucket.slice().sort((a, b) => a.id.localeCompare(b.id));
    const total = sorted.length;
    const visible = sorted.slice(0, MAX_VISIBLE_DOTS);
    const overflow = Math.max(0, total - MAX_VISIBLE_DOTS);
    groups.push({
      phase: nodeId,
      dots: visible.map((ticket) => ({ id: ticket.id, color: dotColor(ticket) })),
      overflow,
      total,
    });
  }
  return groups;
}
