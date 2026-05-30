// workflow-rules.mjs — the conditional resolution layer (CTL workflow descriptor
// v1.1; see docs/workflow-descriptors-design.md §5-6).
//
// Pure, no I/O, NO eval. resolveStep(baseStep, context) patches the per-step levers
// (model, effort, preamble, postamble) by evaluating the step's rules[] against a
// DOCUMENTED context. Conditions are a closed {field, op, value} struct that binds
// 1:1 to a UI form and is statically validatable; an unknown when.field is a
// VALIDATION ERROR (never a silent-false), so an author can't ship a rule that can
// never match. This is the dispatch-time resolver behind the marquee example:
// "large ticket ⇒ plan uses effort:max + model:opusplan + a /workflows postamble".

// scope → numeric points. The PRIMARY source for ticket.estimate in v1 (triage.json
// writes estimated_scope as a WORD, not a number — so estimate>=N rules fire on real
// data instead of shipping dead).
export const SCOPE_POINTS = Object.freeze({ small: 1, medium: 3, large: 8, epic: 13 });

// The frozen context-field contract. A rule's when.field MUST be one of these.
export const CONTEXT_FIELDS = Object.freeze([
  "ticket.scope",
  "ticket.estimate",
  "ticket.priority",
  "ticket.labels",
  "ticket.team",
  "verifyVerdict",
  "remediateCycleCount",
]);

// The effort enum mirrors `claude --effort <low|medium|high|xhigh|max>` exactly.
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// Closed operator set (v1). No regex/matches (ReDoS), no and/or/not composition (YAGNI).
const OPS = Object.freeze({
  eq: (a, b) => a === b,
  gte: (a, b) => typeof a === "number" && a >= b,
  lt: (a, b) => typeof a === "number" && a < b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
});

const MAX_APPEND_LINES = 40; // bound the composed --append-system-prompt

export class WorkflowRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowRuleError";
  }
}

// buildContext — assemble the documented context object from raw inputs. `scope`
// comes from triage.json.estimated_scope; estimate is derived from SCOPE_POINTS.
export function buildContext({
  scope = null,
  priority = null,
  labels = [],
  team = null,
  verifyVerdict = null,
  remediateCycleCount = 0,
  ticketId = null,
} = {}) {
  return {
    ticket: {
      scope,
      estimate: scope != null ? (SCOPE_POINTS[scope] ?? null) : null,
      priority,
      labels,
      team,
    },
    verifyVerdict,
    remediateCycleCount,
    ticketId,
  };
}

function readPath(context, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), context);
}

function getField(context, path) {
  if (!CONTEXT_FIELDS.includes(path)) {
    throw new WorkflowRuleError(
      `unknown context field '${path}' (allowed: ${CONTEXT_FIELDS.join(", ")})`
    );
  }
  return readPath(context, path);
}

// evalPredicate — {field, op, value} against the context. Closed op set, no eval. A
// valid-but-unpopulated field is a no-match (false); an UNKNOWN field throws.
export function evalPredicate(pred, context) {
  if (pred == null || typeof pred !== "object" || Array.isArray(pred)) {
    throw new WorkflowRuleError("predicate must be an object {field, op, value}");
  }
  const { field, op, value } = pred;
  if (!(op in OPS)) {
    throw new WorkflowRuleError(`unknown op '${op}' (allowed: ${Object.keys(OPS).join(", ")})`);
  }
  const actual = getField(context, field); // throws on unknown field
  if (actual === undefined || actual === null) return false;
  return OPS[op](actual, value);
}

// interpolate — replace ${ticket}, ${ticket.scope}, ${ticket.estimate}, … in a prompt
// line from the documented context. Unknown placeholders are left verbatim.
function interpolate(line, context) {
  return String(line).replace(/\$\{([^}]+)\}/g, (m, expr) => {
    const e = expr.trim();
    if (e === "ticket") return context.ticketId != null ? String(context.ticketId) : m;
    if (CONTEXT_FIELDS.includes(e)) {
      const v = readPath(context, e);
      return v == null ? m : String(v);
    }
    return m;
  });
}

// resolveStep — apply matching rules to a base step, in array order. `set` keys merge
// (last-match-wins); appendPreamble/appendPostamble accumulate (bounded). Prompt lines
// are interpolated against the context. Returns a NEW step with an `_applied` audit
// trail of which rule indexes fired (surfaced into the dispatch event for the HUD).
export function resolveStep(baseStep, context) {
  const rules = Array.isArray(baseStep.rules) ? baseStep.rules : [];
  const out = { ...baseStep };
  delete out.rules;
  let preamble = Array.isArray(baseStep.preamble) ? [...baseStep.preamble] : [];
  let postamble = Array.isArray(baseStep.postamble) ? [...baseStep.postamble] : [];
  const applied = [];

  rules.forEach((rule, i) => {
    if (!evalPredicate(rule.when, context)) return;
    applied.push(i);
    if (rule.set && typeof rule.set === "object") Object.assign(out, rule.set);
    if (Array.isArray(rule.appendPreamble)) preamble.push(...rule.appendPreamble);
    if (Array.isArray(rule.appendPostamble)) postamble.push(...rule.appendPostamble);
  });

  if (preamble.length + postamble.length > MAX_APPEND_LINES) {
    throw new WorkflowRuleError(
      `composed preamble+postamble exceeds ${MAX_APPEND_LINES} lines (got ${preamble.length + postamble.length})`
    );
  }
  if (out.effort != null && !EFFORT_LEVELS.includes(out.effort)) {
    throw new WorkflowRuleError(`invalid effort '${out.effort}' (allowed: ${EFFORT_LEVELS.join(", ")})`);
  }

  out.preamble = preamble.map((l) => interpolate(l, context));
  out.postamble = postamble.map((l) => interpolate(l, context));
  out._applied = applied;
  return out;
}

// descriptorStep — the base step for an id, with workflow-level defaults applied.
export function descriptorStep(descriptor, stepId) {
  const all = [...(descriptor.steps ?? []), ...(descriptor.ancillarySteps ?? [])];
  const step = all.find((s) => s.id === stepId);
  if (!step) throw new WorkflowRuleError(`no step '${stepId}' in descriptor`);
  return { ...(descriptor.defaults ?? {}), ...step };
}

// resolveDescriptorStep — the dispatch-time entry point: descriptorStep + resolveStep.
export function resolveDescriptorStep(descriptor, stepId, context) {
  return resolveStep(descriptorStep(descriptor, stepId), context);
}
