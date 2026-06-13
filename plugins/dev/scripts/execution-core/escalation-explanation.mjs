// escalation-explanation.mjs — CTL-1065: structured escalation explanation contract.
// Single source of truth for all five escalation write sites. Pure, no I/O.
//
// Shape: { what_failed, observed, attempts[], why_gave_up, human_question }
//   - validateExplanation(obj)         -> { valid, errors[] }   (pure predicate)
//   - buildExplanation(fields)         -> frozen valid object    (throws if invalid)
//   - coerceExplanation(fields, ctx)   -> frozen valid object    (never throws; degrades)

const REQUIRED_STRINGS = ["what_failed", "why_gave_up", "human_question"];

// Tautological human_question patterns — operator gets no decision from these.
const TAUTOLOGY_RE =
  /^(this |it )?(requires?|needs?|escalate[sd]? to|page|ask)( a| the)? (human|operator|person|someone)( to (decide|intervene|look))?\.?$/i;
const VAGUE_RE = /^(needs?|requires?) (human|manual) (intervention|action|review)\.?$/i;
// "a human must decide", "a person should intervene", etc.
const DEFER_RE =
  /^(a |the )?(human|operator|person|someone) (must|should|needs? to|has to) (decide|intervene|review|act|handle|look)\.?$/i;

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function validateExplanation(e) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return { valid: false, errors: ["explanation: not an object"] };
  }
  for (const k of REQUIRED_STRINGS) {
    if (typeof e[k] !== "string" || e[k].trim() === "") errors.push(`${k}: missing or empty`);
  }
  if (e.observed == null || typeof e.observed !== "object" || Array.isArray(e.observed)) {
    errors.push("observed: must be a non-null object");
  }
  if (!Array.isArray(e.attempts)) errors.push("attempts: must be an array");
  // Tautology gate — only meaningful once human_question is a non-empty string.
  if (typeof e.human_question === "string" && e.human_question.trim() !== "") {
    const q = norm(e.human_question);
    if (TAUTOLOGY_RE.test(q) || VAGUE_RE.test(q) || DEFER_RE.test(q)) {
      errors.push("human_question: tautological — names no decision");
    }
    if (q === norm(e.what_failed)) {
      errors.push("human_question: merely restates what_failed");
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
  const { valid } = validateExplanation(e);
  if (valid) return Object.freeze(e);
  // Degrade: fill missing required fields with safe fallbacks so the operator
  // still gets a real page even when input is thin.
  const ticket = ctx.ticket ?? "this ticket";
  const phase = ctx.phase ? ` ${ctx.phase} phase` : "";
  if (!e.what_failed) e.what_failed = `unexplained failure in ${ticket}${phase}`;
  if (!e.why_gave_up) e.why_gave_up = `no actionable diagnosis available`;
  e.human_question = `Review ${ticket}${phase}: ${e.what_failed} — decide whether to retry, hand off, or cancel.`;
  e.degraded = true;
  return Object.freeze(e);
}

// CTL-1108: map a verify.json (HIGH findings + regression_risk) into the
// escalation explanation shape for a remediate-cycle-cap-exhausted stall.
export function buildRemediateCapExplanation(verifyJson, { ticket, cycleCount } = {}) {
  const v = verifyJson && typeof verifyJson === "object" ? verifyJson : {};
  const findings = Array.isArray(v.findings) ? v.findings : [];
  const highs = findings.filter((f) => f?.severity === "high");
  const blocker = highs[0];

  const blockerDesc = blocker
    ? `${blocker.file ?? "?"}:${blocker.line ?? "?"} — ${blocker.message ?? "(no message)"}`
    : `regression_risk ${v.regression_risk ?? "?"} above threshold with no HIGH finding`;

  const fields = {
    what_failed: `verify still failing after ${cycleCount ?? "?"} remediation cycles. Blocking: ${blockerDesc}`,
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
    why_gave_up: `remediation budget exhausted: ${cycleCount ?? "?"} cycles attempted, verify still fails`,
    human_question: blocker
      ? `${ticket}: verify keeps failing on ${blocker.file ?? "?"}:${blocker.line ?? "?"} (${blocker.message ?? "blocking finding"}). Fix it on the branch, or abandon / re-scope?`
      : `${ticket}: verify keeps failing after ${cycleCount ?? "?"} fix attempts (regression_risk ${v.regression_risk ?? "?"}). Fix on the branch, or abandon / re-scope?`,
  };
  return coerceExplanation(fields, { ticket, phase: "verify" });
}

function normalizeShape(f = {}) {
  return {
    what_failed: typeof f.what_failed === "string" ? f.what_failed : "",
    observed:
      f.observed != null && typeof f.observed === "object" && !Array.isArray(f.observed)
        ? f.observed
        : {},
    attempts: Array.isArray(f.attempts) ? f.attempts : [],
    why_gave_up: typeof f.why_gave_up === "string" ? f.why_gave_up : "",
    human_question: typeof f.human_question === "string" ? f.human_question : "",
  };
}
