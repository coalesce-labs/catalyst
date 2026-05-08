// dsl-prompt.mjs — Groq system prompt + few-shot examples for CTL-313.
//
// Built from CANONICAL_FIELDS so the schema block cannot drift from the
// validator.

import { CANONICAL_FIELDS } from "./dsl-fields.mjs";

function fieldsBlock() {
  return CANONICAL_FIELDS
    .map((f) => `  - ${f.path}  (${f.type}) — ${f.description}`)
    .join("\n");
}

export const FEW_SHOT_EXAMPLES = [
  {
    user: "show all gh events for ADV-292 and ADV-293 that are PR or CI",
    assistant: {
      filter: {
        and: [
          { field: 'attributes."catalyst.worker.ticket"', in: ["ADV-292", "ADV-293"] },
          {
            or: [
              { field: 'attributes."event.name"', startsWith: "github.pr." },
              { field: 'attributes."event.name"', startsWith: "github.check_" },
              { field: 'attributes."event.name"', startsWith: "github.workflow_run." },
            ],
          },
        ],
      },
      sort: { field: "ts", order: "desc" },
      limit: 200,
    },
  },
  {
    user: "errors in the last hour",
    assistant: {
      // The "last hour" timestamp is a placeholder; the CLI rewrites time
      // expressions before sending to Groq, so the model just emits a literal
      // ISO string — the validator and downstream caller handle it.
      filter: {
        and: [
          { field: "severityText", eq: "ERROR" },
          { field: "ts", gte: "{NOW-1h}" },
        ],
      },
      sort: { field: "ts", order: "desc" },
      limit: 200,
    },
  },
  {
    user: "all events for orch-adv-852-2026-05-07",
    assistant: {
      filter: { field: 'attributes."catalyst.orchestrator.id"', eq: "orch-adv-852-2026-05-07" },
      sort: { field: "ts", order: "asc" },
      limit: 500,
    },
  },
  {
    user: "failed CI on main branch",
    assistant: {
      filter: {
        and: [
          { field: 'attributes."event.name"', startsWith: "github.check_" },
          { field: 'attributes."cicd.pipeline.run.conclusion"', eq: "failure" },
          { field: 'attributes."vcs.ref.name"', eq: "refs/heads/main" },
        ],
      },
      sort: { field: "ts", order: "desc" },
      limit: 100,
    },
  },
  {
    user: "trace events for PR #501",
    assistant: {
      // Trace pivot from PR is not supported in v1 — the model is instructed
      // (in the system prompt) to return an error in that case.
      error: "trace pivot from PR not yet supported; query by traceId directly",
    },
  },
  {
    user: "delete all heartbeat events",
    assistant: {
      error: "refused: query is read-only",
    },
  },
];

const FEW_SHOT_BLOCK = FEW_SHOT_EXAMPLES
  .map((ex) => `User: ${ex.user}\nAssistant: ${JSON.stringify(ex.assistant)}`)
  .join("\n\n");

export const SYSTEM_PROMPT = `You translate natural-language event queries into a strict JSON DSL. Return ONLY a single JSON object, no other text.

The events you query come from \`~/catalyst/events/YYYY-MM.jsonl\`. Each line is a canonical OpenTelemetry-shaped envelope with these top-level fields and attribute paths:

${fieldsBlock()}

DSL grammar (TypeScript-style):

  type Dsl = { filter: Node; sort?: SortSpec | null; limit?: number | null }
            | { error: string };

  type Node = And | Or | Not | Leaf | {};
  type And  = { and: Node[] };
  type Or   = { or:  Node[] };
  type Not  = { not: Node };
  type Leaf = { field: string } & (
      { eq: any } | { ne: any }
    | { gt: any } | { gte: any } | { lt: any } | { lte: any }
    | { in: any[] }
    | { startsWith: string } | { endsWith: string } | { contains: string }
    | { exists: boolean }
  );
  type SortSpec = { field: string; order?: "asc" | "desc" };

Rules:
1. \`field\` MUST be one of the paths above, written EXACTLY as shown (including the quotes around dotted attribute keys: \`attributes."event.name"\`).
2. NEVER invent fields. If the user references a concept that has no corresponding field, return \`{"error":"unknown field: <best-guess>"}\`.
3. If the user asks to delete, modify, write, or trigger any action, return \`{"error":"refused: query is read-only"}\`.
4. If the user asks for trace correlation from a PR number, return \`{"error":"trace pivot from PR not yet supported; query by traceId directly"}\`.
5. For relative time windows ("last hour", "today", "yesterday"), emit a literal placeholder string \`"{NOW-1h}"\` / \`"{TODAY}"\` etc. on the \`gte\`/\`lte\` clause — the caller will rewrite these to ISO timestamps before running the filter.
6. Always set a \`limit\` (default 200 if the user didn't specify).
7. Always set a \`sort\` (default \`{field: "ts", order: "desc"}\`).

Few-shot examples:

${FEW_SHOT_BLOCK}

Return only the JSON object. No prose, no code fences, no commentary.`;
