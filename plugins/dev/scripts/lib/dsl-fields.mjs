// dsl-fields.mjs — canonical field whitelist for the catalyst-events query DSL (CTL-313).
//
// Hand-derived from `plugins/dev/references/event-schema.md` (the human-authored
// reference doc). Auto-generation from event-schema.md is a follow-up.
//
// To add a field:
//   1. Add the field to `plugins/dev/references/event-schema.md`.
//   2. Add a matching entry here.
//   3. The Groq system prompt and the validator both read from this file —
//      they will not drift.
//
// `path` is the jq access path. Quoted segments use the canonical
// `."dotted.key"` form so consumers can drop them straight into a jq predicate.

export const CANONICAL_FIELDS = [
  // ─── Top-level envelope fields ────────────────────────────────────────────
  { path: "ts",                            type: "string",  description: "ISO 8601 event timestamp" },
  { path: "id",                            type: "string",  description: "Per-event UUIDv4 (CTL-344); maps to OTLP LogRecord.logRecordUid" },
  { path: "observedTs",                    type: "string",  description: "ISO 8601 timestamp the writer observed the event" },
  { path: "severityText",                  type: "enum",    description: "DEBUG | INFO | WARN | ERROR" },
  { path: "severityNumber",                type: "number",  description: "OTel severity number (5/9/13/17)" },
  { path: "traceId",                       type: "string",  description: "32-hex trace ID, or null for ambient events" },
  { path: "spanId",                        type: "string",  description: "16-hex span ID, or null for ambient events" },
  { path: "parentSpanId",                  type: "string",  description: "16-hex parent span ID when present" },
  { path: 'resource."service.name"',       type: "enum",    description: "catalyst.github | catalyst.linear | catalyst.session | catalyst.orchestrator | catalyst.comms | catalyst.broker" },
  { path: "body.message",                  type: "string",  description: "Human-readable summary of the event" },

  // ─── attributes.event.* ───────────────────────────────────────────────────
  { path: 'attributes."event.name"',       type: "string",  description: "Dotted event identifier, e.g. github.pr.merged, session.phase" },
  { path: 'attributes."event.entity"',     type: "string",  description: "Entity type: pr, issue, check_suite, session, worker, attention, …" },
  { path: 'attributes."event.action"',     type: "string",  description: "Action verb: merged, opened, phase, attention, dispatched, …" },
  { path: 'attributes."event.label"',      type: "string",  description: "Primary identifier: PR #342, CTL-210, a session id" },
  { path: 'attributes."event.value"',      type: "any",     description: "Secondary value (string or number)" },
  { path: 'attributes."event.channel"',    type: "enum",    description: "webhook | sme.io" },

  // ─── attributes.catalyst.* ────────────────────────────────────────────────
  { path: 'attributes."catalyst.orchestrator.id"', type: "string", description: "Orchestration run identifier" },
  { path: 'attributes."catalyst.worker.ticket"',   type: "string", description: "Worker ticket key (e.g. CTL-210)" },
  { path: 'attributes."catalyst.session.id"',      type: "string", description: "Claude session ID" },
  { path: 'attributes."catalyst.phase"',           type: "number", description: "Worker phase number" },

  // ─── attributes.vcs.* ─────────────────────────────────────────────────────
  { path: 'attributes."vcs.repository.name"', type: "string", description: 'Repository in "org/repo" form' },
  { path: 'attributes."vcs.pr.number"',       type: "number", description: "Pull-request number" },
  { path: 'attributes."vcs.ref.name"',        type: "string", description: "Branch or tag ref (e.g. refs/heads/main)" },
  { path: 'attributes."vcs.revision"',        type: "string", description: "Commit SHA" },

  // ─── attributes.cicd.* ────────────────────────────────────────────────────
  { path: 'attributes."cicd.pipeline.run.id"',         type: "number", description: "GitHub Actions run ID" },
  { path: 'attributes."cicd.pipeline.run.status"',     type: "string", description: "queued | in_progress | completed (lifecycle state on workflow_run / check_suite)" },
  { path: 'attributes."cicd.pipeline.run.conclusion"', type: "string", description: "success | failure | cancelled | skipped | timed_out" },
  { path: 'attributes."cicd.pipeline.name"',           type: "string", description: "Workflow name (e.g. CI)" },

  // ─── attributes.linear.* ──────────────────────────────────────────────────
  { path: 'attributes."linear.issue.identifier"', type: "string", description: "Linear issue identifier (e.g. CTL-210)" },
  { path: 'attributes."linear.team.key"',         type: "string", description: "Linear team key (e.g. CTL)" },
  { path: 'attributes."linear.actor.id"',         type: "string", description: "Linear user UUID who triggered the action" },

  // ─── attributes.deployment.* ──────────────────────────────────────────────
  { path: 'attributes."deployment.environment"', type: "string", description: "production | staging | …" },
  { path: 'attributes."deployment.id"',          type: "number", description: "GitHub deployment ID" },

  // ─── attributes.claude.* (Claude Code metadata, CTL-374) ──────────────────
  // Cost is intentionally NOT a typed attribute; cost lives in body.payload only.
  { path: 'attributes."claude.session.id"',       type: "string", description: "Claude Code session UUID (distinct from catalyst.session.id)" },
  { path: 'attributes."claude.model"',            type: "string", description: "Claude model id (e.g. claude-opus-4-7)" },
  { path: 'attributes."claude.context.used_pct"', type: "number", description: "Claude context window used percentage (0-100)" },
  { path: 'attributes."claude.context.tokens"',   type: "number", description: "Current Claude context-window token usage" },
  { path: 'attributes."claude.turn"',             type: "number", description: "Conversation turn count for the Claude session" },
];

export const FIELD_PATH_SET = new Set(CANONICAL_FIELDS.map((f) => f.path));

export function isWhitelistedField(path) {
  return FIELD_PATH_SET.has(path);
}

// Levenshtein distance between two strings — used to suggest a near-miss when
// validation rejects an unknown field. Pure helper; no allocations beyond the
// O(min(m,n)) row, since whitelist entries are short and we run it ≤ 40 times
// per validation failure.
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function suggestField(path, maxDistance = 4) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const f of CANONICAL_FIELDS) {
    const d = levenshtein(path, f.path);
    if (d < bestDist) {
      best = f.path;
      bestDist = d;
    }
  }
  return bestDist <= maxDistance ? best : null;
}
