# AI-Native Ticket Estimation Signal Schema (v1)

The `estimation:` block is the data contract shared by every skill that emits or consumes an
AI-native ticket estimate. Producers include inline authoring skills, `/pm:estimate-ticket`
(CTL-160), `/pm:retroactive-estimate` (CTL-163), and human overrides. Consumers include
`/pm:weekly-cycle-review` (CTL-161), the reference-class lookup CLI, the reference-corpus
exporter, and planning tools that gate orchestration mode on structural signals.

**Machine schema:** [`../schemas/estimation-signal.schema.json`](../schemas/estimation-signal.schema.json)
(JSON Schema draft 2020-12).

**Linked research:** see
[`thoughts/shared/research/2026-04-24-CTL-184-estimation-signal-schema.md`](../../../thoughts/shared/research/2026-04-24-CTL-184-estimation-signal-schema.md)
for the carrier-decision matrix, the heuristic-table inputs, and the published-research
landscape.

## Carrier decision: hybrid YAML + Linear native primitives

The original ticket framed "Linear custom fields" as the preferred carrier for top-level
scalars. That option is **not available**: Linear's public GraphQL API does not expose
arbitrary custom fields on issues. The "Asks fields" released June 2025 are scoped to intake
forms, not general issues, and custom fields on issues remain a long-standing open community
request.

The practical hybrid:

| Carrier | Role | Scope |
|---|---|---|
| **YAML frontmatter in the ticket description** | Primary carrier — source of truth for the full structured block | All fields |
| **`Issue.estimate` integer (built-in)** | Numeric mirror of `proposed_tshirt` using the Linear-standard XS=1 / S=2 / M=3 / L=5 / XL=8 Fibonacci mapping | `proposed_tshirt` only |
| **Linear labels** | Queryable mirrors of the three top-level scalars so grids and filters work without parsing descriptions | `proposed_tshirt`, `confidence`, `source` |

Rejected carriers:

- **Linear custom fields on issues** — not exposed via the public API.
- **Comment block** — worst discoverability, duplicates description content.
- **External sidecar (own DB or attachments)** — creates a dependency every downstream skill
  has to traverse; not portable to other Linear workspaces adopting the Catalyst plugins.

## The `estimation:` block

Emitted as YAML frontmatter at the top of the ticket description.

### Full-emission example

```yaml
estimation:
  scope:
    expected_loc:    { low: 200, mid: 500, high: 900 }
    expected_files:  { low: 6,   mid: 10,  high: 15 }
    domains_likely:  [plugins/pm]
  structural:
    has_migration:        false
    has_frontend:         false
    has_backend:          false
    has_breaking_change:  false
    needs_spike:          false
  uncertainty:
    concreteness:                high
    acceptance_criteria_present: true
    linked_design_doc:           thoughts/shared/research/2026-04-24-CTL-184-estimation-signal-schema.md
  risk:
    file_churn_90d:        low
    downstream_callers:    high
    shared_kernel_contact: false
  reference_class:
    similar_closed_tickets: [CTL-175, CTL-178]
    rationale:              "Similar foundation/docs tickets in pm and dev plugins."
  proposed_tshirt: M
  confidence:      high
  source:          estimate-ticket-skill
  at:              2026-04-24T20:00:00Z
```

### Partial-emission example (inline author)

An author typing a ticket in Linear can only reason over `scope` and `uncertainty` — `risk`
requires a codebase scan and `reference_class` requires corpus retrieval. Both branches are
safely omitted:

```yaml
estimation:
  scope:
    expected_loc:    { low: 50, mid: 150, high: 300 }
    expected_files:  { low: 2,  mid: 4,   high: 6 }
    domains_likely:  [plugins/pm]
  uncertainty:
    concreteness:                medium
    acceptance_criteria_present: true
    linked_design_doc:           null
  proposed_tshirt: S
  confidence:      medium
  source:          inline-author
  at:              2026-04-24T20:30:00Z
```

## Field-by-field rationale

| Field | Type / values | Who writes | Why it's there |
|---|---|---|---|
| `scope.expected_loc` | `{ low, mid, high }` non-negative ints | Any emitter | LOC bucket is the strongest single heuristic signal from the v0 estimate pass. Ranges not points because agents over-commit on point estimates. |
| `scope.expected_files` | `{ low, mid, high }` non-negative ints | Any emitter | Second strongest signal; the 1–2 / 3–5 / 6–15 / 16–30 / 30+ bands map directly to T-shirt buckets. |
| `scope.domains_likely` | `[string]`, unique, path-like | Any emitter | "Domains crossed" drives the +1 cross-3-dirs adjustment. Stored as paths (e.g. `apps/web`, `packages/services/users`) rather than a count so reference-class matching can do nearest-neighbor on overlap, not just cardinality. |
| `structural.has_migration` | `bool` | Any emitter | Direct +1 bump per the heuristic table — DB migrations are a known size inflator. |
| `structural.has_frontend` / `has_backend` | `bool` / `bool` | Any emitter | FE+BE both present is an L-bucket signal. Two booleans instead of an enum so retroactive scripts can grep diffs cheaply. |
| `structural.has_breaking_change` | `bool` | Author, estimate skill | Gates orchestration mode (team vs solo) and flags scope risk in weekly cycle review. |
| `structural.needs_spike` | `bool` | Any emitter | If true, the ticket itself is a spike; T-shirt is softer, confidence drops, downstream skills should not use it as a reference-class anchor. |
| `uncertainty.concreteness` | `high` / `medium` / `low` | Any emitter | Direct proxy for rework risk — the v0 pass describes it as "well-specified / exploratory" with +1 if exploratory. Three buckets match the heuristic granularity. |
| `uncertainty.acceptance_criteria_present` | `bool` | Any emitter | Hard boolean so authoring tools can lint "no AC" tickets and the planner can demand a spike before committing. |
| `uncertainty.linked_design_doc` | `string` or `null` | Any emitter | URL or thoughts-path. Drives the "rich design doc = many decisions to honor" adjustment (see ADV-420 in the v0 pass). |
| `risk.file_churn_90d` | `high` / `medium` / `low` | `/pm:estimate-ticket` only | Enum derived from `git log --since=90.days --dirstat` over `domains_likely`. High churn = bumpier estimates. Cached with the ticket so the signal isn't recomputed each time. |
| `risk.downstream_callers` | `high` / `medium` / `low` | `/pm:estimate-ticket` only | Enum derived from grepping for exports/symbols referenced by files in `domains_likely`. High callers = bigger ripple cost. |
| `risk.shared_kernel_contact` | `bool` | `/pm:estimate-ticket`, author | Named explicitly in the ticket ("e.g. Adva ADR-0001 tax"). Hot-signal that bumps estimate up one bucket when true. |
| `reference_class.similar_closed_tickets` | `[ticket_id]`, unique, matches `^[A-Z][A-Z0-9]*-\d+$` | `/pm:estimate-ticket`, retroactive-bulk | Reference-class lookup reads this to fetch actuals and anchor the estimate. |
| `reference_class.rationale` | `string` | Any emitter | Free-form string explaining *why* those tickets are similar. Needed for human auditability when calibration error is high. |
| `proposed_tshirt` | `XS` / `S` / `M` / `L` / `XL` | Any emitter | Headline output. Mirrored to `Issue.estimate` via XS=1, S=2, M=3, L=5, XL=8. |
| `confidence` | `high` / `medium` / `low` | Any emitter | Drives whether the planner acts on the estimate or queues a spike. `low` + `proposed_tshirt: XL` is a forcing function for a spike. |
| `source` | `inline-author` / `estimate-ticket-skill` / `retroactive-bulk` / `human` | Any emitter | Provenance. Weekly cycle review stratifies calibration error by source. |
| `at` | ISO-8601 timestamp (`format: date-time`) | Any emitter | Estimates drift; `at` lets calibration analysis filter by "estimates current as of week N". |

## Partial emission rules

The only required fields when the `estimation:` key is present are the four terminal scalars
(`proposed_tshirt`, `confidence`, `source`, `at`). Every sub-branch (`scope`, `structural`,
`uncertainty`, `risk`, `reference_class`) is optional at the schema level, so different
emitters fill different subsets:

| Emitter | Fills | Leaves blank |
|---|---|---|
| Inline author (typing a ticket) | `scope`, `uncertainty`, `structural.has_breaking_change`, required scalars | `risk.*` (needs codebase scan), `reference_class.*` (needs retrieval) |
| `/pm:estimate-ticket` skill | Everything | — |
| `/pm:retroactive-estimate` bulk | Everything; sets `source: retroactive-bulk` | — |
| Human override | Any subset; sets `source: human`, updates `at` | — |

`additionalProperties: false` is enforced at every level of the schema, so typos (e.g.
`scope.expected_locs`) fail validation loudly rather than silently eroding the corpus.

## Linear native primitive mirrors

When the `estimation:` block is written, three redundant indexes are updated on the Linear
issue so native analytics and grid filters work without parsing descriptions:

| Native primitive | Value written | Consumed by |
|---|---|---|
| `Issue.estimate` (int) | `XS=1, S=2, M=3, L=5, XL=8` mapping of `proposed_tshirt` | Linear's native `scopeHistory`, `completedScopeHistory`, burndown, velocity (last 3 cycles) |
| Label `estimate-source:<value>` | One of `inline-author`, `estimate-ticket-skill`, `retroactive-bulk`, `human` | `/pm:weekly-cycle-review` for source-stratified calibration error |
| Label `estimate-confidence:<level>` | One of `high`, `medium`, `low` | Planner — filter low-confidence out of auto-dispatch queues |
| Label `estimate-tshirt:<bucket>` | One of `XS`, `S`, `M`, `L`, `XL` | Grid filters, visible signal in Linear list views |

Labels follow the create-if-missing pattern the v0 pass established for `estimate-source:v0`.

The T-shirt → integer mapping matches Linear's own internal mapping for `Team.issueEstimationType
= tShirt` (T-shirt maps to Fibonacci), so `Issue.estimate` stays compatible with Linear's
built-in analytics without any extra wiring.

## Validation

Any JSON Schema draft 2020-12 validator can check an `estimation:` block. Example round-trip
with `ajv-cli`:

```bash
# Given a YAML frontmatter snippet, convert to JSON for validation:
cat > /tmp/example.json <<'EOF'
{
  "estimation": {
    "scope": {
      "expected_loc": { "low": 200, "mid": 500, "high": 900 },
      "expected_files": { "low": 6, "mid": 10, "high": 15 },
      "domains_likely": ["plugins/pm"]
    },
    "uncertainty": {
      "concreteness": "high",
      "acceptance_criteria_present": true,
      "linked_design_doc": null
    },
    "proposed_tshirt": "M",
    "confidence": "high",
    "source": "estimate-ticket-skill",
    "at": "2026-04-24T20:00:00Z"
  }
}
EOF

npx ajv-cli validate \
  -s plugins/pm/schemas/estimation-signal.schema.json \
  -d /tmp/example.json \
  --spec=draft2020 --all-errors
# → /tmp/example.json valid
```

## Open points (deferred to downstream tickets)

- **Shared label-creation helper** — the v0 pass put create-if-missing logic in each script.
  A shared helper in `plugins/pm/scripts/` would DRY this. Not in scope for CTL-184.
- **Migration of pre-schema tickets** — tickets authored before this schema existed have
  unstructured descriptions. Migration is covered by the retroactive-bulk ticket named in
  CTL-184's "Blocks" list.
- **Extended T-shirt sizes (XXL, XXXL)** — Linear supports them; this schema stops at XL
  because the v0 pass produced zero XLs and the reference-class corpus is too small to
  calibrate beyond XL. Extend when the corpus justifies it.
- **Carrier migration if Linear ships issue custom fields** — if that lands, the schema
  content (the YAML block) stays the same; only the Linear-side mirror changes. Plan for
  that migration in a separate ticket at that time.

## See also

- Research: [`thoughts/shared/research/2026-04-24-CTL-184-estimation-signal-schema.md`](../../../thoughts/shared/research/2026-04-24-CTL-184-estimation-signal-schema.md)
- Framework: `2026-04-22-weekly-cycles-and-ai-native-estimation.md` (dimensions, maturity ladder)
- Landscape: `2026-04-22-ai-native-estimation-landscape.md` (no public framework exists)
- Heuristic table inputs: `2026-04-23-v0-estimate-pass.md`
- Linear API reference: `2026-04-22-linear-cycles-estimates-api.md`
