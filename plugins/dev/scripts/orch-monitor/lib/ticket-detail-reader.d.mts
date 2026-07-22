// Type declarations for ticket-detail-reader.mjs (CTL-889, P8). Keep in sync
// with the object assembled in the .mjs.

import type { TicketDescriptor } from "../../broker/broker-state.d.mts";

/** One relation graph edge — a typed pointer to another ticket. */
export interface TicketRelationEdge {
  /** Relation type, e.g. "blocks" | "blocked_by" | "related" | "duplicate_of". */
  type: string;
  /** The related ticket identifier (e.g. "CTL-780"). */
  id: string;
}

export interface TicketDetail {
  /** The requested ticket identifier. */
  ticket: string;
  /** Linear workflow state name from the descriptor, or null. */
  linearState: string | null;
  /** 0=no priority, 1=urgent .. 4=low (Linear scale), or null when uncached. */
  priority: number | null;
  /** Assignee UUID from the descriptor, or null. */
  assignee: string | null;
  /** Linear resolution from the descriptor, or null. */
  resolution: string | null;
  /** Descriptor last-updated ISO timestamp, or null. */
  updatedAt: string | null;
  /** Linear narrative body — NOT stored in the durable cache, so always null. */
  description: null;
  /** Component/held labels from the descriptor. */
  labels: string[];
  /**
   * Held classification from the labels. CTL-764 Phase 4 renamed "waiting" →
   * "queued"; the legacy "waiting" label back-compat-maps to "queued", so both
   * appear in the union (mirrors board-data.d.mts BoardTicket.held).
   */
  held: "blocked" | "queued" | "waiting" | null;
  /** Held-since timestamp — no cache column today, so always null (honest). */
  heldSince: null;
  /** Forward + reverse relation graph edges. */
  relations: {
    /** Edges THIS ticket's descriptor declares. */
    forward: TicketRelationEdge[];
    /** Edges OTHER tickets declare pointing at this ticket. */
    reverse: TicketRelationEdge[];
  };
  /** Provenance marker — always "filter-state.db" (never a live Linear hit). */
  source: "filter-state.db";
}

/** Pure assembler: build the detail object from durable descriptors. */
export function buildTicketDetail(
  ticket: string,
  descriptor: TicketDescriptor | null | undefined,
  allDescriptors?: TicketDescriptor[],
): TicketDetail | null;

export interface ReadTicketDetailOptions {
  dbPath?: string;
  descriptorReader?: (
    ticket: string,
  ) => TicketDescriptor | null | Promise<TicketDescriptor | null>;
  allDescriptorsReader?: () =>
    | TicketDescriptor[]
    | Promise<TicketDescriptor[]>;
}

/** Route-facing reader: assemble cache-backed detail, or null (→ 404). */
export function readTicketDetail(
  ticket: string,
  opts?: ReadTicketDetailOptions,
): Promise<TicketDetail | null>;
