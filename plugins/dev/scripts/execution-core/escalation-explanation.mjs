// escalation-explanation.mjs — CTL-1130: escalation typed-union contract.
// Single source of truth for all escalation write sites. Pure, no I/O.
//
// Tagged union discriminated by escalation_type: 'manual' | 'authorization' | 'decision'
//   Common (every type):  escalation_type, problem, call_to_action
//                         + optional passthrough: observed?, attempts?
//   MANUAL:        blocked_capability, instructions[], remediation_then_retry, why_not_auto
//   AUTHORIZATION: recommendation, risk, why_asking, could_higher_tier_resolve (boolean),
//                  authorize_label
//   DECISION:      options[{label,tradeoff,risk?}] (≥2), why_you  (NO recommendation)
//
//   - validateExplanation(obj, ctx?)  -> { valid, errors[] }   (pure predicate)
//   - buildExplanation(fields)        -> frozen valid object    (throws if invalid)
//   - coerceExplanation(fields, ctx)  -> frozen valid object    (never throws; degrades)
//   - tierProducer(model, triedTiers, maxTier) -> boolean       (could_higher_tier_resolve)
//   - buildRemediateCapExplanation(verifyJson, opts) -> frozen AUTHORIZATION

const VALID_TYPES = new Set(["manual", "authorization", "decision"]);

// Common required string fields (every type)
const REQUIRED_COMMON = ["problem", "call_to_action"];

// Per-type required field names
const REQUIRED_BY_TYPE = {
  manual:        ["blocked_capability", "instructions", "remediation_then_retry", "why_not_auto"],
  authorization: ["recommendation", "risk", "why_asking", "could_higher_tier_resolve", "authorize_label"],
  decision:      ["options", "why_you"],
};

// Tautological call_to_action patterns — operator gets no decision from these.
const TAUTOLOGY_RE =
  /^(this |it )?(requires?|needs?|escalate[sd]? to|page|ask)( a| the)? (human|operator|person|someone)( to (decide|intervene|look))?\.?$/i;
const VAGUE_RE = /^(needs?|requires?) (human|manual) (intervention|action|review)\.?$/i;
const DEFER_RE =
  /^(a |the )?(human|operator|person|someone) (must|should|needs? to|has to) (decide|intervene|review|act|handle|look)\.?$/i;

// Bare-platitude risk/why_not_auto patterns — anchored ^…$ so an embedded
// phrase in a longer concrete sentence is accepted (D4).
const RISK_VAGUE_RE =
  /^(involves?\s+trade-?offs?|no\s+single\s+(automated\s+)?fix\s+path.*|requires?\s+human\s+judg?ment.*|no\s+actionable\s+diagnosis\s+available)$/i;

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Derives could_higher_tier_resolve from tier history or model ceiling.
// Production emits false until per-worker tier history is threaded (follow-up).
export function tierProducer(model, triedTiers, maxTier) {
  if (Array.isArray(triedTiers) && triedTiers.length > 0 && maxTier) {
    return !triedTiers.includes(maxTier);
  }
  return false;
}

export function validateExplanation(e, ctx = {}) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return { valid: false, errors: ["explanation: not an object"] };
  }

  // Discriminant — must be a valid type before per-type checks
  const type = e.escalation_type;
  if (!VALID_TYPES.has(type)) {
    errors.push(
      `escalation_type: must be 'manual', 'authorization', or 'decision' (got ${JSON.stringify(type)})`,
    );
  }

  // Common required string fields
  for (const k of REQUIRED_COMMON) {
    if (typeof e[k] !== "string" || e[k].trim() === "") {
      errors.push(`${k}: missing or empty`);
    }
  }

  // Tautology gate on call_to_action
  if (typeof e.call_to_action === "string" && e.call_to_action.trim() !== "") {
    const q = norm(e.call_to_action);
    if (TAUTOLOGY_RE.test(q) || VAGUE_RE.test(q) || DEFER_RE.test(q)) {
      errors.push("call_to_action: tautological — names no decision");
    }
    if (q === norm(e.problem)) {
      errors.push("call_to_action: merely restates problem");
    }
  }

  // Per-type required fields — only run when type is valid (D3: accumulate all errors)
  if (VALID_TYPES.has(type)) {
    if (type === "manual") {
      if (typeof e.blocked_capability !== "string" || e.blocked_capability.trim() === "") {
        errors.push("blocked_capability: missing or empty");
      }
      if (!Array.isArray(e.instructions) || e.instructions.length === 0) {
        errors.push("instructions: must be a non-empty array");
      }
      if (typeof e.remediation_then_retry !== "string" || e.remediation_then_retry.trim() === "") {
        errors.push("remediation_then_retry: missing or empty");
      }
      if (typeof e.why_not_auto !== "string" || e.why_not_auto.trim() === "") {
        errors.push("why_not_auto: missing or empty");
      } else if (RISK_VAGUE_RE.test(norm(e.why_not_auto))) {
        // D3: accumulate — fires even when other per-type fields are missing
        errors.push("why_not_auto: vague — names no concrete capability boundary (RISK_VAGUE_RE)");
      }
    } else if (type === "authorization") {
      if (typeof e.recommendation !== "string" || e.recommendation.trim() === "") {
        errors.push("recommendation: missing or empty");
      }
      if (typeof e.risk !== "string" || e.risk.trim() === "") {
        errors.push("risk: missing or empty");
      } else if (RISK_VAGUE_RE.test(norm(e.risk))) {
        errors.push("risk: vague — names no concrete risk (RISK_VAGUE_RE)");
      }
      if (typeof e.why_asking !== "string" || e.why_asking.trim() === "") {
        errors.push("why_asking: missing or empty");
      }
      if (typeof e.could_higher_tier_resolve !== "boolean") {
        errors.push("could_higher_tier_resolve: must be a boolean");
      }
      if (typeof e.authorize_label !== "string" || e.authorize_label.trim() === "") {
        errors.push("authorize_label: missing or empty");
      }
    } else if (type === "decision") {
      if (!Array.isArray(e.options) || e.options.length < 2) {
        errors.push("options: must be an array with ≥2 elements");
      } else {
        for (let i = 0; i < e.options.length; i++) {
          const opt = e.options[i];
          if (!opt || typeof opt !== "object") {
            errors.push(`options[${i}]: must be an object`);
            continue;
          }
          if (typeof opt.label !== "string" || opt.label.trim() === "") {
            errors.push(`options[${i}].label: missing or empty`);
          }
          if (typeof opt.tradeoff !== "string" || opt.tradeoff.trim() === "") {
            errors.push(`options[${i}].tradeoff: missing or empty`);
          }
        }
      }
      if (typeof e.why_you !== "string" || e.why_you.trim() === "") {
        errors.push("why_you: missing or empty");
      }
      // DECISION forbids recommendation
      if (typeof e.recommendation === "string" && e.recommendation.trim() !== "") {
        errors.push("recommendation: DECISION type must not include a recommendation");
      }
    }

    // Anti-delegation guard (D2): key off canExecute boolean only — never scan instructions
    if ((type === "manual" || type === "authorization") && ctx.canExecute === true) {
      errors.push(
        "anti-delegation: canExecute:true but type is manual/authorization — agent can act; reclassify as authorization or decision",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function buildExplanation(fields) {
  const e = normalizeShape(fields);
  const { valid, errors } = validateExplanation(e);
  if (!valid) throw new Error(`buildExplanation: invalid — ${errors.join("; ")}`);
  return Object.freeze(e);
}

export function coerceExplanation(fields, ctx = {}) {
  const e = normalizeShape(fields);
  const { valid } = validateExplanation(e, ctx);
  if (valid) return Object.freeze(e);

  // Degrade: never manual. Authorization iff canExecute confirmed, else decision.
  const type = ctx.canExecute === true ? "authorization" : "decision";
  const ticket = ctx.ticket ?? "this ticket";
  const phase = ctx.phase ? ` ${ctx.phase} phase` : "";

  // Preserve valid raw field values when present
  const rawProblem =
    (typeof fields.problem === "string" && fields.problem.trim()) ? fields.problem :
    (typeof fields.what_failed === "string" && fields.what_failed.trim()) ? fields.what_failed :
    `unexplained failure in ${ticket}${phase}`;

  const rawCta =
    (typeof fields.call_to_action === "string" && fields.call_to_action.trim()) ? fields.call_to_action :
    (typeof fields.human_question === "string" && fields.human_question.trim()) ? fields.human_question :
    null;
  const ctaNorm = rawCta ? norm(rawCta) : null;
  const ctaIsTautological =
    ctaNorm != null &&
    (TAUTOLOGY_RE.test(ctaNorm) || VAGUE_RE.test(ctaNorm) || DEFER_RE.test(ctaNorm));
  const ctaIsSameProblem = ctaNorm != null && ctaNorm === norm(rawProblem);

  // CTL-1647: REFUSE to fabricate a human decision for a transient
  // infrastructure cause. The degrade branches below invent options, a
  // recommendation and a "priority call the agent cannot make unilaterally"
  // rationale for ANY failure that arrives without a real explanation — but a
  // provider 429/529 is not a priority call, it is capacity that comes back on
  // its own. The primary fix is upstream (the terminal sweep backs off and
  // re-arms the phase instead of parking it); this is the backstop for a
  // transient park that still reaches the template, and it tells the human the
  // TRUTH: the automatic window is spent, confirm it or re-dispatch it.
  //
  // ⚠️ Gated on the STRUCTURED reason field only — never on `problem` prose.
  // escalation-explain.mjs and label-guard.mjs route agent-authored explanation
  // text through here, so matching prose would silently rewrite a genuine human
  // escalation that merely mentions "rate limit" into an all-clear.
  //
  // Scoped to the DECISION arm (ctx.canExecute !== true) on purpose: that is the
  // arm label-guard hardcodes and the one the 41 tickets took, and `manual` is
  // invalid under the anti-delegation guard when canExecute is true.
  const transientReason =
    type === "decision"
      ? ([ctx.reason, fields.reason].find((c) => isTransientInfraReason(c)) ?? null)
      : null;
  if (transientReason !== null) {
    return buildTransientExhaustedExplanation(
      ticket,
      transientReason,
      typeof ctx.transientAttempts === "number" ? ctx.transientAttempts : 0,
    );
  }

  const degraded = { escalation_type: type, problem: rawProblem };

  if (type === "authorization") {
    degraded.call_to_action =
      rawCta && !ctaIsTautological && !ctaIsSameProblem
        ? rawCta
        : `authorize ${ticket}${phase} to retry: ${rawProblem} — approve continuation or cancel?`;
    degraded.recommendation =
      (typeof fields.recommendation === "string" && fields.recommendation.trim())
        ? fields.recommendation
        : `retry ${ticket}${phase}`;
    const rawRisk = typeof fields.risk === "string" ? fields.risk : "";
    degraded.risk =
      rawRisk.trim() && !RISK_VAGUE_RE.test(norm(rawRisk))
        ? rawRisk
        : `unknown risk in ${ticket}${phase} — prior failure context unavailable`;
    degraded.why_asking =
      (typeof fields.why_asking === "string" && fields.why_asking.trim())
        ? fields.why_asking
        : "risk-authority gate";
    degraded.could_higher_tier_resolve =
      typeof fields.could_higher_tier_resolve === "boolean"
        ? fields.could_higher_tier_resolve
        : tierProducer(ctx.model, ctx.tried_tiers, ctx.maxTier);
    degraded.authorize_label =
      (typeof fields.authorize_label === "string" && fields.authorize_label.trim())
        ? fields.authorize_label
        : `retry ${ticket}`;
  } else {
    // decision
    degraded.call_to_action =
      rawCta && !ctaIsTautological && !ctaIsSameProblem
        ? rawCta
        : `Review ${ticket}${phase}: ${rawProblem} — decide whether to retry, hand off, or cancel.`;
    const hasValidOptions =
      Array.isArray(fields.options) &&
      fields.options.length >= 2 &&
      fields.options.every(
        (o) =>
          o &&
          typeof o.label === "string" && o.label.trim() &&
          typeof o.tradeoff === "string" && o.tradeoff.trim(),
      );
    degraded.options = hasValidOptions
      ? fields.options
      : [
          { label: "retry", tradeoff: "may hit the same failure again" },
          { label: "cancel / re-scope", tradeoff: "loses partial progress" },
        ];
    degraded.why_you =
      (typeof fields.why_you === "string" && fields.why_you.trim())
        ? fields.why_you
        : `priority call the agent cannot make unilaterally for ${ticket}${phase}`;
  }

  // Optional passthrough fields (D1)
  if (fields.observed != null && typeof fields.observed === "object" && !Array.isArray(fields.observed)) {
    degraded.observed = fields.observed;
  }
  if (Array.isArray(fields.attempts)) degraded.attempts = fields.attempts;

  degraded.degraded = true;
  return Object.freeze(degraded);
}

// CTL-1130: map a verify.json into an AUTHORIZATION explanation for
// remediate-cycle-cap-exhausted stalls. GATE 2: agent can act (retry verify),
// only risk (regression) stops it.
export function buildRemediateCapExplanation(verifyJson, { ticket, cycleCount, triedTiers, maxTier } = {}) {
  const v = verifyJson && typeof verifyJson === "object" ? verifyJson : {};
  const findings = Array.isArray(v.findings) ? v.findings : [];
  const highs = findings.filter((f) => f?.severity === "high");
  const blocker = highs[0];

  const problem = blocker
    ? `verify still failing after ${cycleCount ?? "?"} remediation cycles. Blocking: ${blocker.file ?? "?"}:${blocker.line ?? "?"} — ${blocker.message ?? "(no message)"}`
    : `verify still failing after ${cycleCount ?? "?"} remediation cycles. regression_risk ${v.regression_risk ?? "?"} above threshold with no HIGH finding`;

  const callToAction = blocker
    ? `${ticket}: verify keeps failing on ${blocker.file ?? "?"}:${blocker.line ?? "?"} (${blocker.message ?? "blocking finding"}). Fix it on the branch, or abandon / re-scope?`
    : `${ticket}: verify keeps failing after ${cycleCount ?? "?"} fix attempts (regression_risk ${v.regression_risk ?? "?"}). Fix on the branch, or abandon / re-scope?`;

  const recommendation = blocker
    ? `fix ${blocker.file ?? "?"}:${blocker.line ?? "?"} — ${blocker.recommendation ?? blocker.message ?? "see HIGH finding"}`
    : `lower regression_risk below threshold (current: ${v.regression_risk ?? "?"})`;

  const risk = blocker
    ? `HIGH finding at ${blocker.file ?? "?"}:${blocker.line ?? "?"} remains after ${cycleCount ?? "?"} cycles — merging risks a regression`
    : `regression_risk ${v.regression_risk ?? "?"} exceeds threshold after ${cycleCount ?? "?"} cycles`;

  const fields = {
    escalation_type: "authorization",
    problem,
    call_to_action: callToAction,
    recommendation,
    risk,
    why_asking: "risk-authority gate, not a capability gap",
    could_higher_tier_resolve: tierProducer(undefined, triedTiers, maxTier),
    authorize_label: `continue ${ticket ?? "verify"} verify`,
    observed: {
      regression_risk: typeof v.regression_risk === "number" ? v.regression_risk : null,
      highFindingCount: highs.length,
      highFindings: highs.slice(0, 5).map((f) => ({
        file: f.file,
        line: f.line,
        kind: f.kind,
        message: f.message,
        recommendation: f.recommendation,
      })),
    },
    attempts: [`${cycleCount ?? 0} verify⇄remediate cycles (cap reached)`],
  };

  // buildExplanation throws; try-catch degrades on bad input (should not happen
  // with well-formed inputs, but guards against missing fields from novel callers)
  try {
    return buildExplanation(fields);
  } catch {
    return coerceExplanation(fields, { ticket, phase: "verify", canExecute: true });
  }
}

function normalizeShape(f = {}) {
  const type = typeof f.escalation_type === "string" ? f.escalation_type : "";
  const base = {
    escalation_type: type,
    problem: typeof f.problem === "string" ? f.problem : "",
    call_to_action: typeof f.call_to_action === "string" ? f.call_to_action : "",
  };

  // Optional passthrough fields (D1) — carried through when present on any type
  if (f.observed != null && typeof f.observed === "object" && !Array.isArray(f.observed)) {
    base.observed = f.observed;
  }
  if (Array.isArray(f.attempts)) base.attempts = f.attempts;

  // Per-type fields
  if (type === "manual") {
    base.blocked_capability = typeof f.blocked_capability === "string" ? f.blocked_capability : "";
    base.instructions = Array.isArray(f.instructions) ? f.instructions : [];
    base.remediation_then_retry =
      typeof f.remediation_then_retry === "string" ? f.remediation_then_retry : "";
    base.why_not_auto = typeof f.why_not_auto === "string" ? f.why_not_auto : "";
  } else if (type === "authorization") {
    base.recommendation = typeof f.recommendation === "string" ? f.recommendation : "";
    base.risk = typeof f.risk === "string" ? f.risk : "";
    base.why_asking = typeof f.why_asking === "string" ? f.why_asking : "";
    base.could_higher_tier_resolve =
      typeof f.could_higher_tier_resolve === "boolean" ? f.could_higher_tier_resolve : undefined;
    base.authorize_label = typeof f.authorize_label === "string" ? f.authorize_label : "";
  } else if (type === "decision") {
    base.options = Array.isArray(f.options) ? f.options : [];
    base.why_you = typeof f.why_you === "string" ? f.why_you : "";
    // Preserve recommendation field so validation can reject it (DECISION forbids it)
    if (typeof f.recommendation === "string" && f.recommendation.trim() !== "") {
      base.recommendation = f.recommendation;
    }
  }

  return base;
}

// ── CTL-1754: the reason an escalation reports ──────────────────────────────
//
// ⛔ THE DEFECT THIS EXISTS TO FIX. The terminal-sweep escalation built its
// operator card from ONE key — `signal.stalledReason` — and that key is written
// by exactly one production path (`unstuck-act-seams.mjs`, for the single value
// `source_conflict_ctl708_unavailable`). Every other failed/stalled signal the
// pipeline produces carries its reason under a DIFFERENT key, so the card read
// "(no reason)" while the reason sat in the same file.
//
// Measured across every `failed`/`stalled` phase signal on both fleet hosts
// (44 signals, 2026-08-19):
//
//     stalledReason     0     ⛔ the key the card read
//     attentionReason  26
//     failureReason    18
//     no reason at all  0     ⭐ every signal HAS a reason
//
// 41 consecutive escalations reported "(no reason)". None of them lacked one.
//
// ⚠️ ORDER IS NOT LOAD-BEARING, and saying so is the honest claim: on the
// measured population `failureReason` and `attentionReason` NEVER co-occur
// (0 signals carry both), so their relative order is unobservable today.
// `stalledReason` stays FIRST because it is the deliberate, specific stall
// reason and must not be masked when a path does write it.
//
// ⭐ THREE-VALUED ON PURPOSE — not a `??` chain. "the signal records no reason"
// and "I could not read the signal at all" are different facts, and collapsing
// them into one "(no reason)" string is exactly how this defect survived 41
// instances: an unreadable signal and a reasonless one produced byte-identical
// cards, so no operator could tell a missing worker dir from a missing field.
//
// ⛔⛔ READ BOTH LEVELS — AND THIS IS WHY THE ORIGINAL BUG WAS UNCONDITIONAL.
// The scheduler does not hand this function the on-disk JSON. It hands it the
// CANONICAL PROJECTION from `signal-reader.mjs` `parseSignal`, which promotes
// exactly: ticket, layout, signalPath, phase, status, liveness, updatedAt, pr,
// worktreePath, host, raw. NO reason key is promoted — all three live only
// under `.raw`. So `signal.stalledReason` was undefined for EVERY signal
// regardless of what was on disk: even the one path that does write
// `stalledReason` (unstuck-act-seams.mjs) could never have surfaced through
// this card. The disk census explains why the field is rare; the projection
// explains why the card was empty 41 times out of 41.
//
// ⚠️ A fixture shaped like the on-disk JSON therefore CANNOT prove this works —
// the function never receives that shape in production. `signal.outcome ??
// signal.raw?.outcome` in signal-reader.mjs is the existing precedent for
// reading both levels, and this follows it. Credit: Codex, #3699 P1.

/** Keys that carry a failure/stall reason on a phase signal, in ladder order. */
export const SIGNAL_REASON_KEYS = Object.freeze([
  "stalledReason", // deliberate stall (unstuck-act-seams); rare but most specific
  "failureReason", // the abandon/fail path — e.g. "ended-without-declaration"
  "attentionReason", // the attention path — e.g. "sdk-overloaded-exhausted"
]);

/**
 * Resolve why a phase signal is failed/stalled.
 *
 * @param {object|null|undefined} signal a parsed phase signal, or null/undefined
 *   when the worker dir had no signal (a `signalByTicket.get()` miss).
 * @returns {{reason: string|null, key: string|null, status: "named"|"absent"|"unreadable"}}
 *   - `named`      a reason was found; `key` says which field supplied it
 *   - `absent`     the signal is readable and records no reason
 *   - `unreadable` there is no signal object to inspect
 *   Never throws — this sits on the escalation write path, and a resolver that
 *   throws would suppress the very card it exists to improve.
 */
export function resolveSignalReason(signal) {
  if (signal === null || signal === undefined || typeof signal !== "object") {
    return { reason: null, key: null, status: "unreadable" };
  }
  const raw = signal.raw;
  const nested = raw !== null && typeof raw === "object" ? raw : null;
  for (const key of SIGNAL_REASON_KEYS) {
    // Top level first, then `.raw` — the canonical projection carries the
    // reason ONLY under `.raw`, while a hand-built or on-disk-shaped object
    // carries it at the top. Both must resolve or the fix is inert.
    for (const candidate of [signal[key], nested?.[key]]) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return { reason: candidate.trim(), key, status: "named" };
      }
    }
  }
  return { reason: null, key: null, status: "absent" };
}

/**
 * The parenthetical an operator card shows for a signal's reason. Keeps the
 * three states distinguishable in the rendered text — an operator reading
 * "signal unreadable" knows to look for a missing worker dir, where
 * "no reason recorded" says the dir is there and the field is not.
 */
export function describeSignalReason(signal) {
  const r = resolveSignalReason(signal);
  if (r.status === "named") return r.reason;
  return r.status === "unreadable" ? "signal unreadable" : "no reason recorded";
}

// ── CTL-1647: transient infrastructure causes are NOT human decisions ────────
//
// A provider that returns 429/529 (overloaded / out of capacity / rate limited)
// is a SYSTEM-level condition: it resolves by itself when capacity returns, and
// the correct response is ONE fleet alert plus a bounded retry — never N
// per-ticket human blocks. 41 of 79 tickets measured parked as "a human must
// decide" on 2026-08-21 died exactly this way.
//
// This is a CLASSIFIER over the reason string only. The retry MECHANISM is the
// existing one: the producer stamps `retrySafe: true` on the phase signal
// (CTL-1679), recovery-reasoning's retry_safe_redispatch rule re-dispatches it
// within the shared bounded budget, and an exhausted budget escalates with a
// real coverage-gap explanation. Nothing new is invented here.

/**
 * The CLOSED SET of producer reason literals that name a transient
 * provider/infrastructure condition. EXACT match only — deliberately NOT a
 * substring/prose regex.
 *
 * ⚠️ This predicate feeds paths that SUPPRESS a human escalation, so a false
 * positive is the same defect class this ticket fixes, pointed the other way: a
 * genuine human escalation whose prose merely mentions "rate limit", "429" or
 * "overloaded" (e.g. "the API client we're building has no rate limit handling")
 * must NEVER be silently rewritten into "nothing is required". Agent-authored
 * prose reaches `coerceExplanation` via escalation-explain.mjs and
 * label-guard.mjs, so free-text matching here is unsafe by construction.
 *
 * Add a literal here only when a PRODUCER writes it as a signal reason.
 */
export const TRANSIENT_INFRA_REASONS = Object.freeze([
  "sdk-overloaded-exhausted", // sdk-run-phase-agent.mjs 429/529 ladder exhausted
  "codex-rate-park-exhausted", // codex-run-phase-agent.mjs rate-park exhausted
]);
const TRANSIENT_INFRA_SET = new Set(TRANSIENT_INFRA_REASONS);

/**
 * Is this failure/stall reason a transient infrastructure condition?
 * Pure string predicate over the closed set above — never throws, false for
 * anything that is not one of those exact literals.
 */
export function isTransientInfraReason(reason) {
  if (typeof reason !== "string") return false;
  return TRANSIENT_INFRA_SET.has(reason.trim().toLowerCase());
}

/**
 * How long a transient signal is left alone before the normal escalation path
 * is allowed to run. The suppression MUST be bounded: an unbounded skip turns a
 * false page into a silently stranded ticket, which is strictly worse.
 */
export const TRANSIENT_ESCALATION_BACKOFF_MS = 30 * 60 * 1000; // 30 min

/**
 * Classify a phase signal as a transient-infrastructure park.
 *
 * @returns {{transient: boolean, reason: string|null, retrySafe: boolean,
 *            withinBackoff: boolean, ageMs: number|null}}
 *   `transient`     the reason is one of TRANSIENT_INFRA_REASONS
 *   `retrySafe`     the producer stamped retrySafe:true (CTL-1679)
 *   `withinBackoff` the signal is retry-safe AND recent enough that the bounded
 *                   retry has not had its window yet — escalation may be SKIPPED
 * Reads both the top level and `.raw` (the scheduler's projection nests the
 * on-disk fields under `.raw` — the CTL-1754 trap).
 *
 * ⚠️ `withinBackoff` requires BOTH `retrySafe` and a READABLE timestamp:
 *   - no `retrySafe` stamp → there is no route that re-dispatches the phase, so
 *     suppressing the escalation would be a pure silent stall (Codex R1);
 *   - an unreadable/absent `updatedAt` → the age can never advance, so treating
 *     it as "fresh" would suppress the escalation on EVERY tick, forever
 *     (Codex R2 P3). Both fall OUT of the window and escalate normally.
 */
export function classifyTransientSignal(
  signal,
  { now = Date.now(), backoffMs = TRANSIENT_ESCALATION_BACKOFF_MS } = {},
) {
  const absent = { transient: false, reason: null, retrySafe: false, withinBackoff: false, ageMs: null };
  if (signal === null || signal === undefined || typeof signal !== "object") return absent;
  const raw = signal.raw !== null && typeof signal.raw === "object" ? signal.raw : null;
  const retrySafe = signal.retrySafe === true || raw?.retrySafe === true;
  const { reason } = resolveSignalReason(signal);
  const transient = isTransientInfraReason(reason);
  if (!transient) return { ...absent, reason, retrySafe };

  const stamp = signal.updatedAt ?? raw?.updatedAt ?? null;
  const at = stamp ? Date.parse(stamp) : NaN;
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null;
  const withinBackoff = retrySafe && ageMs !== null && ageMs < backoffMs;
  return { transient: true, reason, retrySafe, withinBackoff, ageMs };
}

/**
 * CTL-1647: the explanation for a transient park that has ALREADY spent its
 * automatic retry window. This is the ONLY transient wording, on purpose.
 *
 * The earlier draft of this fix emitted "No decision is required — it will
 * re-dispatch itself", but every site that reaches an explanation has by then
 * exhausted the bounded back-off (the terminal sweep re-arms up to N times
 * before it escalates; recovery only escalates past its budget). Telling the
 * human "nothing is required" on a ticket that demonstrably did NOT recover is
 * a false all-clear — strictly worse than the false decision card it replaced.
 *
 * `manual` + blocked_capability + instructions is exactly the shape the operator
 * inbox renders as ACT-THEN-CONFIRM (inbox-ask.mjs isValidatedManualEscalation),
 * which is what this now genuinely is: check it, re-dispatch by hand if it is
 * still parked. It still asks for NO priority/scope decision, and it names the
 * fleet-level framing so N of these read as ONE incident.
 */
export function buildTransientExhaustedExplanation(ticket, reason, attempts = 0) {
  const t = ticket ?? "this ticket";
  const r = reason ?? "a transient provider-capacity condition";
  return Object.freeze({
    escalation_type: "manual",
    transient: true,
    problem:
      `${t} stalled on a transient provider/infrastructure condition ("${r}") and its automatic ` +
      `back-off window is spent (${attempts} automatic re-arm(s)). The provider being over capacity ` +
      `says nothing about this ticket's work.`,
    call_to_action:
      `Check whether ${t} resumed once provider capacity returned; if it is still parked, re-dispatch it — ` +
      `the automatic retry window has already passed.`,
    blocked_capability:
      `automatic recovery of ${t} from the provider-capacity condition "${r}" — the bounded back-off is spent`,
    instructions: [
      `Confirm whether ${t} re-dispatched on its own; if it is still parked, re-dispatch the failed phase`,
      `If many tickets carry "${r}", treat it as ONE fleet provider-capacity incident — do NOT decide them one by one`,
    ],
    remediation_then_retry:
      `wait for provider capacity to return, then re-dispatch ${t}'s failed phase`,
    why_not_auto:
      `the bounded automatic back-off for "${r}" ran ${attempts} time(s) without clearing ${t}, ` +
      `so nothing re-dispatches it automatically any more`,
    attempts: [{ reason: r, count: attempts }],
  });
}
