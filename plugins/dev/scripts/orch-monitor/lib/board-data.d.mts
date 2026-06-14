// Type declarations for board-data.mjs (plain-JS data layer for the CTL-727
// Worker/Ticket board). Lets the typechecked TS server (server.ts) and the
// Vite config import assembleBoard() without a TS7016 implicit-any error.
// Keep in sync with the object assembled in board-data.mjs.

// CTL-928: "dead" joins the liveness states — a worker whose DURABLE bg-job state
// (~/.claude/jobs/<id>/state.json) is terminal (stopped/failed/done/blocked) or
// whose job dir is gone, regardless of a phase signal still saying `running`. A
// dead worker is excluded from in-flight + consumed capacity.
export type BoardActiveState = "active" | "stuck" | "dead" | null;

// CTL-729: the single "needs attention" bucket (operator-approved 2026-06-11) —
// the ONE yellow board accent + Inbox "Needs you" reason. 'waiting-on-you' (a live
// worker's bg job is blocked, paused for a human prompt) | 'needs-human' (a
// watchdog/phase escalation via a needs-human/needs-input label or the host-local
// marker) | null. needs-human wins over waiting-on-you. DISTINCT from `held` (the
// admission-gate blocked/waiting pair).
export type BoardAttention = "waiting-on-you" | "needs-human" | null;

/** CTL-1158: GitHub PR merge state from the PrStatusFetcher cache. */
export type PrMergeStateStatus =
  | "CLEAN" | "BLOCKED" | "DIRTY" | "BEHIND" | "UNSTABLE" | "HAS_HOOKS" | "UNKNOWN";

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
  /** CTL-928: the durable `claude --bg` job id this worker's liveness was derived
   *  from (read off the phase signal). null when no signal carried one. Optional so
   *  existing BoardWorker fixtures stay valid; the runtime always populates it. */
  bgJobId?: string | null;
  /** CTL-922 (BFF10): the node owning this worker, from the phase signal
   *  host:{name,id} (CTL-852) or the durable fence projection owner_host (BFF11).
   *  null when no host is named (single-host resolves to the one node). */
  host: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation, from the durable fence projection
   *  (BFF11) or the phase signal — the value a fence-aware web mutation passes to
   *  isFenceCurrent without a live attachment fetch. null when no fence. */
  generation: number | null;
  /** CTL-947: true when the worker is parked waiting for a human prompt —
   *  derived from the durable bg-job state "blocked" (the Claude Code signal
   *  that the job needs user input / a permission grant). false otherwise.
   *  Optional so existing BoardWorker fixtures stay valid without back-fill. */
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
  /** CTL-954: estimation method from triage.json (fibonacci/tShirt/exponential/linear); null when absent. */
  estimateMethod?: string | null;
  /** CTL-954: human-readable estimate (e.g. "M" for tShirt 2, "5" for fibonacci 5); null when estimate is null. */
  estimateDisplay?: string | null;
  scope: string | null;
  project: string | null;
  costUSD: number | null;
  tokens: number | null;
  turns: number | null;
  phaseCosts: Record<string, BoardPhaseCost> | null;
  phaseSummary: BoardPhaseTiming[];
  pr: number | null;
  /** CTL-1158: the PR's GitHub merge state (from the PrStatusFetcher cache);
   *  null when no PR / no cache entry. */
  mergeStateStatus?: PrMergeStateStatus | null;
  /** CTL-1158: the operator CTA when the PR has been DIRTY/BLOCKED/UNSTABLE
   *  ≥ 300 s; null otherwise. Mirrored into humanQuestion as the inbox sub-label. */
  prStuckReason?: string | null;
  updatedAt: string;
  /** CTL-755 held indicator from the ticket's Linear labels. */
  held: "blocked" | "waiting" | null;
  /** Dependency ids a `blocked` hold is waiting on (from triage.json). */
  blockers: string[];
  /** CTL-901 (HOME3): ISO applied-at of the held (blocked/waiting) labels, from
   *  the durable ticket_state.held_since the broker projects (BFF11 / CTL-923).
   *  The honest "how long has it been waiting on you" anchor; null when the
   *  durable cache has no stamp (rendered unavailable, never fabricated). Only
   *  meaningful while `held` is set. */
  heldSince: string | null;
  /** CTL-901 (HOME3): ISO wall-clock start of the ticket's CURRENT phase
   *  (deriveCurrentPhase's startedAt) — the "how long has it been running / in
   *  its current state" anchor for the running set. null when the surfaced phase
   *  carried no startedAt. */
  currentPhaseSince: string | null;
  /** CTL-729: the single needs-attention bucket — 'waiting-on-you' (live worker's
   *  bg job blocked, paused for a human prompt) | 'needs-human' (a watchdog/phase
   *  escalation via a needs-human/needs-input label or the host-local marker) |
   *  null. needs-human wins. Drives the ONE yellow board accent + Inbox "Needs
   *  you" section. DISTINCT from `held` (the admission-gate pair). */
  attention: BoardAttention;
  /** CTL-729: ISO timestamp the attention started — the worker's current-phase
   *  start for waiting-on-you; null for needs-human (no durable label-applied
   *  stamp is projected). The Inbox row anchors its duration to attentionSince ??
   *  heldSince; null is rendered unavailable, never fabricated. */
  attentionSince: string | null;
  /** CTL-922 (BFF10): the node owning this ticket, from the phase signals
   *  host:{name,id} (CTL-852) or the durable fence projection owner_host (BFF11).
   *  null when no host is named (single-host resolves to the one node). */
  host: BoardHostRef | null;
  /** CTL-922 (BFF10): the fence generation, from the durable fence projection
   *  (BFF11) or the phase signal — the value a fence-aware web mutation passes to
   *  isFenceCurrent without a live attachment fetch. null when no fence. */
  generation: number | null;
  /** CTL-1066: reason a stalled/failed phase gave up, from the surfaced phase
   *  signal's stalledReason/failureReason. null unless status is stalled/failed. */
  failureReason?: string | null;
  /** CTL-1110: extended escalation explanation for the needs-human detail-pane
   *  card. null/absent unless attention is needs-human and a signal carried the
   *  extended fields. */
  explanation?: BoardEscalationExplanation | null;
}

/** CTL-1110: the six extended escalation-explanation fields, surfaced as a nested
 *  object for the detail pane's CTA-led card. Each field is null when the signal
 *  omitted it (rendered absent, never fabricated). */
export interface BoardEscalationExplanation {
  call_to_action: string | null;
  outcome: string | null;
  problem: string | null;
  why_you: string | null;
  why_not_auto: string | null;
  what_to_do: string | null;
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
  /** CTL-954: estimation method from triage.json; null when absent. */
  estimateMethod?: string | null;
  /** CTL-954: human-readable estimate display; null when estimate is null. */
  estimateDisplay?: string | null;
  scope: string | null;
  project: string | null;
  /** CTL-922 (BFF10): the node owning this queued ticket, from the durable fence
   *  projection owner_host (BFF11); null when no fence attachment observed. */
  host: BoardHostRef | null;
  /** CTL-1066: active dispatch retry cool-down for this queued ticket; null when
   *  not cooling down. expiresAt is epoch ms; consecutiveFailures is the attempt count. */
  dispatchCooldown?: { expiresAt: number; consecutiveFailures: number } | null;
}

export interface BoardConfig {
  maxParallel: number;
  /** CTL-928: LIVE in-flight workers (dead bg-jobs excluded). */
  inFlight: number;
  /** CTL-928: maxParallel − live inFlight — true free capacity (dead workers no
   *  longer suppress it). */
  freeSlots: number;
  active: number;
  working: number;
  stuck: number;
  /** CTL-928: workers whose durable bg-job is dead (terminal state.json or gone
   *  job dir) yet still listed by `claude agents`. Surfaced so the operator sees
   *  the corpses; they do NOT consume capacity (excluded from inFlight/freeSlots).
   *  Optional so existing BoardConfig fixtures stay valid; the runtime always
   *  populates it via deriveCapacity. */
  dead?: number;
}

/** CTL-1050 §3.2: one current service outage, decorated onto the board payload
 *  for the inbox awareness item. State-derived (current `down` entries only). */
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
  /** CTL-1050: server-decorated current service outages (down only). Absent when
   *  the registry has not resolved any down entry. */
  serviceHealth?: BoardServiceHealth;
}

export const PHASE_ORDER: string[];
/** CTL-972: the ancillary remediate phase — not in PHASE_ORDER (cycles with
 *  verify), but a real phase-agent type. Used by derivePhaseWithRemediate to
 *  unify ticket.phase with the worker/queue's phase-agent-type value. */
export const REMEDIATE_PHASE: string;
export const PHASE_TO_LINEAR: Record<string, string>;
export const TERMINAL: Set<string>;
/** CTL-928: the `claude --bg` job-lifecycle terminal `state` values (distinct from
 *  the worker-signal TERMINAL set). In lock-step with recovery.mjs. */
export const TERMINAL_JOB_STATES: Set<string>;
/** CTL-928: the synthetic current-phase that marks a genuinely pipeline-done
 *  ticket (deriveCurrentPhase collapses terminal monitor-deploy/teardown to it). */
export const PIPELINE_DONE_PHASE: string;
export const HELD_LABEL_BLOCKED: string;
export const HELD_LABEL_WAITING: string;
export function heldFor(labels: unknown): "blocked" | "waiting" | null;

/** CTL-729: the escalation labels that trigger attention 'needs-human'. */
export const ATTENTION_LABEL_NEEDS_HUMAN: string;
export const ATTENTION_LABEL_NEEDS_INPUT: string;
/** CTL-729: PURE classifier for the single needs-attention bucket. needs-human
 *  (a needs-human/needs-input label OR the host-local marker) WINS over
 *  waiting-on-you (a live worker's blocked bg job). The anchor follows the winning
 *  reason; null when that reason carries no durable stamp (never fabricated).
 *  CTL-1158: also accepts prStuck/prStuckSince for the PR-stuck signal. */
export function deriveAttention(opts?: {
  waitingOnUser?: boolean;
  labels?: unknown;
  needsHumanMarker?: boolean;
  waitingSince?: string | null;
  needsHumanSince?: string | null;
  prStuck?: boolean;
  prStuckSince?: string | null;
}): { attention: BoardAttention; attentionSince: string | null };

/** CTL-1158: returns true when the PR has been in a real-blocker merge state
 *  (DIRTY/BLOCKED/UNSTABLE) for ≥ 300 s, anchored to prPhaseStartedAt. */
export function isPrStuck(
  prStatus: { mergeStateStatus: string; state?: string } | null | undefined,
  prPhaseStartedAt: string | null | undefined,
  now: number,
): boolean;

/** CTL-1158: operator CTA string for a stuck PR; null when not a blocker state. */
export function prStuckReason(
  mergeStateStatus: string | null | undefined,
  prNumber: number | null | undefined,
): string | null;

/** CTL-928: a single ticket's lane on the queue board (live | between-phases |
 *  recent-done). Honors the terminal-intermediate vs pipeline-done distinction. */
export type BoardLane = "live" | "between-phases" | "recent-done";

/** CTL-928: the already-read `claude --bg` job state (state.json) shape consumed
 *  by bgJobLifecycle — { state, firstTerminalAt }, or null when the job dir is gone. */
export interface BgJobState {
  state: string | null;
  firstTerminalAt: string | null;
}

/** CTL-928: read a `claude --bg` job's durable state from
 *  ~/.claude/jobs/<bgJobId>/state.json (honours CATALYST_REVIVE_JOBS_DIR). Returns
 *  { state, firstTerminalAt }, or null when the job dir is gone. A present-but-
 *  unreadable state.json yields { state:null, firstTerminalAt:null } (alive). Never
 *  throws. */
export function readBgJobState(bgJobId: string | null | undefined): Promise<BgJobState | null>;

/** CTL-928: PURE read-model mirror of recovery.mjs::jobLifecycle. null jobState →
 *  "dead-gone"; firstTerminalAt set or terminal `state` → "dead-terminal"; else
 *  "alive". mtime is intentionally NOT consulted (CTL-662 fan-out trap). */
export function bgJobLifecycle(jobState: BgJobState | null): "dead-gone" | "dead-terminal" | "alive";

/** CTL-928: true iff bgJobLifecycle(jobState) is not "alive" (dead-gone or
 *  dead-terminal). null jobState → dead. */
export function isBgJobDead(jobState: BgJobState | null): boolean;

/** CTL-928: true iff a board worker's derived activeState is "dead". A dead worker
 *  is excluded from ticketIds, inFlight, freeSlots, and the "active" count. */
export function isWorkerDead(worker: { activeState?: BoardActiveState } | null | undefined): boolean;

/** CTL-928: PURE capacity summary — dead bg-workers excluded from inFlight +
 *  freeSlots, surfaced as `dead`. Drives the board config block. */
export function deriveCapacity(
  workers: ReadonlyArray<{ activeState?: BoardActiveState; working?: boolean }>,
  maxParallel: number,
): BoardConfig;

/** CTL-928: classify a worker's top-level liveness — durable bg-job state FIRST
 *  (a `running` signal is not proof of life), transcript age second. Returns
 *  "dead" | "stuck" | "active". `jobState` is the worker's read bg-job state (or
 *  null); `bgKnown` distinguishes a positively-read bg state (a dead verdict is
 *  trustworthy) from an unresolvable bg_job_id (fall back to transcript age). */
export function deriveActiveState(
  ticket: string,
  phase: string,
  ageMs: number | null,
  jobState: BgJobState | null,
  bgKnown: boolean,
): Promise<"dead" | "stuck" | "active">;

/** CTL-928: PURE single-source lane classifier for a non-queued ticket — "live"
 *  (a live, non-dead worker attached), "recent-done" (phase === PIPELINE_DONE_PHASE),
 *  else "between-phases" (terminal-intermediate / dead-but-running, no live worker). */
export function laneFor(ticket: {
  workerStatus: string | null;
  activeState: BoardActiveState;
  phase: string;
}): BoardLane;
export function buildPhaseSummary(phaseSigs: unknown[], now: number): BoardPhaseTiming[];
export function deriveCurrentPhase(phaseSigs: unknown[]): BoardCurrentPhase;
/** CTL-972: derive a ticket's current phase, overlaying the remediate signal on
 *  top of the PHASE_ORDER-based result. Returns phase='remediate' when the
 *  remediate agent is active (non-terminal) OR when remediate was the most-recently-
 *  active phase (terminal but more recent than the base phase). Returns the
 *  deriveCurrentPhase result unchanged when remediateSig is null/absent. PURE. */
export function derivePhaseWithRemediate(
  phaseSigs: unknown[],
  remediateSig: unknown | null | undefined,
): BoardCurrentPhase;
/** Build a thin Todo-column BoardTicket from an eligible queue entry (CTL-767). */
export function synthesizeQueuedTicket(
  eligible: unknown,
  linfo: Record<string, unknown>,
): BoardTicket;
/** CTL-1152: PURE prefix→short-repo-name map from catalyst.monitor.linear.teams[].
 *  Maps each {key,vcsRepo} to UPPERCASE-key → lowercased basename; skips entries
 *  whose vcsRepo lacks a '/'. Fail-open to {} for a non-array input. */
export function buildTeamRepoMap(
  teams: Array<{ key: string; vcsRepo: string }> | null | undefined,
): Record<string, string>;
/** CTL-1152: resolve a ticket's repo swim-lane short name from the config-driven
 *  TEAM_REPO map; an UNCONFIGURED prefix falls back to its raw lowercased team key
 *  (self-identifying), NEVER "other". */
export function repoFor(ticket: string): string;
/** CTL-1152: a ticket's team prefix, verbatim (e.g. "CTL-1152" → "CTL"). */
export function teamFor(ticket: string): string;
/** CTL-1041: resolve a ticket's display TITLE (the outcome line — leads on every
 *  surface). Priority: explicit triage.title → the authoritative Linear title
 *  (linfo, then the eligible projection) → triage.summary (last-ditch) → the
 *  ticket key. NEVER lets the triage summary (a description) stand in for a real
 *  Linear title. */
export function ticketTitle(
  ticket: string,
  triage: { title?: string | null; summary?: string | null } | null | undefined,
  eligibleIndex: Record<string, { title?: string | null } | undefined>,
  linfo?: Record<string, { title?: string | null } | undefined>,
): string;
/** CTL-1046: board IDs whose title is null in BOTH sources ticketTitle() consults
 *  (durable linfo cache + eligible projection) — i.e. cross-team (ADV) records that
 *  reach the payload via ticket_state (no title column) with no eligible entry.
 *  De-duped, order preserved. */
export function collectNullTitleIds(
  boardIds: string[],
  linfo?: Record<string, { title?: string | null } | undefined>,
  eligibleIndex?: Record<string, { title?: string | null } | undefined>,
): string[];
/** CTL-1046: merge fetched Linear titles into linfo in-place (creates a linfo entry
 *  for eligible-only tickets). A null fetched title is left untouched (honest null).
 *  Returns the mutated linfo. */
export function mergeTitleFallback(
  linfo: Record<string, { title?: string | null } & Record<string, unknown>>,
  nullTitleIds: string[],
  fetched: Record<string, { title?: string | null } | undefined>,
): Record<string, { title?: string | null } & Record<string, unknown>>;
export function assembleBoard(opts?: {
  /** CTL-1158: inject the PrStatusFetcher cache getter for the PR-stuck signal. */
  getPrStatus?: ((repo: string, number: number) => { mergeStateStatus: string; state?: string } | null) | null;
}): Promise<BoardPayload>;
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

/**
 * CTL-887 (BFF5): cache-only peek of the resident transcript-path cache. Returns
 * the absolute `~/.claude/projects/<dir>/<sessionId>.jsonl` path if board
 * assembly has already resolved it, or null on a miss (no directory scan).
 */
export function peekTranscriptCache(sessionId: string): string | null;

/**
 * CTL-733: resolve a sessionId to its transcript `.jsonl` path, caching the hit.
 * Falls back to a single project-dir scan only on a cache miss.
 */
export function resolveTranscript(sessionId: string): Promise<string | null>;

/**
 * CTL-954: derive the human-readable display string for an estimate value.
 * Maps tShirt values to size labels ("XS"/"S"/"M"/"L"/"XL"), falls back to
 * String(estimate) for other methods. Returns null when estimate is null.
 */
export function deriveEstimateDisplay(estimate: number | null, estimateMethod: string | null): string | null;
