// Shared board types — hoisted out of Board.tsx (CTL-733 PR-2b) so the React
// view, the SharedWorker, and the transport client all agree on ONE shape.
// Mirrors the server's declared payload in lib/board-data.d.mts (intentionally a
// UI subset: BoardQueueItem.state is omitted because the board never renders it).
//
// CTL-919 / HUD1: this UI subset is now bound to the ONE shared read-model client
// contract (lib/read-model-client.ts) via the compile-time `ContractPayloadFitsUiView`
// fixture below. That contract is the SAME module the terminal HUD imports, so a
// change to the read-model's wire shape is a typecheck break felt on BOTH
// surfaces — the web client can no longer silently render a mismatched shape.
import type { ConnectionStatus } from "@/lib/types";
import type { ReadModelPayload } from "../../../lib/read-model-client";

// CTL-928: "dead" — a worker whose durable bg-job state.json is terminal
// (stopped/failed/done/blocked) or whose job dir is gone, even when a phase signal
// still says `running`. Excluded from in-flight + consumed capacity by the server;
// the board renders it as a distinct dead/zombie state, not "active".
export type BoardActiveState = "active" | "stuck" | "dead" | null;

// CTL-729: the single "needs attention" bucket (operator-approved 2026-06-11) —
// the ONE yellow board accent + Inbox "Needs you" reason. 'waiting-on-you' (a live
// worker's bg job is blocked, paused for a human prompt) | 'needs-human' (a
// watchdog/phase escalation via a needs-human/needs-input label or the host-local
// marker) | null. needs-human wins. DISTINCT from `held` (admission-gate pair).
export type BoardAttention = "waiting-on-you" | "needs-human" | null;

/** CTL-922 (BFF10): a node's stable identity stamped on every board entity so the
 *  node-aware surfaces (BOARD3 host swimlanes, SURF1 worker node group, SURF2
 *  queue node column) can attribute/group by host. Mirrors the server's
 *  BoardHostRef (lib/board-data.d.mts) and the read-model contract's HostRef. */
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
  /** CC-UUID from `claude agents --json .sessionId` — keys the Prometheus
   *  `claude_code_*` series and the Loki `claude-code` stream. */
  sessionId?: string;
  /** CTL-888 (BFF6) P6: exact wall-clock start (epoch ms), for precise elapsed. */
  startedAt?: number | null;
  /** CTL-888 (BFF6) P7: OS pid of the bg worker — drives the worker-rail PID row. */
  pid?: number | null;
  /** CTL-888 (BFF6) P7: catalyst `sess_…` id (the second id space) — keys the
   *  Loki `catalyst.session` heartbeat / `catalyst.phase-agent` lifecycle
   *  streams. null when catalyst.db has no row for this CC-UUID. */
  catalystSessionId?: string | null;
  /** CTL-922 (BFF10): the node owning this worker (SURF1 node group/filter),
   *  from the phase signal host:{name,id} (CTL-852) or the durable fence
   *  projection owner_host (BFF11). null when no host is named. */
  host?: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation (BFF8 stop passes it to the
   *  fence-check). null when no fence. */
  generation?: number | null;
  /** CTL-928: the durable `claude --bg` job id this worker's liveness was derived
   *  from. null/absent when no signal carried one. */
  bgJobId?: string | null;
  /** CTL-947: true when the worker is parked waiting for a human prompt —
   *  derived from the durable bg-job state "blocked" (Claude Code paused for
   *  user input / a permission grant). false/absent when not waiting. */
  waitingOnUser?: boolean;
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
  /** CTL-888 (BFF6) P5: per-phase model (◆sonnet/◆opus) for the spine + gantt.
   *  null when the phase signal carried no model. */
  model: string | null;
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
  /** CTL-954: estimation method (fibonacci/tShirt/exponential/linear); null when absent. */
  estimateMethod?: string | null;
  /** CTL-957: method-aware display string (e.g. "M" for tShirt 2, "5" for fibonacci 5); null when absent. */
  estimateDisplay?: string | null;
  scope: string | null;
  project: string | null;
  costUSD: number | null;
  tokens: number | null;
  turns: number | null;
  phaseCosts: Record<string, BoardPhaseCost> | null;
  phaseSummary: BoardPhaseTiming[];
  pr: number | null;
  updatedAt: string;
  subSteps?: WorkflowSubStep[];
  /** CTL-755 held indicator from the ticket's Linear labels: the admission gate
   *  holds a triaged-waiting ticket before the triage→research promotion. */
  held?: "blocked" | "waiting" | null;
  /** Dependency ids a `blocked` hold is waiting on (only meaningful when held === "blocked"). */
  blockers?: string[];
  /** CTL-901 (HOME3): ISO applied-at of the held labels (durable ticket_state
   *  held_since, projected by the broker — BFF11). The honest "how long has it
   *  been waiting on you" anchor; null when no durable stamp exists (rendered
   *  unavailable, never fabricated). Only meaningful while held is set. */
  heldSince?: string | null;
  /** CTL-901 (HOME3): ISO start of the ticket's CURRENT phase — the "how long
   *  has it been running / in its current state" anchor for the running set.
   *  null when the surfaced phase carried no startedAt. */
  currentPhaseSince?: string | null;
  /** CTL-729: the single needs-attention bucket — 'waiting-on-you' (live worker's
   *  bg job blocked, paused for a human prompt) | 'needs-human' (a watchdog/phase
   *  escalation via a needs-human/needs-input label or the host-local marker) |
   *  null. needs-human wins. Drives the ONE yellow board accent + the Inbox
   *  "Needs you" section. DISTINCT from `held` (the admission-gate pair). */
  attention?: BoardAttention;
  /** CTL-729: ISO timestamp the attention started — the worker's current-phase
   *  start for waiting-on-you; null for needs-human. The Inbox row anchors its
   *  duration to attentionSince ?? heldSince; null is rendered unavailable. */
  attentionSince?: string | null;
  /** CTL-922 (BFF10): the node owning this ticket (BOARD3 host swimlanes), from
   *  the phase signals host:{name,id} (CTL-852) or the durable fence projection
   *  owner_host (BFF11). null when no host is named. */
  host?: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation (HOME5 unblock passes it to the
   *  fence-check). null when no fence. */
  generation?: number | null;
  /** CTL-1066: reason a stalled/failed phase gave up; drives the "Stalled — gave
   *  up" holding bucket copy. null/absent unless status is stalled/failed. */
  failureReason?: string | null;
  // ── CTL-902 (HOME4): the reading-pane CONTENT fields ─────────────────────
  // The "What's needed now" hero + the About block read these. They are NOT in
  // the board payload today — they derive from the ticket's AI summary + the
  // decision context and must be served per-item by the BFF inbox endpoint
  // (NEEDS-PLUMBING there, a separate ticket). Every field is OPTIONAL: the pane
  // renders any field the read-model omits as ABSENT, never fabricated.
  /** One-line plain-language summary of the ticket (the About block's lead). */
  summary?: string | null;
  /** What the ticket is trying to achieve (the About block's goal line). */
  goal?: string | null;
  /** The full ask in plain language — the hero "What's needed now" block. Only
   *  meaningful for a needs-you (blocked/waiting) item. */
  ask?: string | null;
  /** The decision options for a `waiting` item — each a label + a one-line
   *  trade-off detail. Empty/absent for non-decision items. */
  options?: DecisionOption[] | null;
  /** The blocker description for a `blocked` item — plain language, shown in the
   *  hero instead of decision options. */
  blocker?: string | null;
}

/** CTL-902 (HOME4): one decision option in the reading-pane hero — a short label
 *  plus a one-line trade-off detail. Served by the BFF inbox endpoint per item;
 *  rendered flat (a labelled line), never as a nested card. */
export interface DecisionOption {
  /** The option label (e.g. "Path A" / "Rebase onto main"). */
  label: string;
  /** The one-line trade-off for choosing this option. */
  detail: string;
}

export interface WorkflowSubStep {
  ts: string;
  workflowName: string;
  stepLabel: string;
  stepIndex: number;
  status: "started" | "complete" | "failed";
}

export interface BoardQueueItem {
  id: string;
  title: string;
  priority: number;
  createdAt: string;
  repo: string;
  team: string;
  rank: number;
  estimate: number | null;
  /** CTL-954: estimation method (fibonacci/tShirt/exponential/linear); null when absent. */
  estimateMethod?: string | null;
  /** CTL-957: method-aware display string (e.g. "M" for tShirt 2, "5" for fibonacci 5); null when absent. */
  estimateDisplay?: string | null;
  scope: string | null;
  project: string | null;
  /** CTL-922 (BFF10): the node owning this queued ticket (SURF2 queue node
   *  column), from the durable fence projection owner_host (BFF11). null when
   *  no fence attachment has been observed. */
  host?: BoardHostRef | null;
  /** CTL-1066: active dispatch retry cool-down; drives the "retrying in …" chip.
   *  null when not cooling down. expiresAt is epoch ms; consecutiveFailures is the attempt count. */
  dispatchCooldown?: { expiresAt: number; consecutiveFailures: number } | null;
}

export interface BoardConfig {
  maxParallel: number;
  inFlight: number;
  freeSlots: number;
  active: number;
  working: number;
  stuck: number;
  /** CTL-928: dead bg-job workers still listed by `claude agents` but excluded
   *  from inFlight/freeSlots. Optional so existing config fixtures stay valid. */
  dead?: number;
}

/** CTL-1050 §3.2: one current service outage decorated onto the board payload —
 *  the inbox awareness item renders from these (state-derived, `down` only). */
export interface BoardServiceOutage {
  id: string;
  label: string;
  downSince: number | null;
  detail: string | null;
}

export interface BoardServiceHealth {
  generatedAt: number;
  outages: BoardServiceOutage[];
}

export interface BoardPayload {
  generatedAt: string;
  config: BoardConfig;
  repos: string[];
  workers: BoardWorker[];
  tickets: BoardTicket[];
  queue: BoardQueueItem[];
  /** CTL-1050: server-decorated current service outages (down only). */
  serviceHealth?: BoardServiceHealth;
}

// ── SharedWorker ⇄ client message protocol (CTL-733 PR-2b) ──────────────────
// One source of truth for the postMessage contract: because both board-worker.ts
// and board-client.ts import these, any drift between the two sides is a compile
// error rather than a silent runtime mismatch.

/** Messages the worker/leader pushes out to every connected port. */
export type BoardOutbound =
  | { kind: "snapshot"; payload: BoardPayload }
  | { kind: "status"; status: ConnectionStatus };

/** Messages a port sends back to the worker. `bye` lets the worker prune a port
 *  deterministically on tab/effect teardown — a closed MessagePort fires no event
 *  and postMessage to it is a silent no-op, so without this the worker can only
 *  learn a port is dead on a (never-arriving) failed send. */
export type BoardInbound = { kind: "reconcile" } | { kind: "bye" };

export type { ConnectionStatus };

// ── CTL-919 / HUD1: contract conformance bridge ─────────────────────────────
// The web client renders this `BoardPayload` UI subset; the server fans out the
// fuller `ReadModelPayload` (the contract's wire shape) over SSE. This fixture
// asserts the server contract payload is structurally assignable to the UI view
// — i.e. the UI never reads a field the contract doesn't promise. It is a pure
// COMPILE-TIME check (no runtime cost): if the read-model wire shape drops or
// renames a field the board relies on, this stops compiling here AND in the HUD,
// because both import the SAME `read-model-client` contract.
type AssertAssignable<From, To> = From extends To ? true : never;
// Compile-time contract assertion: `true` when the server payload fits the UI view;
// collapses to `never` (typecheck break) on a non-conforming change.
type ContractPayloadFitsUiView = AssertAssignable<ReadModelPayload, BoardPayload>;
