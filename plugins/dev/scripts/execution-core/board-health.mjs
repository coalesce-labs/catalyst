// board-health.mjs — CTL-1290. The holistic board-health delegate pass.
//
// A read-only, on-cadence scan of the WHOLE board: it evaluates board-level
// invariants (the wedges that emit NO per-item signal — a silently-held
// dispatch, a node that stopped participating, a dead blocker chain), runs a
// cheap-gate funnel, and — SHADOW-FIRST — emits a `recovery.board-scan` event
// proposing safe Tier-1/2/3 moves WITHOUT acting. This is the daemon-side
// implementation of the holistic mandate that until now lived ONLY in
// recovery-pass/SKILL.md (the dispatched delegate got a per-item brief with
// zero board context). The flagged per-item set is an INPUT, not the gate.
//
// LOAD-BEARING SAFETY PROPERTIES (verify by reading this file):
//   1. PURE core. evaluateInvariants / decideBoardHealth / proposeMoves /
//      buildBoardContext / buildBoardScanEvent take a normalized boardState and
//      return data — no IO, no wall-clock, no mutation.
//   2. INJECTED IO. assembleBoardState + boardHealthPass take EVERY IO dep as a
//      param, so this module unit-tests with plain stubs AND never imports
//      bun:sqlite (the board snapshot reader is bound at the scheduler call
//      site, which already runs under Bun — see MEMORY vite_config_bun_sqlite_trap).
//   3. SHADOW TAKES ZERO MUTATING ACTION. In the shadow path this module performs
//      NO process spawning and NO board mutation: its only side effect is emit(),
//      which appends a single JSONL line (observability, not a mutation). It does
//      not import child_process / gh / git / dispatch directly; the one symbol it
//      pulls from recovery-reasoning.mjs (defaultEmitEvent) is append-only on this
//      path (the spawn-bearing recovery helpers there are never reached from here).
//      The only actuation surface is the injected `act` dep — reachable ONLY in
//      enforce, and the scheduler passes none in CTL-1290 (actuation is a follow-up).
//
// Ships behind CATALYST_BOARD_HEALTH (config.mjs readBoardHealthConfig), default
// SHADOW (the deliberate ADR-023 deviation — shadow emits one recovery.board-scan
// heartbeat per cadence and mutates nothing). CATALYST_BOARD_HEALTH=0/off is the
// kill-switch; a future ticket wires enforce.

import { isThrottled } from "./config.mjs";
import { defaultEmitEvent } from "./recovery-reasoning.mjs"; // → buildRecoveryEnvelope (CTL-1291 promotes the numbers)

// ── thresholds + cadence (env-tunable, bounded defaults) ─────────────────────
const DEFAULT_THRESHOLDS = {
  dispatchStallMs: Number(process.env.CATALYST_BH_DISPATCH_STALL_MS) || 10 * 60_000,
  workerAgeMs: Number(process.env.CATALYST_BH_WORKER_AGE_MS) || 4 * 3_600_000,
  projectSilenceMs: Number(process.env.CATALYST_BH_PROJECT_SILENCE_MS) || 24 * 3_600_000,
};

// single-LLM cadence floor: most ticks are a near-instant no-op (cheap gates),
// but the LLM-bearing review is bounded to once per interval per host.
export const BOARD_HEALTH_INTERVAL_MS =
  Number(process.env.CATALYST_BH_INTERVAL_MS) || 5 * 60_000;

// per-phase "normal" worker age (v1 flat fallback; per-phase p95 is a follow-up).
const PHASE_NORMAL_MS = {
  triage: 1 * 3_600_000,
  research: 1 * 3_600_000,
  plan: 1 * 3_600_000,
  implement: 4 * 3_600_000,
  verify: 2 * 3_600_000,
  review: 2 * 3_600_000,
  pr: 2 * 3_600_000,
  "monitor-merge": 24 * 3_600_000,
  "monitor-deploy": 24 * 3_600_000,
};

// statuses that mean "this worker is finished" — excluded from worker-age.
const TERMINAL_STATUSES = new Set(["complete", "completed", "done", "merged", "skipped"]);
// linear states a blocker can sit in and still NOT be a dead chain.
const BLOCKER_DONE_RE = /done|complete|merged|cancel|duplicate/i;

let _lastRunMs = 0; // host-local throttle state (mirrors unstuck-sweep)

// ── small pure helpers ───────────────────────────────────────────────────────
function invariant(ok, failed, observable, flagged, note, extra = {}) {
  return { ok, failed, observable, flagged, note, ...extra };
}
function emptyMoves() {
  return { tier1: [], tier2: [], tier3: [] };
}
function isTerminalStatus(status) {
  return status != null && TERMINAL_STATUSES.has(String(status).toLowerCase());
}
function dedupeFlagged(invariants) {
  const seen = new Set();
  for (const v of Object.values(invariants)) {
    for (const f of v.flagged ?? []) seen.add(f);
  }
  return [...seen];
}

// extractBlockers — pull blocked_by target ids out of a descriptor's relations,
// tolerating the several shapes the cache/broker emit (array of relation
// objects, or a flat {blockedBy:[...]}). Returns [] on anything unparseable —
// blocked-tree degrades to "no blockers seen", never throws.
function extractBlockers(descriptor) {
  if (!descriptor) return [];
  let rel = descriptor.relations ?? descriptor.blockedBy ?? null;
  if (typeof rel === "string") {
    try { rel = JSON.parse(rel); } catch { return []; }
  }
  if (!rel) return [];
  const ids = [];
  const push = (x) => {
    if (!x) return;
    const id = x.identifier ?? x.relatedIssue?.identifier ?? x.ticket ?? (typeof x === "string" ? x : null);
    if (id) ids.push(id);
  };
  if (Array.isArray(rel)) {
    for (const r of rel) {
      const t = (r?.type ?? "").toLowerCase();
      if (t && !/block/.test(t)) continue; // only blocked_by/blocks edges
      push(r);
    }
  } else if (Array.isArray(rel.blockedBy)) {
    for (const r of rel.blockedBy) push(r);
  }
  return ids;
}

// deriveRing — distill the bounded recent-event tail into the few out-of-band
// signals the invariants need. Best-effort: an event class that isn't present
// yields null/empty, and the dependent invariant degrades to observable:false.
function deriveRing(events, nowMs) {
  const ring = {
    recentDispatchTs: null,
    cacheReconcile: null,
    accountRatelimit: null,
    reconcileFailing: new Set(),
  };
  for (const ev of events ?? []) {
    const name = ev?.attributes?.["event.name"] ?? ev?.["event.name"] ?? ev?.type ?? "";
    const payload = ev?.body?.payload ?? ev?.payload ?? {};
    const tsMs = ev?.ts ? Date.parse(ev.ts) : NaN;
    // Only dispatch SUCCESS signals count as "the dispatcher is alive". A failing
    // loop (phase.dispatch.{failed,escalated,runaway}) must NOT clear the silent-
    // hold wedge — those are the LOUD failure modes other guards catch (circuit
    // breaker, runaway alert); counting them here would green the invariant exactly
    // when dispatch is broken. requested|launched = the scheduler actually acting.
    if (/\.dispatch\.(requested|launched)(\.|$)|worker[.-]create|new-work/i.test(name)) {
      if (Number.isFinite(tsMs)) ring.recentDispatchTs = Math.max(ring.recentDispatchTs ?? 0, tsMs);
    } else if (/cache\.reconcile/i.test(name)) {
      ring.cacheReconcile = {
        changed: payload.changed ?? payload.corrected ?? 0,
        scanned: payload.scanned ?? null,
        failed: payload.failed ?? 0,
        mode: payload.mode ?? null,
      };
    } else if (/account\.ratelimit|ratelimit\.sampled/i.test(name)) {
      ring.accountRatelimit = { nearCliff: !!(payload.nearCliff ?? payload.near_cliff), ...payload };
    } else if (/reconcile\.failing/i.test(name)) {
      const team = payload.team ?? name.split(".").pop();
      if (team) ring.reconcileFailing.add(team);
    }
  }
  // guard against a stale dispatch ts in the future / absurd past
  if (ring.recentDispatchTs != null && (ring.recentDispatchTs > nowMs + 60_000)) {
    ring.recentDispatchTs = nowMs;
  }
  return ring;
}

// ── (1) assembleBoardState — the ONE impure reader (reads only, never writes) ─
export function assembleBoardState({
  orchDir,
  getBoard = () => [],
  getWorkerSignals = () => [],
  getEligible = () => [],
  roster = [],
  self = "",
  multiHost = false,
  capacity = { maxParallel: 0, liveCount: 0, freeSlots: 0 },
  readEventRing = () => [],
  ownerForTicket = null,
  getReconcileMarkers = () => ({}),
  now = () => Date.now(),
} = {}) {
  const nowMs = now();
  const safe = (fn, fallback) => {
    try {
      const v = fn();
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const ticketsById = new Map();
  for (const d of safe(() => getBoard(), [])) {
    if (!d) continue;
    const id = d.identifier ?? d.ticket ?? d.id;
    if (id) ticketsById.set(id, d);
  }

  const signals = safe(() => getWorkerSignals(), []).map((s) => {
    const updatedAt = s.updatedAt ?? s.updated_at ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    return {
      ticket: s.ticket ?? s.identifier ?? null,
      phase: s.phase ?? null,
      status: s.status ?? null,
      updatedAt,
      ageMs: Number.isFinite(updatedMs) ? nowMs - updatedMs : null,
      host: s.host ?? s.owner_host ?? null,
    };
  });

  const eligible = safe(() => getEligible(), []).map((e) => ({
    id: e.identifier ?? e.id ?? e.ticket ?? null,
    priority: e.priority ?? null,
    createdAt: e.createdAt ?? e.created_at ?? null,
    project: e.project ?? e.projectName ?? null,
    state: e.state ?? e.linear_state ?? null,
    updatedAt: e.updatedAt ?? e.updated_at ?? null,
  }));

  return Object.freeze({
    ticketsById,
    signals,
    eligible,
    roster: Array.isArray(roster) ? roster : [],
    self: self ?? "",
    multiHost: !!multiHost,
    capacity: {
      maxParallel: capacity?.maxParallel ?? 0,
      liveCount: capacity?.liveCount ?? 0,
      freeSlots: capacity?.freeSlots ?? 0,
    },
    reconcileMarkers: safe(() => getReconcileMarkers(), {}),
    ring: deriveRing(safe(() => readEventRing({ orchDir }), []), nowMs),
    ownerForTicket: typeof ownerForTicket === "function" ? ownerForTicket : null,
    now: nowMs,
  });
}

// ── (2) evaluateInvariants — PURE. Each check fails-open on a throw. ─────────
export function evaluateInvariants(boardState, { thresholds = DEFAULT_THRESHOLDS } = {}) {
  const checks = {
    cacheCoherence: () => checkCacheCoherence(boardState),
    dispatchLiveness: () => checkDispatchLiveness(boardState, thresholds),
    workerAge: () => checkWorkerAge(boardState, thresholds),
    blockedTree: () => checkBlockedTree(boardState),
    projectSilence: () => checkProjectSilence(boardState, thresholds),
    rateLimitHeadroom: () => checkRateLimitHeadroom(boardState),
    strandedNode: () => checkStrandedNode(boardState),
  };
  const out = {};
  for (const [name, fn] of Object.entries(checks)) {
    try {
      out[name] = fn();
    } catch (err) {
      // a throwing invariant must never abort the scan — fail open, but record.
      out[name] = invariant(true, 0, true, [], `check error: ${err.message}`, { error: err.message });
    }
  }
  return out;
}

// #0 — cache coherence (post-CTL-1288). Trust the broker reconcile summary in
// the ring; never re-diff Linear inline (the self-constraint: read once, batch).
function checkCacheCoherence(b) {
  const cr = b.ring?.cacheReconcile;
  if (!cr) return invariant(true, 0, false, [], "cache reconcile off/unseen → coherence unknown");
  const changed = Number(cr.changed) || 0;
  return invariant(changed === 0, changed > 0 ? 1 : 0, true, [], `last reconcile corrected ${changed} row(s)`);
}

// #1 — dispatch liveness (the liveness-hold wedge): open slots + a waiting queue
// + ~no recent dispatch. The single most important silent wedge.
function checkDispatchLiveness(b, t) {
  const free = b.capacity.freeSlots;
  const queued = b.eligible.length;
  if (free <= 0 || queued <= 0) {
    return invariant(true, 0, true, [], `no wedge (free=${free}, queued=${queued})`);
  }
  const last = b.ring?.recentDispatchTs ?? null;
  const staleMs = last == null ? null : b.now - last;
  const wedged = last == null ? true : staleMs > t.dispatchStallMs;
  return invariant(
    !wedged,
    wedged ? 1 : 0,
    true,
    wedged ? b.eligible.slice(0, 5).map((e) => e.id).filter(Boolean) : [],
    wedged
      ? `${free} free slot(s) + ${queued} queued + ${last == null ? "no recent dispatch seen" : `${Math.round(staleMs / 60_000)}m since dispatch`} → wedge`
      : "dispatch live",
  );
}

// #2 — worker age: a non-terminal worker idling far past its phase normal
// (the CTL-1186 88h-in-slot class), even if it emits no stuck signal.
function checkWorkerAge(b, t) {
  const flagged = [];
  for (const s of b.signals) {
    if (!s.ticket || s.ageMs == null) continue;
    if (isTerminalStatus(s.status)) continue;
    const limit = PHASE_NORMAL_MS[s.phase] ?? t.workerAgeMs;
    if (s.ageMs > limit) flagged.push(s.ticket);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length ? `${flagged.length} worker(s) past phase-normal age` : "all workers within normal age",
  );
}

// #3 — blocked tree alive: nothing blocked by a blocker that is itself
// unscheduled (not eligible/in-flight) and not done.
function checkBlockedTree(b) {
  const scheduled = new Set([
    ...b.eligible.map((e) => e.id),
    ...b.signals.map((s) => s.ticket),
  ].filter(Boolean));
  const flagged = [];
  for (const [id, d] of b.ticketsById) {
    for (const blockerId of extractBlockers(d)) {
      const blocker = b.ticketsById.get(blockerId);
      const blockerState = blocker ? (blocker.state ?? blocker.linear_state ?? null) : null;
      const blockerDone = blockerState != null && BLOCKER_DONE_RE.test(blockerState);
      if (!blockerDone && !scheduled.has(blockerId)) {
        flagged.push(id);
        break;
      }
    }
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length ? `${flagged.length} ticket(s) blocked by an unscheduled/stuck blocker` : "blocked tree alive",
    { caveat: "relations may be stale (cache; reconciled out-of-band)" },
  );
}

// #4 — project silence (weakest signal; updatedAt is a movement proxy). Only
// observable when descriptors carry both project + updatedAt.
function checkProjectSilence(b, t) {
  const byProject = new Map(); // project → max updatedMs
  const consider = (project, updatedAt) => {
    if (!project || !updatedAt) return;
    const ms = Date.parse(updatedAt);
    if (!Number.isFinite(ms)) return;
    byProject.set(project, Math.max(byProject.get(project) ?? 0, ms));
  };
  for (const e of b.eligible) consider(e.project, e.updatedAt);
  for (const [, d] of b.ticketsById) consider(d.project ?? d.projectName, d.updatedAt ?? d.updated_at);
  if (byProject.size === 0) {
    return invariant(true, 0, false, [], "no project/updatedAt join available → not observable");
  }
  const flagged = [];
  for (const [project, lastMs] of byProject) {
    if (b.now - lastMs > t.projectSilenceMs) flagged.push(project);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length ? `${flagged.length} project(s) silent past cadence` : "all projects moving",
    { caveat: "updatedAt is a movement proxy" },
  );
}

// #5 — rate-limit headroom. Anthropic proxy via the ring; Linear/GitHub have no
// durable out-of-band 429 signal yet (breaker is in-proc only) → observable:false.
function checkRateLimitHeadroom(b) {
  const rl = b.ring?.accountRatelimit;
  if (!rl) {
    return invariant(true, 0, false, [], "no out-of-band rate-limit signal (Linear/GitHub breaker in-proc only)");
  }
  const near = !!rl.nearCliff;
  return invariant(!near, near ? 1 : 0, true, [], near ? "near a rate-limit cliff" : "rate-limit headroom ok");
}

// #6 — stranded node (mini-2 class): a rostered host that HRW-owns a share of
// the board but whose team reconcile is failing. Cross-host PEER liveness needs
// the heartbeat/Loki path → only the local-marker form ships now.
function checkStrandedNode(b) {
  if (!b.ownerForTicket || b.roster.length === 0) {
    return invariant(true, 0, false, [], "no roster/HRW → stranded-node not observable");
  }
  const ownedByHost = new Map();
  for (const [id] of b.ticketsById) {
    let owner;
    try { owner = b.ownerForTicket(id, b.roster); } catch { owner = null; }
    if (!owner) continue;
    ownedByHost.set(owner, (ownedByHost.get(owner) ?? 0) + 1);
  }
  const failing = b.ring?.reconcileFailing ?? new Set();
  const markers = b.reconcileMarkers ?? {};
  const flagged = [];
  for (const host of b.roster) {
    const share = ownedByHost.get(host) ?? 0;
    if (share <= 0) continue;
    const markerFail = (markers[host]?.consecutiveFailures ?? 0) > 0;
    const ringFail = failing.has(host);
    if (markerFail || ringFail) flagged.push(host);
  }
  // observable only if we have SOME reconcile signal to judge against.
  const haveSignal = Object.keys(markers).length > 0 || failing.size > 0;
  return invariant(
    flagged.length === 0,
    flagged.length,
    haveSignal,
    flagged,
    flagged.length
      ? `node(s) stranded (own work, reconcile failing): ${flagged.join(", ")}`
      : haveSignal
        ? "all rostered nodes participating"
        : "no reconcile-health signal → peer liveness not observable",
  );
}

// ── (3) decideBoardHealth — PURE. The cheap-gate funnel. First match wins. ───
export function decideBoardHealth(invariants, boardState) {
  const observableFailed = Object.values(invariants).filter((v) => v.observable && !v.ok);
  const invariantsFailed = observableFailed.reduce((n, v) => n + (Number(v.failed) || 0), 0);

  // Gate 1 — all observable invariants green → skip (no LLM thrash).
  if (observableFailed.length === 0) {
    return decision("skip", "all-green", invariantsFailed, emptyMoves());
  }
  // Gate 2 — failures exist but no free slot to dispatch a fix → skip.
  if ((boardState.capacity?.freeSlots ?? 0) <= 0) {
    return decision("skip", "no-free-slots", invariantsFailed, emptyMoves());
  }
  // Gate 3 — near a rate-limit cliff → acting now risks 429s → skip (and obey it).
  const rl = invariants.rateLimitHeadroom;
  if (rl && rl.observable && !rl.ok) {
    return decision("skip", "rate-limit-cliff", invariantsFailed, emptyMoves());
  }
  // Gate 4 — real failures + headroom → proceed; compute proposed moves.
  return decision("proceed", `${observableFailed.length} invariant(s) flagged`, invariantsFailed, proposeMoves(invariants, boardState));
}

function decision(gateDecision, reason, invariantsFailed, moves) {
  return {
    gate: { decision: gateDecision, reason },
    invariantsFailed,
    proposed: { tier1: moves.tier1.length, tier2: moves.tier2.length, tier3: moves.tier3.length },
    moves,
  };
}

// ── (4) proposeMoves — PURE. Maps failed invariants → tiered proposals. Never
// executes. The tier is "does this change the SYSTEM or just unstick a THING?"
export function proposeMoves(invariants, b) {
  const tier1 = [];
  const tier2 = [];
  const tier3 = [];
  if (invariants.dispatchLiveness && !invariants.dispatchLiveness.ok) {
    tier1.push({ move: "kick-dispatch", rationale: invariants.dispatchLiveness.note });
  }
  for (const t of invariants.workerAge?.flagged ?? []) {
    if (!invariants.workerAge.ok) tier1.push({ ticket: t, move: "nudge", rationale: "worker past phase-normal age" });
  }
  if (invariants.cacheCoherence && invariants.cacheCoherence.observable && !invariants.cacheCoherence.ok) {
    tier1.push({ move: "note-cache-drift", rationale: invariants.cacheCoherence.note });
  }
  for (const t of invariants.blockedTree?.flagged ?? []) {
    if (!invariants.blockedTree.ok) tier2.push({ ticket: t, move: "re-dispatch-blocker", rationale: "blocked by unscheduled/stuck blocker" });
  }
  for (const h of invariants.strandedNode?.flagged ?? []) {
    if (!invariants.strandedNode.ok) tier3.push({ host: h, move: "escalate-stranded-node", rationale: "rostered node owns work but reconcile is failing" });
  }
  for (const p of invariants.projectSilence?.flagged ?? []) {
    if (!invariants.projectSilence.ok) tier3.push({ project: p, move: "escalate-project-silence", rationale: "no movement in expected cadence" });
  }
  return { tier1, tier2, tier3 };
}

// ── (5) buildBoardContext — PURE. The whole-board brief the dispatched delegate
// gets injected into recovery-pass.json (today it gets NONE).
export function buildBoardContext(boardState, invariants) {
  const stuckWorkers = (invariants.workerAge?.flagged ?? []).map((t) => {
    const s = boardState.signals.find((x) => x.ticket === t);
    return {
      ticket: t,
      phase: s?.phase ?? null,
      status: s?.status ?? null,
      ageSeconds: s?.ageMs != null ? Math.round(s.ageMs / 1000) : null,
    };
  });
  return {
    schema: "recovery-board-context/v1",
    snapshotAt: new Date(boardState.now).toISOString(),
    host: { self: boardState.self, roster: boardState.roster, multiHost: boardState.multiHost },
    slots: {
      capacity: boardState.capacity.maxParallel,
      inUse: boardState.capacity.liveCount,
      free: boardState.capacity.freeSlots,
    },
    eligibleQueue: {
      depth: boardState.eligible.length,
      topTickets: boardState.eligible.slice(0, 5).map((e) => e.id).filter(Boolean),
    },
    stuckWorkers,
    strandedNodes: (invariants.strandedNode?.flagged ?? []).map((host) => ({
      host,
      // the tickets HRW-owned by this stranded host — the delegate's actionable
      // payload (which work is at risk on the node that stopped reconciling).
      ownedTickets: boardState.ownerForTicket
        ? [...boardState.ticketsById.keys()].filter((id) => {
            try {
              return boardState.ownerForTicket(id, boardState.roster) === host;
            } catch {
              return false;
            }
          })
        : [],
    })),
    invariants: Object.fromEntries(
      Object.entries(invariants).map(([k, v]) => [k, { ok: v.ok, failed: v.failed }]),
    ),
  };
}

// ── (6) buildBoardScanEvent — PURE. The flat event reused through the CTL-1287
// emit envelope. Scalars at the top of details (CTL-1291 promotes them to
// chartable attributes); rosters/move arrays stay in details → body.payload.
export function buildBoardScanEvent({ mode, invariants, decision }) {
  const totalMoves = decision.proposed.tier1 + decision.proposed.tier2 + decision.proposed.tier3;
  return {
    type: "recovery.board-scan",
    ticket: null, // board/fleet-scoped → event.label:null; the board reader ignores it (correct)
    fix_class: null,
    reason:
      `board-health scan (${mode}): ${decision.invariantsFailed} invariant(s) flagged, ` +
      `gate=${decision.gate.decision}, ${totalMoves} move(s) proposed`,
    details: {
      mode,
      // ── chartable scalars (CTL-1291 promoteNumericAttrs) ──
      invariantsFailed: decision.invariantsFailed,
      gateDecision: decision.gate.decision,
      gateReason: decision.gate.reason,
      proposedTier1: decision.proposed.tier1,
      proposedTier2: decision.proposed.tier2,
      proposedTier3: decision.proposed.tier3,
      invariants: Object.fromEntries(
        Object.entries(invariants).map(([k, v]) => [k, { ok: v.ok, failed: v.failed, observable: v.observable }]),
      ),
      // ── rosters/proposals: stay in body.payload, NEVER promoted (cardinality) ──
      flagged: dedupeFlagged(invariants),
      tier1Moves: decision.moves.tier1,
      tier2Moves: decision.moves.tier2,
      tier3Moves: decision.moves.tier3,
    },
  };
}

// ── (7) boardHealthPass — the single scheduler entry. The ONE place mode branches.
export function boardHealthPass({
  mode,
  orchDir,
  getBoard,
  getWorkerSignals,
  getEligible,
  roster,
  self,
  multiHost,
  capacity,
  readEventRing,
  ownerForTicket,
  getReconcileMarkers,
  lastRunMs = _lastRunMs,
  intervalMs = BOARD_HEALTH_INTERVAL_MS,
  isThrottledFn = isThrottled,
  emit = defaultEmitEvent,
  act = undefined, // ONLY reachable in enforce; the scheduler passes NOTHING in CTL-1290
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (mode === "off") return { ran: false, reason: "off" }; // strict no-op
  const nowMs = now();
  if (isThrottledFn(lastRunMs, intervalMs, nowMs)) {
    return { ran: false, reason: "throttled" }; // no emit, no act
  }

  const board = assembleBoardState({
    orchDir, getBoard, getWorkerSignals, getEligible,
    roster, self, multiHost, capacity, readEventRing, ownerForTicket, getReconcileMarkers, now,
  });
  const invariants = evaluateInvariants(board, {});
  const dec = decideBoardHealth(invariants, board);

  try {
    emit(buildBoardScanEvent({ mode, invariants, decision: dec })); // shadow AND enforce
  } catch (err) {
    log({ err: err.message }, "board-health: emit failed (continuing)");
  }

  // enforce-ONLY actuation, and only if a caller injected an `act` seam. The
  // scheduler does NOT in CTL-1290 → enforce is inert here. Guard kept so a
  // future ticket can wire it without re-touching the safety structure.
  if (mode === "enforce" && typeof act === "function" && dec.gate.decision === "proceed") {
    for (const move of [...dec.moves.tier1, ...dec.moves.tier2, ...dec.moves.tier3]) {
      if (multiHost && move.ticket && board.ownerForTicket) {
        let owner;
        try { owner = board.ownerForTicket(move.ticket, board.roster); } catch { owner = null; }
        if (owner && owner !== board.self) continue; // HRW gate — don't act on another host's item
      }
      try { act(move, board); } catch (err) { log({ err: err.message, move }, "board-health: act failed (continuing)"); }
    }
  }

  _lastRunMs = nowMs;
  return { ran: true, mode, ranAtMs: nowMs, invariants, decision: dec };
}
