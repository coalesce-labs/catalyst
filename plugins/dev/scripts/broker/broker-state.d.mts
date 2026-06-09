// Type declarations for broker-state.mjs — the ticket_state / descriptor read
// boundary the orch-monitor read-model consumes (CTL-883). Declares the DB
// lifecycle + the ticket-descriptor surface; the broker's own runtime is plain
// .mjs (no tsconfig), so this file exists purely so typechecked TS consumers
// (the read-model + its tests) can import these without a TS7016 implicit-any.
// Keep in sync with broker-state.mjs as that surface grows.

/** Open (or reuse) the shared filter-state.db handle. */
export function openBrokerStateDb(dbPath?: string): unknown;
/** Close the shared handle (next open reconnects). */
export function closeBrokerStateDb(): void;

export interface TicketDescriptor {
  ticket: string;
  state: string | null;
  prNumber: number | null;
  relations: unknown;
  labels: string[] | null;
  priority: number | null;
  resolution: string | null;
  assignee: string | null;
  uuid: string | null;
  removed: boolean;
  removedAt: string | null;
  updatedAt: string;
}

export interface UpsertTicketDescriptorInput {
  ticket: string;
  state?: string | null;
  prNumber?: number | null;
  relations?: unknown;
  labels?: string[] | null;
  priority?: number | null;
  resolution?: string | null;
  assignee?: string | null;
  uuid?: string | null;
  removed?: boolean;
}

/** Key-presence upsert of a ticket_state descriptor (absent field = keep,
 *  explicit null = clear). */
export function upsertTicketDescriptor(input: UpsertTicketDescriptorInput): void;

/** Read one descriptor by identifier, or null. */
export function getTicketDescriptor(ticket: string): TicketDescriptor | null;

/** Bulk read of every ticket_state descriptor in one query (CTL-883). Removed
 *  rows are excluded unless `includeRemoved` is set. */
export function getAllTicketDescriptors(opts?: {
  includeRemoved?: boolean;
}): TicketDescriptor[];

/** Resolve a descriptor by its Linear entityId UUID, or null. */
export function getTicketDescriptorByUuid(uuid: string): TicketDescriptor | null;

/** Stamp a descriptor removed by UUID; returns the resolved identifier or null. */
export function markTicketRemovedByUuid(uuid: string): { ticket: string } | null;
