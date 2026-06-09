// Type declarations for board-data.mjs (plain-JS data layer for the CTL-727
// Worker/Ticket board). Lets the typechecked TS server (server.ts) and the
// Vite config import assembleBoard() without a TS7016 implicit-any error.
// Keep in sync with the object assembled in board-data.mjs.

export type BoardActiveState = "active" | "stuck" | null;

/** CTL-922 (BFF10): a node's stable identity stamped on every board entity so
 *  the node-aware surfaces can attribute/group by host. `name` is the
 *  configurable host name (CATALYST_HOST_NAME / os.hostname() minus ".local");
 *  `id` is sha256(name)[:16] — identical across the bash/mjs/ts host-identity
 *  primitives. Same shape as the read-model contract's HostRef. */
export interface BoardHostRef {
  name: string;
  id: string;
}

export interface BoardWorker {
  name: string;
  ticket: string;
  tickets: string[];
  phase: string;
  status: string;
  activeState: BoardActiveState;
  working: boolean;
  lastActiveMs: number | null;
  repo: string;
  team: string;
  runtimeMs: number | null;
  costUSD: number | null;
  /** CC-UUID from `claude agents --json .sessionId` (Prometheus/Loki claude-code key). */
  sessionId: string;
  /** CTL-888 (BFF6) P6: exact wall-clock start (epoch ms) for precise elapsed. */
  startedAt: number | null;
  /** CTL-888 (BFF6) P7: OS pid of the bg worker. */
  pid: number | null;
  /** CTL-888 (BFF6) P7: catalyst `sess_…` id (catalyst.session heartbeat key); null when unknown. */
  catalystSessionId: string | null;
  /** CTL-922 (BFF10): the node owning this worker, from the phase signal
   *  host:{name,id} (CTL-852) or the durable fence projection owner_host (BFF11).
   *  null when no host is named (single-host resolves to the one node). */
  host: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation, from the durable fence projection
   *  (BFF11) or the phase signal — the value a fence-aware web mutation passes to
   *  isFenceCurrent without a live attachment fetch. null when no fence. */
  generation: number | null;
}

export interface BoardPhaseCost {
  costUSD: number;
  tokens: number;
  turns: number;
}

export interface BoardPhaseTiming {
  phase: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  /** CTL-888 (BFF6) P5: per-phase model for the spine + gantt; null when absent. */
  model: string | null;
}

export interface BoardCurrentPhase {
  phase: string;
  status: string;
  model: string | null;
  startedAt?: string;
  updatedAt?: string;
}

export interface BoardTicket {
  id: string;
  title: string;
  type: string;
  repo: string;
  team: string;
  phase: string;
  status: string;
  model: string | null;
  linearState: string;
  workerStatus: string | null;
  activeState: BoardActiveState;
  working: boolean;
  lastActiveMs: number | null;
  priority: number;
  estimate: number | null;
  scope: string | null;
  project: string | null;
  costUSD: number | null;
  tokens: number | null;
  turns: number | null;
  phaseCosts: Record<string, BoardPhaseCost> | null;
  phaseSummary: BoardPhaseTiming[];
  pr: number | null;
  updatedAt: string;
  /** CTL-755 held indicator from the ticket's Linear labels. */
  held: "blocked" | "waiting" | null;
  /** Dependency ids a `blocked` hold is waiting on (from triage.json). */
  blockers: string[];
  /** CTL-922 (BFF10): the node owning this ticket, from the phase signals
   *  host:{name,id} (CTL-852) or the durable fence projection owner_host (BFF11).
   *  null when no host is named (single-host resolves to the one node). */
  host: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation, from the durable fence projection
   *  (BFF11) or the phase signal — the value a fence-aware web mutation passes to
   *  isFenceCurrent without a live attachment fetch. null when no fence. */
  generation: number | null;
}

export interface BoardQueueItem {
  id: string;
  title: string;
  priority: number;
  createdAt: string;
  state: string | null;
  repo: string;
  team: string;
  rank: number;
  estimate: number | null;
  scope: string | null;
  project: string | null;
  /** CTL-922 (BFF10): the node owning this queued ticket, from the durable fence
   *  projection owner_host (BFF11); null when no fence attachment observed. */
  host: BoardHostRef | null;
}

export interface BoardConfig {
  maxParallel: number;
  inFlight: number;
  freeSlots: number;
  active: number;
  working: number;
  stuck: number;
}

export interface BoardPayload {
  generatedAt: string;
  config: BoardConfig;
  repos: string[];
  workers: BoardWorker[];
  tickets: BoardTicket[];
  queue: BoardQueueItem[];
}

export const PHASE_ORDER: string[];
export const PHASE_TO_LINEAR: Record<string, string>;
export const TERMINAL: Set<string>;
export const HELD_LABEL_BLOCKED: string;
export const HELD_LABEL_WAITING: string;
export function heldFor(labels: unknown): "blocked" | "waiting" | null;
export function buildPhaseSummary(phaseSigs: unknown[], now: number): BoardPhaseTiming[];
export function deriveCurrentPhase(phaseSigs: unknown[]): BoardCurrentPhase;
/** Build a thin Todo-column BoardTicket from an eligible queue entry (CTL-767). */
export function synthesizeQueuedTicket(
  eligible: unknown,
  linfo: Record<string, unknown>,
): BoardTicket;
export function assembleBoard(): Promise<BoardPayload>;
/** CTL-922 (BFF10): build a {name,id} HostRef from a bare host name (id =
 *  sha256(name)[:16]); null for a null/empty name. */
export function hostRefFromName(name: unknown): BoardHostRef | null;
/** CTL-922 (BFF10): resolve an entity's owning host — phase-signal host:{name,id}
 *  first (CTL-852), else the durable fence projection owner_host (BFF11). */
export function deriveHost(
  phaseSigs: unknown[],
  fence?: { ownerHost?: string | null },
): BoardHostRef | null;
/** CTL-922 (BFF10): resolve an entity's fence generation — durable fence
 *  projection (BFF11) first, else the phase signal generation; null when neither. */
export function deriveGeneration(
  phaseSigs: unknown[],
  fence?: { generation?: number | null },
): number | null;
