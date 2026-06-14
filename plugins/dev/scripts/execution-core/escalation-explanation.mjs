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
