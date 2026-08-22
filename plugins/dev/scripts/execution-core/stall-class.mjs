// stall-class.mjs — CTL-2158. THE stall classifier.
//
// Every stall in Catalyst must resolve to exactly ONE of three classes, or be
// explicitly HELD for review. This module is the single place that decides:
//
//   S — SYSTEM  provider overload, rate/account limits, tokens exhausted,
//               connectivity, executor/worker death, an artifact written late,
//               retry/cycle caps, an untidy working copy, fence/zombie trips,
//               orphan-sweep staleness.
//               → retry with backoff; if persistent, ONE fleet alert (CTL-2156).
//               ZERO per-ticket artifacts.
//   A — ASK     scope/product decisions, priority calls, approvals, credential
//               or dashboard actions only a person can take, design sign-off.
//               → ONE ask ticket carrying `blocks` to the work (CTL-2157).
//   M — MOOT    already done, superseded, no actionable plan.
//               → close.
//   HELD        ⛔ NOT a fourth disposition — it is the ABSENCE of one. A reason
//               this module cannot classify, or one whose evidence points two
//               ways at once, is HELD FOR REVIEW. It is never silently dropped,
//               never auto-retried forever, and never auto-cleared. A human (or
//               a later rule) resolves it into S/A/M.
//
// ⛔ WHY "HELD" AND NOT A DEFAULT. The measured census that motivated this epic
// found 86 items flagged as waiting on a human and 3 that genuinely were. Both
// possible defaults are wrong in a way that costs weeks:
//   - defaulting to ASK re-creates the bin this epic deletes (41 of the 86 were
//     the model provider being overloaded, escalated one ticket at a time);
//   - defaulting to SYSTEM retries a genuine judgment call forever and the
//     ticket strands SILENTLY, which is strictly worse than today.
// So an unclassifiable reason gets neither. It gets HELD, which is visible.
//
// ⛔ THE SKIP-GATE THIS MODULE OWNS (audit Gap 2). CTL-1552 normalized escalation
// to `status:"stalled"` + `stalledReason:"needs_human"`. unstuck-sweep.mjs used to
// carry a hand-typed `needs_human: {category:"skip"}` row, because without it the
// ticket routes to unknown/escalate — a path that BYPASSES the intent gate, so
// every sweep interval posts another authored Linear comment on a ticket a human
// is already holding (the CTL-638 comment-spam / write-budget failure class).
// That row is now DERIVED here, and — crucially — from a PROPERTY of the signal
// (`explanation` / `needsHumanSince` present ⇒ an escalation was already
// published) rather than from the magic string. When CTL-2159+ deletes the
// `needs_human` producer, the gate survives, because it never depended on the
// token in the first place.
//
// PURE. No IO, no imports. Every consumer injects its own evidence.

export const STALL_CLASS = Object.freeze({
  SYSTEM: "system",
  ASK: "ask",
  MOOT: "moot",
  HELD: "held",
});

/** The four classes, as a frozen list — for exhaustiveness assertions. */
export const STALL_CLASSES = Object.freeze([
  STALL_CLASS.SYSTEM,
  STALL_CLASS.ASK,
  STALL_CLASS.MOOT,
  STALL_CLASS.HELD,
]);

/** What each class means the system should DO. One action per class, no overlap. */
export const STALL_CLASS_ACTION = Object.freeze({
  [STALL_CLASS.SYSTEM]: "retry-with-backoff",
  [STALL_CLASS.ASK]: "raise-ask",
  [STALL_CLASS.MOOT]: "close",
  [STALL_CLASS.HELD]: "hold-for-review",
});

// canon — one spelling for lookup. CTL-1552 left `needs_human` and `needs-human`
// both live (board-health.mjs's NEEDS_HUMAN_STATUSES reads both), and the reason
// vocabulary mixes snake_case and kebab-case freely (`empty_branch` vs
// `orphan-sweep-stale`). Canonicalizing to kebab means ONE table row covers both
// spellings of every token — a per-spelling row is drift waiting to happen.
export function canonicalizeReason(reason) {
  return String(reason ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

// ── The exact table ──────────────────────────────────────────────────────────
// Canonical reason → class. Every token here was observed either in the
// execution-core source (STALL_CATEGORY_MAP keys, the `site:`/`reason:` literals
// at the escalation call sites, failureReason writers) or in the live unified
// event log (~/catalyst/events/2026-08.jsonl).
export const STALL_REASON_CLASS = Object.freeze({
  // ── S: retry/cycle/budget caps ────────────────────────────────────────────
  "prior-artifact-retry-exhausted": STALL_CLASS.SYSTEM,
  "prior-artifact-missing": STALL_CLASS.SYSTEM,
  "remediate-cycle-cap-exhausted": STALL_CLASS.SYSTEM,
  "escalation-ask-cap": STALL_CLASS.SYSTEM,
  "triage-redispatch-cap": STALL_CLASS.SYSTEM,
  "attempts-exhausted": STALL_CLASS.SYSTEM,
  "turn-cap-exhausted": STALL_CLASS.SYSTEM,
  "rescue-budget-exhausted": STALL_CLASS.SYSTEM,
  "codex-rate-park-exhausted": STALL_CLASS.SYSTEM,
  "ctl-932-wedged-never-started-exhausted": STALL_CLASS.SYSTEM,
  "no-probe-for-phase": STALL_CLASS.SYSTEM,

  // ── S: an artifact written late / the orphan sweep ────────────────────────
  "orphan-sweep-stale": STALL_CLASS.SYSTEM,
  "artifact-absent": STALL_CLASS.SYSTEM,
  "artifact-truncated": STALL_CLASS.SYSTEM,

  // ── S: untidy working copy / source conflict ──────────────────────────────
  "rebase-refused-dirty-tree": STALL_CLASS.SYSTEM,
  "source-conflict-ctl708-unavailable": STALL_CLASS.SYSTEM,
  "unresolvable-conflict": STALL_CLASS.SYSTEM,

  // ── S: executor / worker death, fences, zombies ───────────────────────────
  "watchdog-kill": STALL_CLASS.SYSTEM,
  "worker-oom": STALL_CLASS.SYSTEM,
  "ended-without-declaration": STALL_CLASS.SYSTEM,
  "cluster-fence-stale": STALL_CLASS.SYSTEM,
  "cluster-fence-unverified": STALL_CLASS.SYSTEM,
  "post-teardown-idle-ghost": STALL_CLASS.SYSTEM,
  "bg-job-id-missing": STALL_CLASS.SYSTEM,
  "ctl-736-no-progress-stopped": STALL_CLASS.SYSTEM,
  "ctl-932-wedged-never-started": STALL_CLASS.SYSTEM,
  "stalled-no-recovery": STALL_CLASS.SYSTEM,
  "continue-failed": STALL_CLASS.SYSTEM,
  "consecutive-dispatch-failures": STALL_CLASS.SYSTEM,
  // CTL-2159: the BARE token. The prefix row `dispatch-circuit-breaker:` below
  // covers scheduler.mjs:3330's counted form (`dispatch-circuit-breaker:7`), but
  // writeTerminalStalled records the breaker trip as the bare word — so the
  // highest-frequency dispatch failure in the system fell through every rule and
  // classified HELD. Found by the producer sweep, not by inspection.
  "dispatch-circuit-breaker": STALL_CLASS.SYSTEM,

  // ── S: provider / account / capacity ──────────────────────────────────────
  "claude-resource-shed": STALL_CLASS.SYSTEM,
  "429": STALL_CLASS.SYSTEM,

  // ── A: a person, and only a person, can move this ─────────────────────────
  "design-signoff-gate": STALL_CLASS.ASK,
  "human-scope-decision-required": STALL_CLASS.ASK,
  "boot-resume-gate": STALL_CLASS.ASK,
  "boot-resume-gate-expired": STALL_CLASS.ASK,
  "needs-human:prd-required-before-scoping": STALL_CLASS.ASK,
  "needs-human:operational-provisioning": STALL_CLASS.ASK,
  "needs-human:epic-scope-deferred-by-author": STALL_CLASS.ASK,
  "cold-start-expensive-phase-awaiting-approval": STALL_CLASS.ASK,

  // ── M: nothing left to do ─────────────────────────────────────────────────
  "empty-branch": STALL_CLASS.MOOT,
  "empty-branch-gate": STALL_CLASS.MOOT,
  "empty-branch-backstop": STALL_CLASS.MOOT,
  "no-actionable-plan": STALL_CLASS.MOOT,
  "terminal-or-merged-no-live-session": STALL_CLASS.MOOT,
  "ctl-606-superseded": STALL_CLASS.MOOT,
  "ctl-695-terminal-worker": STALL_CLASS.MOOT,

  // ⛔ NOT CLASSIFIED, DELIBERATELY. `needs_human` is CTL-1552's normalized
  // handoff token: it records THAT an escalation happened and says NOTHING about
  // why. Mapping it to ASK would manufacture the very ask this epic deletes;
  // mapping it to SYSTEM would auto-retry a genuine judgment call forever. It is
  // the canonical HELD case, and it is listed here so the intent is explicit
  // rather than an accident of table-miss.
  "needs-human": STALL_CLASS.HELD,
});

// ── Prefix rules ─────────────────────────────────────────────────────────────
// Reasons that carry a payload after a separator (`dispatch-circuit-breaker:7`,
// `already_fixed_by_CTL-1234`). Longest prefix wins; checked after the exact table.
export const STALL_REASON_PREFIX_CLASS = Object.freeze({
  "dispatch-circuit-breaker:": STALL_CLASS.SYSTEM,
  "budget:": STALL_CLASS.SYSTEM,
  "cloud:": STALL_CLASS.SYSTEM,
  "already-fixed-by-": STALL_CLASS.MOOT,
  "no-actionable-plan": STALL_CLASS.MOOT,
  "empty-branch": STALL_CLASS.MOOT,
  "needs-human:": STALL_CLASS.ASK,
});

// ── Family patterns ──────────────────────────────────────────────────────────
// Last resort before HELD, for tokens no table row anticipated. Applied to the
// canonical reason.
//
// ⛔ The families are NOT ordered by precedence. If two of them match, the answer
// is HELD, not "whichever I listed first". A reason that reads as both a capacity
// problem and an approval gate is exactly the case where guessing is expensive
// (see the header). Ambiguity is a verdict here, not a tiebreak.
export const STALL_FAMILY_PATTERNS = Object.freeze({
  [STALL_CLASS.SYSTEM]:
    /(rate-?limit|429|5\d\d|overload|throttl|capacity|quota|usage-limit|token.{0,4}exhaust|exhaust|retry|cycle-cap|backoff|timeout|timed-out|network|econn|etimedout|socket|dns|unreachable|offline|disconnect|oom|killed|crash|died|death|zombie|fence|orphan|stale|dirty-tree|untidy|flake|flaky|pre-push-hook|hook-failed|transient|infra|executor)/,
  [STALL_CLASS.ASK]:
    /(approval|approve|authoriz|sign-?off|scope|priorit|product-decision|credential|secret-rotation|dashboard|provision|prd|design-review|owner-input|judgment)/,
  [STALL_CLASS.MOOT]:
    /(already-(fixed|done|merged|landed|handled)|superseded|obsolete|duplicate|no-actionable|empty-branch|moot|nothing-to-do|not-reproducible)/,
});

// ── Terminal-escalation reasons ──────────────────────────────────────────────
// Reasons whose producer ALREADY published a COMPLETE escalation (label + brief +
// Linear comment) before writing the signal. A sweep that re-escalates one of
// these posts a second authored comment on a ticket a human is already holding.
//
// This set is the BACKWARD-COMPATIBLE half of the gate: it recognises signals
// already on disk, written before ESCALATION_PUBLISHED_FIELD existed. It is
// byte-identical to the four hand-typed rows it replaces in unstuck-sweep.mjs.
export const TERMINAL_ESCALATION_REASONS = Object.freeze(
  new Set([
    "needs-human",
    "escalation-ask-cap",
    "boot-resume-gate-expired",
    "no-probe-for-phase",
  ]),
);

// ESCALATION_PUBLISHED_FIELD — the FORWARD half of the same gate: an explicit
// signal field the four publishing producers set, so the gate needs no token.
//
// ⛔ IT MUST BE THIS EXPLICIT, and NOT the tempting `signal.explanation != null`.
// scheduler.mjs's generic stall writer (`stalledReason: reason, explanation,
// needsHumanSince`) attaches a coerced explanation to EVERY stall it records —
// including `remediate-cycle-cap-exhausted` and `prior-artifact-retry-exhausted`,
// which the sweep is supposed to keep acting on. Keying the gate on the presence
// of an explanation would therefore silence the sweep's repair actions wholesale
// while looking like a tidy refactor: the sweep would go quiet and report nothing,
// which is indistinguishable from "there was nothing to do".
export const ESCALATION_PUBLISHED_FIELD = "escalationPublished";

function tableLookup(canonical) {
  if (Object.hasOwn(STALL_REASON_CLASS, canonical)) {
    return { klass: STALL_REASON_CLASS[canonical], rule: `exact:${canonical}` };
  }
  // Longest prefix wins, so `needs-human:` beats a hypothetical `needs-`.
  let best = null;
  for (const [prefix, klass] of Object.entries(STALL_REASON_PREFIX_CLASS)) {
    if (!canonical.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, klass };
  }
  if (best) return { klass: best.klass, rule: `prefix:${best.prefix}` };

  const hits = [];
  for (const klass of [STALL_CLASS.SYSTEM, STALL_CLASS.ASK, STALL_CLASS.MOOT]) {
    if (STALL_FAMILY_PATTERNS[klass].test(canonical)) hits.push(klass);
  }
  if (hits.length === 1) return { klass: hits[0], rule: `family:${hits[0]}` };
  if (hits.length > 1) {
    return { klass: STALL_CLASS.HELD, rule: `ambiguous:${hits.join("+")}` };
  }
  return { klass: STALL_CLASS.HELD, rule: "unclassified" };
}

function isValidClass(v) {
  return typeof v === "string" && STALL_CLASSES.includes(v);
}

/**
 * classifyStall — PURE. Resolve one stall to exactly one class.
 *
 * Evidence (all optional; every field is injected, nothing is read from disk):
 *   reason      the stall reason token. Falls back to signal.stalledReason,
 *               then signal.failureReason.
 *   signal      the phase-signal object, if the caller has one. Read for
 *               `stallClass` (a producer that already classified), `explanation`
 *               and `needsHumanSince` (an escalation was already published).
 *   explanation the EscalationPayload, when the caller holds it separately.
 *   site        the escalation call site (`terminal-sweep`, `watchdog-kill`, …).
 *               Advisory only — recorded on the verdict, never classified from,
 *               because a site says WHO escalated, not WHY.
 *
 * Returns a frozen verdict — ALWAYS an object, never null:
 *   { klass, action, rule, reason, canonicalReason, site,
 *     held, terminallyEscalated, manufactured }
 *
 *   held                  klass === "held". No disposition was provable.
 *   terminallyEscalated   a complete escalation already exists for this stall;
 *                         no actor may publish another per-ticket artifact.
 *   manufactured          the explanation was produced by coerceExplanation's
 *                         degrade branch (`degraded:true`) — the prose is a
 *                         template, not a real human question. Never promotes a
 *                         stall to ASK.
 */
export function classifyStall(evidence = {}) {
  const { signal = null, explanation = null, site = null } = evidence ?? {};

  const rawReason =
    evidence?.reason ?? signal?.stalledReason ?? signal?.failureReason ?? null;
  const canonical = canonicalizeReason(rawReason);

  const expl = explanation ?? signal?.explanation ?? null;
  const manufactured = expl != null && expl.degraded === true;

  // A complete escalation already exists. Two halves, both required:
  //   forward  — the producer stamped ESCALATION_PUBLISHED_FIELD (survives the
  //              deletion of the `needs_human` token);
  //   backward — the reason is one of the four legacy terminal tokens (covers
  //              every signal already on disk).
  const terminallyEscalated =
    signal?.[ESCALATION_PUBLISHED_FIELD] === true ||
    TERMINAL_ESCALATION_REASONS.has(canonical);

  const base = {
    reason: rawReason,
    canonicalReason: canonical === "" ? null : canonical,
    site: site ?? null,
    terminallyEscalated,
    manufactured,
  };

  // 1. A producer that already classified wins — it had evidence we do not.
  //    Guarded: an unrecognised value is NOT trusted, it falls through.
  if (isValidClass(signal?.stallClass)) {
    return freezeVerdict({ ...base, klass: signal.stallClass, rule: "signal:stallClass" });
  }

  // 2. No reason at all ⇒ HELD. "I could not look" is not "nothing is wrong".
  if (canonical === "") {
    return freezeVerdict({ ...base, klass: STALL_CLASS.HELD, rule: "no-reason" });
  }

  const { klass, rule } = tableLookup(canonical);

  // 3. A manufactured explanation can never CREATE an ask. coerceExplanation's
  //    degrade branch writes "priority call the agent cannot make unilaterally"
  //    for any unexplained worker death — that sentence is a template, not
  //    evidence of a human decision. If the REASON independently proves ASK we
  //    keep it (the reason is trustworthy even when the prose is generated);
  //    if the reason proved nothing, a degraded explanation does not get to
  //    upgrade the verdict out of HELD.
  if (manufactured && klass === STALL_CLASS.HELD) {
    return freezeVerdict({ ...base, klass: STALL_CLASS.HELD, rule: "manufactured-escalation" });
  }

  return freezeVerdict({ ...base, klass, rule });
}

function freezeVerdict(v) {
  return Object.freeze({
    ...v,
    action: STALL_CLASS_ACTION[v.klass],
    held: v.klass === STALL_CLASS.HELD,
  });
}

/** True when a verdict carries no disposition and must be reviewed by a person. */
export function isHeldForReview(verdict) {
  return verdict?.klass === STALL_CLASS.HELD;
}

/**
 * stallClassSignalFields — the fields a producer merges into a phase signal so
 * the class is DURABLE and visible on disk. Additive: it never touches `status`
 * or `stalledReason`, so every existing consumer of those is unchanged.
 */
export function stallClassSignalFields(verdict) {
  if (!verdict || !isValidClass(verdict.klass)) return {};
  return {
    stallClass: verdict.klass,
    stallClassRule: verdict.rule,
    ...(verdict.manufactured ? { stallClassManufactured: true } : {}),
  };
}

/**
 * stallSweepDisposition — the skip-gate the unstuck sweep consults, derived from
 * the classifier instead of a hand-typed reason row (audit Gap 2).
 *
 * Returns unstuck-sweep's `{category, action, reason}` shape when the sweep must
 * stay QUIET, or null to let the sweep's own STALL_CATEGORY_MAP route the stall.
 *
 * ⛔ QUIET ON `terminallyEscalated` AND NOTHING ELSE. It is tempting to also
 * silence ASK / MOOT / HELD here — the sweep cannot act on any of them. Do not.
 * Until the producers are re-pointed at the ask path, the sweep's escalate branch
 * is the ONLY thing that makes an unclassified stall visible at all, and a
 * classifier that silences it ships the plan's named worst outcome: a genuinely
 * stuck ticket with no label, no ask, no alert and no retry — silent, and
 * therefore unnoticed for weeks. HELD means "a person must look", which is the
 * opposite of "say nothing". SYSTEM/ASK/MOOT routing is what the producer
 * re-point consumes; it is deliberately NOT wired into this gate.
 *
 * So: byte-identical sweep behaviour to the four hand-typed skip rows this
 * replaces — but keyed on a PROPERTY of the signal (an escalation payload
 * exists) rather than on the string `needs_human`, so the gate survives that
 * token's deletion.
 */
export function stallSweepDisposition(evidence = {}) {
  const verdict = classifyStall(evidence);
  if (verdict.terminallyEscalated) {
    return { category: "skip", action: "skip", reason: "already-escalated" };
  }
  return null;
}
