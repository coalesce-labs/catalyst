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
//      enforce. CTL-1300 wires the daemon binding to inject it (a holistic
//      recovery-pass dispatch); shadow/off and a bare schedulerTick never reach it.
//
// Ships behind CATALYST_BOARD_HEALTH (config.mjs readBoardHealthConfig), default
// SHADOW (the deliberate ADR-023 deviation — shadow emits one recovery.board-scan
// heartbeat per cadence and mutates nothing). CATALYST_BOARD_HEALTH=0/off is the
// kill-switch; enforce (CTL-1300) dispatches ONE holistic recovery-pass delegate
// per proceeding scan, anchored + carrying the whole-board context — operator-gated.

import { isThrottled } from "./config.mjs";
import { defaultEmitEvent } from "./recovery-reasoning.mjs"; // → buildRecoveryEnvelope (CTL-1291 promotes the numbers)

// ── thresholds + cadence (env-tunable, bounded defaults) ─────────────────────
const DEFAULT_THRESHOLDS = {
  dispatchStallMs: Number(process.env.CATALYST_BH_DISPATCH_STALL_MS) || 10 * 60_000,
  workerAgeMs: Number(process.env.CATALYST_BH_WORKER_AGE_MS) || 4 * 3_600_000,
  projectSilenceMs: Number(process.env.CATALYST_BH_PROJECT_SILENCE_MS) || 24 * 3_600_000,
  // CTL-1157: an open PR with no live worker is "orphaned" past this age; a
  // needs-human-labelled ticket is "frozen" past this age. 48h defaults.
  orphanedPrAgeMs: Number(process.env.CATALYST_BH_ORPHANED_PR_MS) || 48 * 3_600_000,
  frozenNeedsHumanMs: Number(process.env.CATALYST_BH_FROZEN_NH_MS) || 48 * 3_600_000,
  // CTL-1435 (C2): actuation-liveness window — how many recent ENFORCE board-scans
  // must ALL be owned-but-undispatched before the delegate flags its own
  // propose-forever/dispatch-never wedge. 6 scans ≈ 30 min at the 5-min cadence.
  // Observable only with ≥K enforce scans in the event tail, so a short/busy event
  // window never false-flags.
  actuationLivenessScans: Number(process.env.CATALYST_BH_ACTUATION_K) || 6,
  // CTL-1435 (C2, Codex round-2): the K scans must ALL fall within this window of
  // now, so stale scans from before a daemon downtime / low-traffic gap can't
  // combine with one fresh scan to fake a "K consecutive" run. 60 min gives K=6 at
  // 5-min cadence (~30-min real span) generous headroom while rejecting hour+ gaps.
  actuationLivenessWindowMs: Number(process.env.CATALYST_BH_ACTUATION_WINDOW_MS) || 60 * 60_000,
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

// CTL-1157 cohort matchers. PR_STATE_RE = a Linear state that means "a PR is
// open/in review" (the phantom-merged-PR cohort lives here); PR_MERGED_RE = a
// filter_state status that means the PR already landed/shipped.
const PR_STATE_RE = /^pr$|in.?review/i;
const PR_MERGED_RE = /^(merged|deployed)$/i;
// label/status forms of "needs a human".
const NEEDS_HUMAN_LABEL_RE = /needs.?human/i;
const NEEDS_HUMAN_STATUSES = new Set(["needs-human", "needs_human", "stalled"]);

// prNumberOf — read a ticket descriptor's linked PR number.
function prNumberOf(d) {
  const n = d?.prNumber ?? d?.pr_number ?? null;
  return n == null ? null : Number(n);
}

// lookupPrStatus — resolve the lifecycle status of (prNumber, repo) against the
// composite prStatusMap (`Map<number, Map<repoKey, {status,updatedAt,repo}>>`,
// produced by broker-state.getAllPrStatuses; repoKey is the row's "owner/repo" or
// "" when the lifecycle row carries no repo attribution). The disambiguation rules
// (CTL-1157, Codex #4 round-4 — require the exact repo when it is KNOWN, never borrow
// an unrelated repo's row for the same number):
//   • No entry for the number → null (not observable).
//   • Ticket repo KNOWN:
//       – exact `byRepo.get(repo)` hit → return it (definitive).
//       – no exact hit, but the number has a SINGLE UNATTRIBUTED ("") row → return it
//         (a legacy / single-repo lifecycle row written before repo attribution; using
//         it preserves phantom/orphan detection on the single-repo fleet).
//       – otherwise (rows exist ONLY for other KNOWN repos, or ambiguous) → null. This
//         is the fix: a ticket in org/y with PR #42 must NOT inherit org/x#42's status
//         just because org/x is the only row for #42.
//   • Ticket repo UNDERIVABLE:
//       – exactly one repo holds the number → number-only resolution (legacy N=1).
//       – the number collides across repos → {ambiguous:true} so the cohort skips
//         rather than borrow a wrong repo's status.
// `repo` is the ticket's GitHub "owner/repo" (or null when underivable).
function lookupPrStatus(map, prNumber, repo) {
  if (!(map instanceof Map)) return null;
  const byRepo = map.get(prNumber);
  if (!(byRepo instanceof Map) || byRepo.size === 0) return null;

  const repoKnown = repo != null && repo !== "";
  if (repoKnown) {
    // (1) Exact match on the ticket's OWN repo — definitive.
    const exact = byRepo.get(repo);
    if (exact) return exact;
    // (2) No row attributed to the ticket's repo. The ONLY row we may still trust is a
    //     LONE unattributed ("") row — a lifecycle row written before repo attribution.
    //     This keeps single-repo detection while never borrowing another KNOWN repo's #N.
    if (byRepo.size === 1) {
      const [[onlyKey, only]] = byRepo.entries();
      if (onlyKey === "") return only;
    }
    // (3) Rows exist only for OTHER known repos (or are ambiguous) → do not borrow.
    return null;
  }

  // Repo underivable: fall back to number-only resolution, ambiguous on collision.
  if (byRepo.size === 1) {
    const [only] = byRepo.values();
    return only;
  }
  return { status: null, updatedAt: null, repo: null, ambiguous: true };
}

// safeRepoOf — call the injected ticket→owner/repo resolver, fail-open to null
// (a throwing/absent resolver must never abort an invariant; null → number-only
// lookup, i.e. the pre-CTL-1157 behavior).
function safeRepoOf(resolver, id) {
  if (typeof resolver !== "function") return null;
  try {
    const r = resolver(id);
    return typeof r === "string" && r.length > 0 ? r : null;
  } catch {
    return null;
  }
}
function labelsOf(d) {
  const l = d?.labels;
  return Array.isArray(l) ? l : null;
}
function labelName(l) {
  return String(l?.name ?? l ?? "");
}

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
// SLOT_FREED_STATUSES — a worker signal in one of these no longer occupies a
// slot / is no longer live. Mirrors the scheduler's isTicketInFlight (failed /
// stalled / aborted FREE the slot, scheduler.mjs) and signal-reader.TERMINAL
// (adds turn-cap-exhausted). Distinct from TERMINAL_STATUSES (success-like only,
// used by worker-age): a failed/stalled worker is NOT terminal-success but is
// also NOT live, so a PR stuck behind a dead/failed worker reads as orphaned.
const SLOT_FREED_STATUSES = new Set([
  ...TERMINAL_STATUSES,
  "failed",
  "stalled",
  "aborted",
  "turn-cap-exhausted",
]);
// isLiveWorkerStatus — true when a worker signal still represents active,
// slot-occupying work (not terminal-success AND not failed/stalled/aborted).
function isLiveWorkerStatus(status) {
  return status != null && !SLOT_FREED_STATUSES.has(String(status).toLowerCase());
}
// isTerminalLinearState — the ticket's Linear workflow state is terminal
// (Done/Canceled/Duplicate/merged). Reuses the same terminal-state pattern the
// blocked-tree walk uses (BLOCKER_DONE_RE) and mirrors the reconcile's
// Done/Canceled/Duplicate exclusion (linear-reconcile.mjs terminalStates), so
// board-health never proposes recovery for already-terminal work whose only
// remaining signal is a stale cached label (the CTL-1157/1162 stale-label class
// that terminal-needs-human-reconcile strips lazily).
function isTerminalLinearState(d) {
  const state = d?.state ?? d?.linear_state ?? null;
  return state != null && BLOCKER_DONE_RE.test(String(state));
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
    boardScans: [], // CTL-1435 (C2): per-scan actuation outcomes, chronological
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
    } else if (name === "recovery.board-scan") {
      // CTL-1435 (C2): retain each board-scan's actuation outcome so
      // checkActuationLiveness can spot a proceed-but-dispatch-never run.
      // Codex P1: the REAL emit envelope (buildRecoveryEnvelope) nests the scan
      // fields under body.payload.DETAILS — reading them off a flat `payload` gets
      // null for every live event, silently disabling the invariant. Fall back to a
      // flat payload so hand-built / legacy events still read.
      const d = payload.details ?? payload;
      ring.boardScans.push({
        tsMs: Number.isFinite(tsMs) ? tsMs : null,
        mode: d.mode ?? null,
        gate: d.gateDecision ?? null,
        proposedMoves: (d.proposedTier1 ?? 0) + (d.proposedTier2 ?? 0) + (d.proposedTier3 ?? 0),
        dispatched: d.act?.dispatched === true,
        // Codex P2: skippedReason is what tells a true actuation wedge (owned
        // anchor, all-candidates-cooldown / act-error) from a benign non-dispatch
        // (no-owned-anchor, gate-hold) — including the deferred-only proceed path
        // where proposedMoves is 0.
        skippedReason: d.act?.skippedReason ?? null,
      });
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
  // CTL-1157 (MUST-FIX 1): the provably-dead host set — hosts whose heartbeat is
  // stale past the grace window. The daemon computes it from computeSurvivingRoster
  // (scheduler.mjs); empty default keeps the holistic foreign-failover unreachable
  // (shadow-safe AND N=1-safe).
  deadHosts = [],
  self = "",
  multiHost = false,
  capacity = { maxParallel: 0, liveCount: 0, freeSlots: 0 },
  readEventRing = () => [],
  ownerForTicket = null,
  // CTL-1157 (Codex #4): resolve a stuck ticket → its GitHub "owner/repo" so the
  // phantom/orphaned-PR cohorts look up the EXACT (repo, number) entry in the
  // composite prStatusMap instead of skipping a cross-repo #-collision. Daemon-
  // bound at the scheduler call site (teamOf → registry repoRoot →
  // ownerRepoFromRepoRoot); null default ⇒ repo underivable ⇒ number-only lookup
  // (N=1 byte-identical; a true collision with no repo stays the ambiguous skip).
  repoForTicket = null,
  getReconcileMarkers = () => ({}),
  // CTL-1432 (B2): live query for tickets carrying a deferred board-health
  // recovery-intent (defer→fix_class=board-health) — folded into the anchor
  // candidates so the holistic pass actuates them. Empty default keeps a bare unit
  // call byte-identical.
  getDeferredBoardHealthTickets = () => [],
  // CTL-1432 (B3): operator-sanctioned needs-human latch allowlist (a static array,
  // not a live query). Suppressed from proposeMoves; stays visible in frozenNeedsHuman.
  sanctionedNeedsHuman = [],
  // CTL-1157: PR-lifecycle status map (filter_state). Empty Map default ⇒ the
  // phantom-merged-PR / orphaned-open-PR invariants stay observable:false (the
  // shadow-first seam: wiring lands before the invariants begin observing).
  getPrStatusMap = () => new Map(),
  // CTL-1157 off-gate: the run mode threads in so `off` is provably DARK. In off
  // we never invoke getPrStatusMap() (the getAllPrStatuses() filter_state SELECT
  // must not run), and evaluateInvariants reads board.mode to skip the cohort
  // checks — together making an off scan byte-identical to origin/main.
  mode = undefined,
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
      // CTL-1157: preserve the worker's typed failure reason so the delegate's
      // injected brief carries it per-ticket (consumed by the stuck-PR cohort
      // brief) without re-reading each signal file.
      failureReason: s.raw?.failureReason ?? s.failureReason ?? null,
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
    deadHosts: Array.isArray(deadHosts) ? deadHosts : [],
    self: self ?? "",
    multiHost: !!multiHost,
    // CTL-1157 off-gate: carried so evaluateInvariants can skip the cohort checks
    // in off without re-threading mode through every call site.
    mode,
    capacity: {
      maxParallel: capacity?.maxParallel ?? 0,
      liveCount: capacity?.liveCount ?? 0,
      freeSlots: capacity?.freeSlots ?? 0,
    },
    reconcileMarkers: safe(() => getReconcileMarkers(), {}),
    // CTL-1432 (B2/B3): deferred board-health anchor candidates + the sanctioned
    // needs-human allowlist, carried on the frozen board for the pure consumers
    // (selectAnchorCandidates reads deferredBoardHealth; proposeMoves reads
    // sanctionedNeedsHuman).
    deferredBoardHealth: safe(() => getDeferredBoardHealthTickets(), []),
    sanctionedNeedsHuman: Array.isArray(sanctionedNeedsHuman) ? sanctionedNeedsHuman : [],
    // CTL-1157 off-gate: in off the filter_state PR-status SELECT must NOT run —
    // skip getPrStatusMap() entirely so off is byte-identical to origin/main (the
    // phantom/orphaned-PR invariants also stay out of evaluateInvariants in off).
    prStatusMap: mode === "off" ? new Map() : safe(() => getPrStatusMap(), new Map()),
    ring: deriveRing(safe(() => readEventRing({ orchDir }), []), nowMs),
    ownerForTicket: typeof ownerForTicket === "function" ? ownerForTicket : null,
    // CTL-1157 (Codex #4): the ticket→owner/repo resolver for the composite
    // (repo, number) PR-status lookup. Null when unbound (number-only fallback).
    repoForTicket: typeof repoForTicket === "function" ? repoForTicket : null,
    now: nowMs,
  });
}

// ── (2) evaluateInvariants — PURE. Each check fails-open on a throw. ─────────
export function evaluateInvariants(boardState, { thresholds = DEFAULT_THRESHOLDS, mode = boardState?.mode } = {}) {
  const checks = {
    cacheCoherence: () => checkCacheCoherence(boardState),
    dispatchLiveness: () => checkDispatchLiveness(boardState, thresholds),
    workerAge: () => checkWorkerAge(boardState, thresholds),
    blockedTree: () => checkBlockedTree(boardState),
    projectSilence: () => checkProjectSilence(boardState, thresholds),
    rateLimitHeadroom: () => checkRateLimitHeadroom(boardState),
    strandedNode: () => checkStrandedNode(boardState),
  };
  // CTL-1157 off-gate: the four NEW cohort invariants run ONLY in shadow/enforce
  // — never in off. In off this set is omitted entirely, so the board-scan event's
  // details.invariants is byte-identical to origin/main (the legacy 7 keys only),
  // and checkNeedsHumanPile (always-observable, status-based) no longer runs in
  // off — it is gated here exactly like its three cohort siblings. SHADOW DOES run
  // them: that is intentional read-only telemetry (the OTEL before/after baseline);
  // the no-action guarantee is enforced separately in boardHealthPass (act is
  // reached ONLY in enforce). `mode` defaults from boardState.mode (set by
  // assembleBoardState); an undefined mode (bare unit call) keeps the legacy
  // behavior of running them.
  if (mode !== "off") {
    Object.assign(checks, {
      // CTL-1157: the three stuck cohorts board-health was blind to + the
      // status-based needs-human catch-all (Workstream B).
      phantomMergedPr: () => checkPhantomMergedPr(boardState),
      orphanedOpenPr: () => checkOrphanedOpenPr(boardState, thresholds),
      frozenNeedsHuman: () => checkFrozenNeedsHuman(boardState, thresholds),
      needsHumanPile: () => checkNeedsHumanPile(boardState),
      // CTL-1435 (C2): the delegate's SELF-observation — flags its own
      // propose-forever/dispatch-never wedge. Cohort-gated (never runs in off) and
      // observable ONLY in enforce (shadow not-dispatching is by-design telemetry),
      // so the off-mode invariant set stays byte-identical to origin/main.
      actuationLiveness: () => checkActuationLiveness(boardState, thresholds),
    });
  }
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

// CTL-1435 (C2): the skippedReason values that mean "the delegate proceeded with
// an OWNED anchor it could act on, yet dispatched nothing" — a real actuation
// wedge. Benign non-dispatch reasons (no-owned-anchor = nothing this host owns;
// gate-hold reasons all-green / no-free-slots / rate-limit-cliff; shadow) are
// deliberately excluded so the invariant flags the CTL-1157 failure mode, not a
// host that simply has no owned work.
// Codex round-2: "no-actuator" (an enforce pass with no `act` seam wired — a
// miswired daemon that proposes but structurally cannot dispatch) is a wedge too.
// CTL-1440 (P0b): "all-candidates-exhausted" is deliberately EXCLUDED — every
// candidate is terminally attempts-exhausted AND the exhaustion sweep has
// escalated each to a human (needs-human + brief + comment), so the delegate is
// truthfully done, not wedged.
const WEDGE_SKIP_REASONS = new Set(["all-candidates-cooldown", "act-error", "no-actuator"]);

// #7 — actuation liveness (CTL-1435 C2): the delegate's OWN wedge. Over the last
// K enforce board-scans in the ring, if EVERY one proceeded with an owned anchor
// yet dispatched nothing (skippedReason ∈ all-candidates-cooldown / act-error),
// board-health is proposing into the void — the exact CTL-1157 incident (enforce
// proposed ~15 moves/5min for days with ~zero executions, invisible in the
// journal). This is the invariant that would have caught it. It only READS the
// ring's board-scan history (C1's act-outcome), so it adds no Linear/Git I/O.
// Three false-positive guards:
//   (1) current-mode gate (Codex round-2) — observable ONLY when the host is
//       enforce RIGHT NOW. After an enforce→shadow rollback the tail still holds
//       enforce scans; without this gate a shadow host would keep flagging on that
//       stale history until it ages out, even though shadow deliberately never acts.
//   (2) ≥K guard — a short or busy event tail that holds <K enforce scans yields
//       observable:false rather than a flag on thin evidence.
//   (3) time-window bound (Codex round-2) — the K scans must ALL fall within
//       actuationLivenessWindowMs of now, so stale pre-downtime scans can't combine
//       with one fresh scan to fake a "K consecutive" run.
// The remediation is NOT here: the "kick bypassing expired latches" is B1's
// terminal-intent TTL (already shipped), and turning a sustained finding into a
// deduped Gherkin ticket is C3/C4. C2's job is DETECT + SURFACE.
function checkActuationLiveness(b, t) {
  if (b.mode !== "enforce") {
    return invariant(true, 0, false, [], "actuation liveness observable only when the host is currently enforce");
  }
  const K = t.actuationLivenessScans;
  const scans = (b.ring?.boardScans ?? []).filter((s) => s.mode === "enforce");
  if (scans.length < K) {
    return invariant(
      true,
      0,
      false,
      [],
      `insufficient enforce board-scan history (${scans.length}/${K}) → actuation liveness not observable`,
    );
  }
  const recent = scans.slice(-K);
  // Time-window guard: the oldest of the last K must be within windowMs of now, so
  // the K scans are both RECENT and CONTIGUOUS (no daemon-downtime gap folded in).
  const windowMs = t.actuationLivenessWindowMs;
  const ts = recent.map((s) => s.tsMs);
  if (ts.some((v) => !Number.isFinite(v)) || b.now - ts[0] > windowMs) {
    return invariant(
      true,
      0,
      false,
      [],
      `enforce scan window not recent/contiguous (>${Math.round(windowMs / 60_000)}m span or missing ts) → actuation liveness not observable`,
    );
  }
  // A dispatch anywhere in the window clears it; otherwise EVERY scan must be an
  // owned-but-undispatched wedge (skippedReason ∈ WEDGE_SKIP_REASONS). This catches
  // the deferred-only proceed path (proposedMoves 0) the old proposedMoves>0
  // predicate missed (Codex P2), and ignores benign no-owned-anchor/gate-hold scans.
  const wedged = recent.every(
    (s) => s.dispatched !== true && WEDGE_SKIP_REASONS.has(s.skippedReason),
  );
  return invariant(
    !wedged,
    wedged ? 1 : 0,
    true,
    [], // fleet/host-scoped anomaly, no per-ticket flagged list
    wedged
      ? `${K} consecutive enforce scans proposed moves but dispatched nothing → actuation wedged (propose-forever/dispatch-never)`
      : "board-health actuation live (recent scans dispatched or had nothing actionable)",
  );
}

// #7 — phantom merged-PR (CTL-1157). A ticket sitting in a PR/in-review Linear
// state whose linked PR has already merged/deployed — the GitHub-PR→Done
// automation was removed (multi-PR tickets falsely went Done on first merge), so
// nothing advances these now. Empty prStatusMap ⇒ observable:false (shadow-safe).
function checkPhantomMergedPr(b) {
  const map = b.prStatusMap;
  if (!(map instanceof Map) || map.size === 0) {
    return invariant(true, 0, false, [], "no PR-status map → phantom merged-PR not observable");
  }
  const flagged = [];
  for (const [id, d] of b.ticketsById) {
    const state = d.state ?? d.linear_state ?? null;
    if (!state || !PR_STATE_RE.test(String(state))) continue;
    const prNum = prNumberOf(d);
    if (prNum == null) continue;
    // CTL-1157 (Codex #4) multi-repo: resolve the ticket's repo and look up the
    // EXACT (repo, number) status. A cross-repo #-collision is disambiguated by
    // the ticket's repo; only a collision with a genuinely underivable repo stays
    // `ambiguous` and is skipped (never borrow the wrong repo's `merged` status).
    const repo = b.repoForTicket ? safeRepoOf(b.repoForTicket, id) : null;
    const pr = lookupPrStatus(map, prNum, repo);
    if (pr && pr.ambiguous) continue;
    if (pr && PR_MERGED_RE.test(String(pr.status))) flagged.push(id);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length
      ? `${flagged.length} ticket(s) in a PR state with an already-merged/deployed PR`
      : "no phantom merged-PR tickets",
  );
}

// #8 — orphaned open PR (CTL-1157). An open PR whose ticket has no live (non-
// terminal) worker and whose last activity is past the orphan-age threshold —
// "nothing rots silently". filter_state.updated_at is the last WEBHOOK, not last
// PR activity (a freshly-rebased PR has no push webhook), so this is a
// conservative SIGNAL: the delegate MUST `gh pr view` before acting. Empty map ⇒
// observable:false.
function checkOrphanedOpenPr(b, t) {
  const map = b.prStatusMap;
  if (!(map instanceof Map) || map.size === 0) {
    return invariant(true, 0, false, [], "no PR-status map → orphaned open-PR not observable");
  }
  // A worker only counts as "live" (→ NOT orphaned) when it still occupies a
  // slot. failed/stalled/aborted FREE the slot (isTicketInFlight), so a PR stuck
  // behind a dead/failed worker is exactly the orphaned case this cohort catches
  // — do NOT let a terminal-FAILURE signal mask it as "has a live worker".
  const liveTickets = new Set(
    b.signals.filter((s) => s.ticket && isLiveWorkerStatus(s.status)).map((s) => s.ticket),
  );
  const flagged = [];
  for (const [id, d] of b.ticketsById) {
    // KNOWN LIMITATION (CTL-1157, Codex round-7 — deferred to a follow-up): the ticket
    // descriptor exposes a SINGLE pr_number (ticket_state has one pr_number column) and
    // filter_state rows are keyed by webhook interest_id, not by ticket — so there is no
    // ticket→all-PRs mapping to iterate. A multi-PR ticket whose descriptor points at a
    // newer merged PR while an OLDER PR stays open therefore reads green here (a false
    // NEGATIVE — we miss the older orphan). Closing this needs a ticket→PRs data model
    // (descriptor multi-PR field or an interest_id→ticket join), out of scope for this PR.
    // Impact is bounded: shadow-only until the enforce flip, and a rare multi-PR case.
    const prNum = prNumberOf(d);
    if (prNum == null) continue;
    // CTL-1157 (Codex round-6): skip a ticket already in a terminal Linear state
    // (Done/Canceled/Duplicate). getBoard = getAllTicketDescriptors({includeRemoved:false})
    // only drops removed_at rows, NOT terminal ones, so a terminal ticket whose PR was
    // never merged/closed still carries an "open" filter_state row — without this guard
    // it becomes a tier-1 orphaned-PR anchor and gets a recovery-pass dispatched on
    // already-finished work (a wasted slot, recurring every cooldown). Mirrors the
    // terminal exclusion the frozen-needs-human + needs-human-pile cohorts already apply.
    if (isTerminalLinearState(d)) continue;
    // CTL-1157 (Codex #4) multi-repo: resolve the ticket's repo and look up the
    // EXACT (repo, number) status. With the repo known, a cross-repo #-collision
    // NO LONGER hides the ticket's genuine orphaned open PR (the missed-detection
    // bug); only a collision whose repo is genuinely underivable stays `ambiguous`.
    const repo = b.repoForTicket ? safeRepoOf(b.repoForTicket, id) : null;
    const pr = lookupPrStatus(map, prNum, repo);
    if (pr && pr.ambiguous) continue;
    if (!pr || String(pr.status).toLowerCase() !== "open") continue;
    if (liveTickets.has(id)) continue; // a worker is on it → not orphaned
    const updatedMs = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedMs) ? b.now - updatedMs : null;
    if (ageMs != null && ageMs > t.orphanedPrAgeMs) flagged.push(id);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length
      ? `${flagged.length} open PR(s) with no live worker past ${Math.round(t.orphanedPrAgeMs / 3_600_000)}h`
      : "no orphaned open PRs",
    { caveat: "filter_state.updated_at is last-webhook, not last-PR-activity — verify with gh pr view" },
  );
}

// #9 — frozen needs-human (CTL-1157, LABEL-based). A ticket carrying the
// needs-human Linear label that has not moved past the frozen-age threshold.
// Distinct from #10 needsHumanPile (STATUS-based, from the signal file). No
// labels in the cache ⇒ observable:false.
function checkFrozenNeedsHuman(b, t) {
  let haveLabels = false;
  const flagged = [];
  for (const [id, d] of b.ticketsById) {
    const labels = labelsOf(d);
    if (labels) haveLabels = true;
    if (!labels || !labels.some((l) => NEEDS_HUMAN_LABEL_RE.test(labelName(l)))) continue;
    // A Done/Canceled/Duplicate ticket can keep a stale cached needs-human label
    // until terminal-needs-human-reconcile strips it. Flagging it purely by age
    // would propose recovery for already-terminal work — mirror the reconcile's
    // terminal-state exclusion and skip it (the CTL-1157/1162 stale-label class).
    if (isTerminalLinearState(d)) continue;
    const updatedAt = d.updatedAt ?? d.updated_at ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedMs) ? b.now - updatedMs : null;
    if (ageMs != null && ageMs > t.frozenNeedsHumanMs) flagged.push(id);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    haveLabels,
    flagged,
    flagged.length
      ? `${flagged.length} needs-human ticket(s) frozen past ${Math.round(t.frozenNeedsHumanMs / 3_600_000)}h`
      : haveLabels
        ? "no frozen needs-human tickets"
        : "no labels in cache → frozen needs-human not observable",
  );
}

// #10 — needs-human pile (CTL-1157 Workstream B, STATUS-based). A worker signal
// parked at needs-human/stalled, regardless of age — checkWorkerAge requires
// past-phase-age and misses a FRESH needs-human, so this opens the holistic
// delegate's catch-all for untyped stuck items that no longer dead-end at an
// escalate latch. Always observable (it judges the signal-file status set).
function checkNeedsHumanPile(b) {
  const flagged = [];
  for (const s of b.signals) {
    if (!s.ticket) continue;
    const st = s.status != null ? String(s.status).toLowerCase() : null;
    if (!(st && NEEDS_HUMAN_STATUSES.has(st))) continue;
    // CTL-1157 F (Codex round-5): a Done/Canceled/Duplicate ticket can retain a stale
    // needs-human/stalled worker signal, and signal-reader prefers a NON-terminal
    // needs-human signal over the terminal phase signal — so without this an already-
    // terminal ticket becomes a tier-1 board-health anchor and gets a recovery-pass
    // dispatched in enforce. Mirror the label path's terminal exclusion (line ~684).
    // Fail-OPEN when the descriptor is absent (uncached): we skip ONLY when we can
    // CONFIRM the ticket is terminal, never dropping a genuinely stuck ticket.
    const d = b.ticketsById?.get?.(s.ticket) ?? null;
    if (d && isTerminalLinearState(d)) continue;
    flagged.push(s.ticket);
  }
  return invariant(
    flagged.length === 0,
    flagged.length,
    true,
    flagged,
    flagged.length ? `${flagged.length} worker(s) parked at needs-human/stalled` : "no needs-human/stalled workers",
  );
}

// ── (3) decideBoardHealth — PURE. The cheap-gate funnel. First match wins. ───
// CTL-1432 (Codex P1): the deferred board-health set must pass the SAME acceptance a
// normal anchor does before it counts as actionable / gets ranked — not an operator-
// sanctioned latch (else a sanctioned ticket that ALSO has a defer intent bypasses the
// proposeMoves suppression via the deferred path), and still a LIVE non-terminal ticket
// on the board. getBoard = getAllTicketDescriptors({includeRemoved:false}) still includes
// Done/Canceled descriptors, so a board-presence check alone isn't enough — check
// isTerminalLinearState too. (The 30-min defer cooldown is applied upstream in
// readDeferredBoardHealthIntents.) Shared by decideBoardHealth (gate count) AND
// selectAnchorCandidates (ranking) so the two never disagree.
function eligibleDeferredAnchors(board) {
  const sanctioned = new Set(board?.sanctionedNeedsHuman ?? []);
  const byId = board?.ticketsById;
  // CTL-1432 (Codex P2): HRW-ownership filter, mirroring selectAnchorCandidates — a
  // foreign-owned deferred marker must not make the gate proceed (this host would then
  // no-anchor it). N=1 / no roster / no ownerForTicket ⇒ owns everything ⇒ unchanged.
  const multiHost = !!(board?.multiHost && typeof board?.ownerForTicket === "function");
  const owns = (t) => {
    if (!multiHost) return true;
    try {
      return board.ownerForTicket(t, board.roster) === board.self;
    } catch {
      return true; // fail-open: a broken HRW read must not block self-owned actuation
    }
  };
  return (board?.deferredBoardHealth ?? []).filter((t) => {
    if (sanctioned.has(t)) return false;
    if (!owns(t)) return false;
    const d = byId && typeof byId.get === "function" ? byId.get(t) : undefined;
    if (!d) return false;
    return !isTerminalLinearState(d);
  });
}

export function decideBoardHealth(invariants, boardState) {
  const observableFailed = Object.values(invariants).filter((v) => v.observable && !v.ok);
  const invariantsFailed = observableFailed.reduce((n, v) => n + (Number(v.failed) || 0), 0);

  // CTL-1432 (B2/B3 — Codex P1): gate on ACTIONABLE work, not merely a failed
  // invariant. proposeMoves already suppresses the sanctioned needs-human latches
  // (B3), so a scan whose ONLY failure is an all-sanctioned frozenNeedsHuman produces
  // no tier1/tier2 moves → it must NOT proceed (F2: else enforce dispatches a holistic
  // pass with nothing real to do). Conversely, a deferred board-health intent (B2) is
  // actionable even when NO invariant failed → it MUST proceed (F1: boardHealthPass
  // calls selectAnchorCandidates only after "proceed", so a deferred intent that never
  // trips the gate is inert). tier3 moves are escalate-only (never anchorable by
  // selectAnchorCandidates), so they alone do not justify a holistic pass.
  const moves = proposeMoves(invariants, boardState);
  // CTL-1432 (Codex P1): count only deferred intents that pass full acceptance
  // (not sanctioned, live + non-terminal) — a since-terminal / sanctioned defer must not
  // make the gate proceed (it would proceed then no-anchor). Same helper selectAnchorCandidates uses.
  const deferred = eligibleDeferredAnchors(boardState);
  const hasActionableWork =
    moves.tier1.length > 0 || moves.tier2.length > 0 || deferred.length > 0;

  // Gate 1 — nothing actionable (all green, or every failure suppressed/escalate-only,
  // and no deferred work) → skip the holistic DISPATCH (no LLM thrash). CTL-1432 (Codex
  // P2): still return the proposed `moves` (not emptyMoves) so an escalate-only board —
  // tier3 stranded-node / project-silence — keeps surfacing those proposals in the
  // recovery.board-scan event (a human should see them); we just don't dispatch.
  if (!hasActionableWork) {
    return decision(
      "skip",
      observableFailed.length === 0 ? "all-green" : "no-actionable-moves",
      invariantsFailed,
      moves,
    );
  }
  // Gate 2 — actionable work but no free slot to dispatch a fix → skip.
  if ((boardState.capacity?.freeSlots ?? 0) <= 0) {
    return decision("skip", "no-free-slots", invariantsFailed, emptyMoves());
  }
  // Gate 3 — near a rate-limit cliff → acting now risks 429s → skip (and obey it).
  const rl = invariants.rateLimitHeadroom;
  if (rl && rl.observable && !rl.ok) {
    return decision("skip", "rate-limit-cliff", invariantsFailed, emptyMoves());
  }
  // Gate 4 — actionable work + headroom → proceed.
  const reason =
    observableFailed.length > 0
      ? `${observableFailed.length} invariant(s) flagged`
      : `${deferred.length} deferred board-health intent(s)`;
  return decision("proceed", reason, invariantsFailed, moves);
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
export function proposeMoves(invariants, _b) {
  const tier1 = [];
  const tier2 = [];
  const tier3 = [];
  // CTL-1432 (B3 + Codex P1): operator-sanctioned needs-human latches are never
  // re-proposed as ANY per-ticket move — not just the frozenNeedsHuman tier2, but also
  // the needsHumanPile tier1 (a sanctioned ticket with a live needs-human/stalled
  // worker signal), workerAge, and the PR cohorts. They stay VISIBLE in
  // frozenNeedsHuman / boardContext (suppression is HERE only, never in
  // checkFrozenNeedsHuman) so a human still sees them; they just stop drowning the
  // genuinely-stuck tickets every 5-min scan (making proposedTier1/2 a constant).
  const sanctioned = new Set(_b?.sanctionedNeedsHuman ?? []);
  const sanction = (t) => sanctioned.has(t);
  if (invariants.dispatchLiveness && !invariants.dispatchLiveness.ok) {
    tier1.push({ move: "kick-dispatch", rationale: invariants.dispatchLiveness.note });
  }
  for (const t of invariants.workerAge?.flagged ?? []) {
    if (!invariants.workerAge.ok && !sanction(t)) tier1.push({ ticket: t, move: "nudge", rationale: "worker past phase-normal age" });
  }
  if (invariants.cacheCoherence && invariants.cacheCoherence.observable && !invariants.cacheCoherence.ok) {
    tier1.push({ move: "note-cache-drift", rationale: invariants.cacheCoherence.note });
  }
  // CTL-1157: the most-actionable stuck work — phantom merged-PR tickets (judge
  // Done vs reopen) and orphaned open PRs (finish or close) — is tier1 (highest
  // anchor priority); the status-based needs-human pile is the untyped catch-all.
  for (const t of invariants.phantomMergedPr?.flagged ?? []) {
    if (!invariants.phantomMergedPr.ok && !sanction(t)) tier1.push({ ticket: t, move: "judge-done-or-reopen", rationale: "PR merged/deployed but ticket still in a PR/in-review state" });
  }
  for (const t of invariants.orphanedOpenPr?.flagged ?? []) {
    if (!invariants.orphanedOpenPr.ok && !sanction(t)) tier1.push({ ticket: t, move: "finish-or-close-pr", rationale: "open PR with no live worker past age" });
  }
  for (const t of invariants.needsHumanPile?.flagged ?? []) {
    if (!invariants.needsHumanPile.ok && !sanction(t)) tier1.push({ ticket: t, move: "holistic-triage", rationale: "worker parked at needs-human/stalled" });
  }
  for (const t of invariants.blockedTree?.flagged ?? []) {
    if (!invariants.blockedTree.ok && !sanction(t)) tier2.push({ ticket: t, move: "re-dispatch-blocker", rationale: "blocked by unscheduled/stuck blocker" });
  }
  // CTL-1157: a needs-human-LABELLED ticket frozen past 48h has already been
  // escalated once → tier2 (review, lower urgency than the actionable PR work).
  for (const t of invariants.frozenNeedsHuman?.flagged ?? []) {
    if (!invariants.frozenNeedsHuman.ok && !sanction(t)) tier2.push({ ticket: t, move: "review-needs-human", rationale: "needs-human label frozen past threshold" });
  }
  for (const h of invariants.strandedNode?.flagged ?? []) {
    if (!invariants.strandedNode.ok) tier3.push({ host: h, move: "escalate-stranded-node", rationale: "rostered node owns work but reconcile is failing" });
  }
  for (const p of invariants.projectSilence?.flagged ?? []) {
    if (!invariants.projectSilence.ok) tier3.push({ project: p, move: "escalate-project-silence", rationale: "no movement in expected cadence" });
  }
  return { tier1, tier2, tier3 };
}

// ── selectAnchor — PURE (CTL-1300). The holistic delegate's whole point is that
// ONE dispatched recovery-pass session reads the WHOLE board (via the injected
// boardContext) and keeps it moving. But the actuator we reuse
// (defaultInvokeRecoveryPass) is keyed to a single ticket — it writes
// workers/<ticket>/recovery-pass.json and dispatches a recovery-pass worker for
// that ticket. So the holistic pass needs ONE anchor ticket as the dispatch
// handle. Anchor where the work is most stuck: a flagged worker (tier-1 nudge),
// else a blocked ticket (tier-2 re-dispatch-blocker), else the top of the
// eligible queue. Returns null when the board offers no ticket handle at all
// (a pure stranded-node / project-silence anomaly with an empty queue) — the
// caller then takes no action this scan (those tier-3 moves are escalate-only).
//
// CTL-1302: the anchor MUST be one THIS host HRW-owns. Otherwise, on a multi-host
// board, picking the first flagged ticket (which may be foreign-owned) and then
// HRW-skipping at the act site stalls the whole scan even when this host owns a
// LATER flagged ticket it could act on. So we filter every candidate to self-owned
// before applying the tier-1 > tier-2 > eligible priority. Single-host (no roster /
// no ownerForTicket / multiHost false) owns everything → behavior unchanged.
// CTL-1157 (MUST-FIX 1+2): selectAnchorCandidates — PURE. Returns the ORDERED
// candidate list (most-stuck first) the act site iterates, instead of a single
// anchor that wedges the whole pass when it latches. The self-owned chain is
// byte-identical to the old firstOwned ordering (tier1 → tier2 → eligible), just
// collecting ALL of them in order. selectAnchor stays a thin wrapper over [0] so
// every existing caller is unchanged.
//
// HRW-safety: a foreign-owned flagged ticket is appended ONLY in `holistic` mode
// AND ONLY when its owner is provably unavailable (∈ strandedOrDeadHosts) — never
// unconditionally, never the eligible queue. So a healthy peer's tickets are
// never stolen (no double-dispatch on one branch). Self-owned always sorts ahead
// of foreign-failover. N=1 (no roster / no ownerForTicket / !multiHost) ⇒ owns()
// ≡ true and strandedOrDeadHosts is empty ⇒ the foreign branch is unreachable ⇒
// byte-identical to today.
export function selectAnchorCandidates(moves, board, { holistic = false, strandedOrDeadHosts = new Set() } = {}) {
  const multiHost = !!(board && board.multiHost && typeof board.ownerForTicket === "function");
  const owns = (ticket) => {
    if (!ticket) return false;
    if (!multiHost) return true;
    try {
      return board.ownerForTicket(ticket, board.roster) === board.self;
    } catch {
      return true; // fail-open: a broken HRW read must not block self-owned actuation
    }
  };
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  const ticketsOf = (arr) => (arr ?? []).map((m) => m && m.ticket).filter(Boolean);
  // self-owned chain first (unchanged tier1 > tier2 ordering).
  for (const t of ticketsOf(moves?.tier1).filter(owns)) add(t);
  for (const t of ticketsOf(moves?.tier2).filter(owns)) add(t);
  // CTL-1432 (B2, Codex P1): deferred board-health intents rank AFTER flagged work but
  // BEFORE the eligible fallback — when a scan proceeds SOLELY for a deferred intent
  // (empty moves), the deferred ticket MUST be the anchor, not an unrelated top-of-
  // eligible-queue ticket. Cross-checked against the live board (ticketsById already
  // excludes Done/removed via getBoard's includeRemoved:false), so a stale defer marker
  // whose ticket has since gone terminal is dropped rather than re-anchored.
  for (const t of eligibleDeferredAnchors(board)) add(t); // already HRW-owns-filtered
  for (const e of (board?.eligible ?? []).map((x) => x && x.id).filter(Boolean).filter(owns)) add(e);
  // holistic foreign-failover: a flagged tier1/tier2 ticket this host does NOT own,
  // ONLY when its owner is provably dead/stranded. Appended AFTER all self-owned.
  if (holistic && multiHost) {
    const ownerDead = (ticket) => {
      try {
        return strandedOrDeadHosts.has(board.ownerForTicket(ticket, board.roster));
      } catch {
        return false; // a broken HRW read must not trigger a foreign failover
      }
    };
    const failover = (arr) => ticketsOf(arr).filter((t) => !owns(t) && ownerDead(t));
    for (const t of failover(moves?.tier1)) add(t);
    for (const t of failover(moves?.tier2)) add(t);
  }
  return out;
}

export function selectAnchor(moves, board) {
  return selectAnchorCandidates(moves, board)[0] ?? null;
}

// ── (5) buildBoardContext — PURE. The whole-board brief the dispatched delegate
// gets injected into recovery-pass.json (today it gets NONE).
export function buildBoardContext(boardState, invariants) {
  // CTL-1157: the stuck-worker set is the UNION of the age-flagged workers and the
  // status-based needs-human pile (Workstream B), deduped by ticket.
  const stuckTickets = [
    ...(invariants.workerAge?.flagged ?? []),
    ...(invariants.needsHumanPile?.flagged ?? []),
  ];
  const stuckWorkers = [...new Set(stuckTickets)].map((t) => {
    const s = boardState.signals.find((x) => x.ticket === t);
    return {
      ticket: t,
      phase: s?.phase ?? null,
      status: s?.status ?? null,
      ageSeconds: s?.ageMs != null ? Math.round(s.ageMs / 1000) : null,
    };
  });
  return {
    // CTL-1157: v2 adds the three stuck cohorts (additive; readers default each
    // field to []). The skill reads them defensively, never gates on the schema.
    schema: "recovery-board-context/v2",
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
    // CTL-1157 v2: the three stuck cohorts, surfaced additively so the delegate
    // sees them without re-scanning. Empty arrays when the invariant is green /
    // not observable (shadow-safe).
    phantomPrs: invariants.phantomMergedPr?.flagged ?? [],
    orphanedPrs: invariants.orphanedOpenPr?.flagged ?? [],
    frozenNeedsHuman: invariants.frozenNeedsHuman?.flagged ?? [],
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
export function buildBoardScanEvent({ mode, invariants, decision, act = null }) {
  const totalMoves = decision.proposed.tier1 + decision.proposed.tier2 + decision.proposed.tier3;
  // CTL-1435 (C1): the actuation OUTCOME of this scan. Without it the journal shows
  // proposedMoves but never whether anything was dispatched — the blind spot behind
  // the propose-forever/dispatch-never incident. shadow/off never actuate → the
  // default records dispatched:false, skippedReason:"shadow".
  const actOutcome = {
    dispatched: act?.dispatched === true,
    anchor: act?.anchor ?? null,
    skippedReason: act?.skippedReason ?? (act?.dispatched === true ? null : "shadow"),
  };
  return {
    type: "recovery.board-scan",
    ticket: null, // board/fleet-scoped → event.label:null; the board reader ignores it (correct)
    fix_class: null,
    reason:
      `board-health scan (${mode}): ${decision.invariantsFailed} invariant(s) flagged, ` +
      `gate=${decision.gate.decision}, ${totalMoves} move(s) proposed` +
      (actOutcome.dispatched
        ? `, dispatched ${actOutcome.anchor}`
        : actOutcome.skippedReason
          ? `, no dispatch (${actOutcome.skippedReason})`
          : ""),
    details: {
      mode,
      // ── chartable scalars (CTL-1291 promoteNumericAttrs) ──
      invariantsFailed: decision.invariantsFailed,
      gateDecision: decision.gate.decision,
      gateReason: decision.gate.reason,
      proposedTier1: decision.proposed.tier1,
      proposedTier2: decision.proposed.tier2,
      proposedTier3: decision.proposed.tier3,
      // CTL-1435 (C1): 0/1 so Grafana can chart the dispatch RATE alongside the
      // proposal counts (proposed-vs-dispatched is the actuation-liveness signal).
      actDispatched: actOutcome.dispatched ? 1 : 0,
      invariants: Object.fromEntries(
        Object.entries(invariants).map(([k, v]) => [k, { ok: v.ok, failed: v.failed, observable: v.observable }]),
      ),
      // ── rosters/proposals: stay in body.payload, NEVER promoted (cardinality) ──
      flagged: dedupeFlagged(invariants),
      tier1Moves: decision.moves.tier1,
      tier2Moves: decision.moves.tier2,
      tier3Moves: decision.moves.tier3,
      // CTL-1435 (C1): the full act-outcome object. `anchor` is high-cardinality
      // (a ticket id) so it lives here in body.payload, never promoted.
      // deriveRing (C2) reads `payload.act.dispatched` from this.
      act: actOutcome,
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
  repoForTicket, // CTL-1157 (Codex #4): ticket→owner/repo resolver (daemon-bound)
  getReconcileMarkers,
  getDeferredBoardHealthTickets, // CTL-1432 (B2): deferred board-health anchor candidates
  sanctionedNeedsHuman, // CTL-1432 (B3): sanctioned needs-human latch allowlist
  getPrStatusMap, // CTL-1157: filter_state PR-status reader (daemon-bound)
  deadHosts, // CTL-1157: provably-dead host set (daemon-computed)
  lastRunMs = _lastRunMs,
  intervalMs = BOARD_HEALTH_INTERVAL_MS,
  isThrottledFn = isThrottled,
  emit = defaultEmitEvent,
  act = undefined, // ONLY reachable in enforce; the daemon injects it (CTL-1300), shadow/off never do
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
    roster, self, multiHost, capacity, readEventRing, ownerForTicket, repoForTicket, getReconcileMarkers,
    getPrStatusMap, deadHosts, mode, now,
    getDeferredBoardHealthTickets, sanctionedNeedsHuman, // CTL-1432 (B2/B3)
  });
  const invariants = evaluateInvariants(board, { mode });
  const dec = decideBoardHealth(invariants, board);

  // enforce-ONLY actuation (CTL-1300), and only if a caller injected an `act`
  // seam. SHADOW-FIRST is preserved structurally: shadow never actuates, and the
  // scheduler injects an `act` ONLY in the daemon binding (operator-gated via
  // CATALYST_BOARD_HEALTH=enforce). This is the HOLISTIC dispatch — ONE
  // recovery-pass delegate per proceeding scan, anchored to board-health's chosen
  // ticket and carrying the whole-board boardContext (the delegate reasons across
  // the WHOLE board, not once per proposed move). The actuator the scheduler binds
  // is the audited-real, capped, cooldown'd defaultInvokeRecoveryPass.
  //
  // CTL-1435 (C1): actuate FIRST and capture the OUTCOME, THEN emit — so the scan
  // event records whether a proposal became a dispatch (and, if not, a
  // machine-readable skippedReason). Emit still fires for shadow AND enforce; only
  // the ORDER (act→emit) and the added act field change. The whole enforce branch
  // is wrapped so an unexpected throw degrades to skippedReason:"act-error" and the
  // scan event still emits (previously an emit-first order made that implicit).
  let actResult;
  // Codex round-2: an enforce pass with NO actuator wired is itself an actuation
  // failure — it proposes but can never dispatch. Give it a distinct "no-actuator"
  // wedge reason (vs. shadow/off's benign "shadow") so checkActuationLiveness
  // catches a miswired daemon, not only cooldown-latching.
  let actOutcome = {
    dispatched: false,
    anchor: null,
    skippedReason: mode === "enforce" ? "no-actuator" : "shadow",
  };
  if (mode === "enforce" && typeof act === "function") {
    if (dec.gate.decision !== "proceed") {
      // the gate held (all-green / no-actionable-moves / no-free-slots / rate-limit-cliff)
      actOutcome = { dispatched: false, anchor: null, skippedReason: dec.gate.reason ?? "gate-hold" };
    } else {
      try {
        // CTL-1157 (MUST-FIX 1+2): compute the ORDERED holistic candidate list. The
        // self-owned chain comes first (byte-identical to CTL-1302's single anchor);
        // a foreign-owned flagged ticket is appended ONLY when its owner is provably
        // dead/stranded (owner ∈ strandedNode.flagged ∪ deadHosts) — never a live
        // peer's branch. The act site iterates the list and dispatches the first
        // ACTIONABLE (non-cooldown/non-latched) candidate, one per scan, so a single
        // latched anchor no longer wedges the whole flagged cohort.
        const strandedOrDeadHosts = new Set([
          ...(invariants.strandedNode?.flagged ?? []),
          ...(board.deadHosts ?? []),
        ]);
        const candidates = selectAnchorCandidates(dec.moves, board, { holistic: true, strandedOrDeadHosts });
        const anchor = candidates[0] ?? null;
        if (!anchor) {
          log({ reason: "no-owned-anchor" }, "board-health: proceed but no actionable ticket anchor — no holistic dispatch this scan");
          actOutcome = { dispatched: false, anchor: null, skippedReason: "no-owned-anchor" };
        } else {
          const boardContext = buildBoardContext(board, invariants);
          actResult = act({ anchor, candidates, boardContext, decision: dec, board }) ?? null;
          log({ anchor, candidates: candidates.length, dispatched: actResult?.dispatched ?? null }, "board-health: holistic recovery-pass delegate actuated");
          const dispatched = actResult?.dispatched === true;
          actOutcome = {
            dispatched,
            // the ACTUALLY-dispatched candidate (holisticBoardHealthAct may skip the
            // [0] anchor and dispatch a later one); fall back to the intended anchor.
            anchor: (dispatched ? actResult?.candidate : null) ?? anchor,
            skippedReason: dispatched ? null : actResult?.reason ?? "all-candidates-cooldown",
          };
        }
      } catch (err) {
        log({ err: err.message }, "board-health: act failed (continuing)");
        actOutcome = { dispatched: false, anchor: null, skippedReason: "act-error" };
      }
    }
  }

  // CTL-1435 (C1): emit AFTER actuation so the scan event carries the act outcome.
  try {
    emit(buildBoardScanEvent({ mode, invariants, decision: dec, act: actOutcome })); // shadow AND enforce
  } catch (err) {
    log({ err: err.message }, "board-health: emit failed (continuing)");
  }

  _lastRunMs = nowMs;
  return { ran: true, mode, ranAtMs: nowMs, invariants, decision: dec, act: actResult ?? null };
}
