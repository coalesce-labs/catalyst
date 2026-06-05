# AI-Native Ticket Estimation Methodology (CTL-746)

This document describes the **reusable, calibrated estimation pipeline** ported from the proven
Adva pipeline (ADV-424 / ADV-458 / ADV-426) into the Catalyst PM plugin. It covers the data
sources, the three pipeline stages, the calibrated heuristic table, the T-shirt → story-point
mapping, the calibration approach, and how the orchestrator's `phase-triage` agent and the
execution-core scheduler should consume the output.

The scripts live in [`plugins/pm/scripts/estimate/`](../scripts/estimate/):

| Stage | Script | Role |
|---|---|---|
| **Extract** | `extract-actuals-from-transcripts.ts` | Stream session transcripts → per-ticket actuals CSV (cost, turns, wall-hours) |
| **Score** | `score-tickets.ts` | Apply the calibrated heuristic → T-shirt + points + confidence + rationale, emit a corpus JSON |
| **Lookup** | `reference-class-lookup.ts` | Read-side k-NN: nearest closed tickets by signal similarity + their actuals distribution |

This methodology is the **runtime calibration anchor**; the on-ticket data contract it feeds is the
[estimation signal schema (v1)](./estimation-signal-schema.md) (`estimation:` YAML block + the
`Issue.estimate` integer mirror).

---

## 1. Data sources

Three independent signal sources, in decreasing order of fidelity:

### a. `~/.claude/projects/` transcripts — the actuals truth (Extract)

Every Claude Code session writes a JSONL transcript under
`~/.claude/projects/<encoded-cwd>/<session>.jsonl`. Worktree directory names embed the ticket id
(`…CTL-746…`), so `extract-actuals-from-transcripts.ts` matches `(TEAM)-\d+`, stream-parses each
file, and per assistant event accumulates:

- `message.usage.{input,output,cache_creation_input,cache_read_input}_tokens` → **cost** (priced via
  `claude-pricing.json`, see §1d),
- one **assistant turn** per `type:"assistant"` event,
- first/last `timestamp` → **wall-clock hours**.

This is a **~5× larger** anchor set than the Prometheus/OTel window (which only retains a short
sliding window of `claude-code-otel` samples). The transcripts go back months and survive cache
eviction — they are the calibration corpus.

### b. `git diff --numstat` per ticket — the universal structural signal (Score)

LOC (`additions + deletions`), `changed_files`, and the set of touched `domains` (top-level
`plugins/*`, `website`, etc.) are the **merge-strategy-independent** structural signals. They are
read from the ticket's merged PR (via `gh api`) or directly from `git diff --numstat` against the
merge base. Unlike commit count (see §3), these survive squash merges intact, so they remain the
backbone votes for every closed ticket.

### c. `~/catalyst/catalyst.db` — per-session duration / cost / iterations (optional cross-check)

The orchestrator's session DB (`session_metrics`: `cost_usd`, `duration_ms`, `plan_iterations`,
`fix_iterations`) is a **sparse** but already-aggregated actuals source keyed by `ticket_key`. It is
not the primary anchor (it only covers orchestrator-run tickets and can lag), but it is a useful
cross-check against the transcript-derived cost/wall numbers and supplies the iteration counts that
the transcript stream does not.

### d. `claude-pricing.json` — the shared cost table

Cost is computed from the single shared price table at
[`plugins/dev/scripts/claude-pricing.json`](../../dev/scripts/claude-pricing.json) (the same file the
broker / statusline cost code reads). The Extract script loads it, registers each model id under both
its full id (`claude-opus-4-7`) and a coarse family prefix (`claude-opus-4`) so date-suffixed
transcript model ids still match, and falls back to built-in list prices only if the file is absent.
A pricing bump therefore updates **every** consumer at once — no hardcoded prices in the estimator.

---

## 2. The three pipeline stages

```
┌──────────────────────────────┐   actuals CSV    ┌──────────────────┐   corpus JSON   ┌────────────────────────┐
│ extract-actuals-from-        │ ───────────────► │ score-tickets    │ ──────────────► │ reference-class-lookup │
│   transcripts.ts             │  (otel_* cols)   │                  │  (corpus.v1)    │                        │
│ (~/.claude/projects)         │                  │ + git numstat /  │                 │ k-NN read-side         │
└──────────────────────────────┘                  │   PR signals     │                 │ (phase-triage / human) │
                                                   └──────────────────┘                 └────────────────────────┘
```

### Extract — `extract-actuals-from-transcripts.ts`

```bash
bun extract-actuals-from-transcripts.ts --team CTL --apply --out actuals.csv
```

Generalized vs the ADV original: `--out` takes any path, `--team` is a free-form comma list, prices
come from `claude-pricing.json` (`--pricing` overrides), and it emits an `otel_turns` column. Output
columns are the `otel_*` actuals columns that the Score step joins on `ticket_id`. Dependency-light:
bun + node builtins only.

### Score — `score-tickets.ts`

```bash
bun score-tickets.ts --in signals.csv --out estimates.md --json corpus.json
```

Joins structural signals (LOC / files / domains / structural flags from the PR) with the actuals
columns, votes each populated signal into a T-shirt bucket, takes the mode, applies structural floors
and override modifiers, then maps the T-shirt to story points. It writes both a human review table
(`*.md`) and a machine **corpus JSON** (`*.corpus.json`, schema `catalyst.estimation.corpus.v1`)
that the Lookup step consumes. Pass `--check-labels` to skip tickets carrying `estimate-source:human`
(never overwrite a human estimate).

### Lookup — `reference-class-lookup.ts`

```bash
# query by free-form signals:
bun reference-class-lookup.ts --corpus corpus.json \
  --title "wire estimation into scheduler write-back" \
  --loc 320 --files 8 --domains "plugins/pm|plugins/dev" --backend -k 5

# query by an existing corpus ticket (leave-one-out):
bun reference-class-lookup.ts --corpus corpus.json --ticket CTL-497 -k 5 --json
```

Given a query ticket's signals it returns the **k nearest closed tickets** by a blended similarity
(title-token Jaccard 0.35, LOC log-closeness 0.25, domain-set Jaccard 0.20, file-count log-closeness
0.10, structural-flag agreement 0.10; missing numeric components are dropped and weights
renormalized), their **actuals distribution** (median / min / max of cost, turns, wall-hours), and a
voted reference-class T-shirt + points + confidence. This is the **outside-view** anchor — estimate a
new ticket against the closest historical reference class rather than guessing inside-view. It is the
CTL-186 read-side lookup.

---

## 3. The calibrated heuristic table

Each populated signal casts a T-shirt vote; the **mode** wins (ties resolve toward XS,
conservative). Confidence is `high` (≥3 agreeing votes) / `medium` (2) / `low` (1).

### Structural signals — kept as-is from ADV-424 (merge-strategy independent)

| Signal | XS | S | M | L | XL |
|---|---|---|---|---|---|
| **LOC** (add+del) | <50 | <200 | <800 | <2000 | 2000+ |
| **changed_files** | ≤2 | ≤5 | ≤15 | ≤30 | 31+ |
| **domains** (distinct pkgs) | — | ≤1 | 2 | 3 | 4+ |

### AI-native actuals signals — re-anchored on this corpus (CTL-746)

The AI-native anchors are re-derived as **geometric midpoints of the observed per-size actuals
cluster medians** on this transcript corpus. A boundary `b` between adjacent size medians `m_lo` and
`m_hi` is `b = sqrt(m_lo · m_hi)` — the natural split on the log scale these metrics live on.

| Signal | XS | S | M | L | XL |
|---|---|---|---|---|---|
| **COST_USD** | <27 | 27–79 | 79–147 | 147–244 | 244+ |
| **TURNS** (assistant) | <131 | 131–208 | 208–371 | 371–624 | 624+ |
| **WALL_HOURS** | <0.30 | 0.30–0.81 | 0.81–3.9 | 3.9–23 | 23+ |

### Dropped signal: `commits` (squash-degenerate)

The ADV-424 commit-count row is **removed**. Squash-merge collapses every PR to a single commit:
**318 / 444 tickets = exactly 1 commit** on this corpus, so the signal carries near-zero information
and would only add noise to the mode vote. LOC and changed-files capture the same "size" intent
without the degeneracy.

### Structural floors & override modifiers (kept from ADV-424)

- **Floors**: `has_migration` → min M; `has_frontend ∧ has_backend` → min M.
- **+1**: force-push **or** >20 CI runs (rework signal); 3+ distinct directories touched.
- **−1**: a single changed file with >200 additions (proxy for a generated file).

---

## 4. T-shirt → story-point mapping

T-shirt is the primary unit; story points are the Linear-standard Fibonacci mirror written to
`Issue.estimate` (consistent with the [estimation signal schema](./estimation-signal-schema.md)):

| T-shirt | XS | S | M | L | XL |
|---|---|---|---|---|---|
| **Points** | 1 | 3 | 5 | 8 | 13 |

Points are **value-neutral effort** (not impact — impact sizing is a separate PM concern). Each
corpus entry carries both the T-shirt and the point value.

---

## 5. Calibration approach

1. **Extract** runs over the whole `~/.claude/projects` history → per-ticket actuals (cost / turns /
   wall-hours), the largest available anchor set.
2. Closed tickets are bucketed by their **independently-derived structural T-shirt** (LOC / files /
   domains), and the per-size **median** of each actuals metric is computed (the cluster medians).
3. Adjacent-size boundaries are set to the **geometric midpoint** `sqrt(m_lo · m_hi)` of those
   medians — the §3 AI-native bands.
4. Bands are sanity-checked against the structural votes: a well-calibrated table has the actuals
   votes agreeing with the structural votes on most Tier-1 tickets (high-confidence rows).
5. Re-run periodically as the corpus grows; the geometric-midpoint rule makes re-derivation
   mechanical. Human-labelled tickets (`estimate-source:human`) are excluded via `--check-labels`.

---

## 6. Consumption: phase-triage + execution-core scheduler

The remaining wire-up (the Todo-ready follow-up) is two seams:

### a. `phase-triage` reads the reference class (read-side)

When the orchestrator's `phase-triage` agent classifies a ticket
([`plugins/dev/skills/phase-triage/SKILL.md`](../../dev/skills/phase-triage/SKILL.md)), it already
writes `estimated_scope` into `triage.json`. The wire-up runs `reference-class-lookup.ts` against the
current corpus JSON with the ticket's signals (LOC/files/domains from the description's scope block,
or a numstat probe of a draft branch), and records the voted T-shirt + points + the neighbour
actuals distribution into `triage.json` and the triage Linear comment. This is **read-only** — triage
proposes, it does not mutate the `Issue.estimate` field.

### b. The scheduler performs the write-back (write-side, per CTL-497)

Per **CTL-497**, the estimate/classification field **write-back lives in the execution-core
scheduler, NOT in the phase-triage skill**. The scheduler picks up the proposed estimate from
`triage.json` and writes the `Issue.estimate` integer + the `estimation:` YAML block to Linear.

- **OVERWRITE semantics**: the scheduler write **overwrites** the existing machine estimate (the
  estimate is derived, not hand-tuned), **except** when the ticket carries `estimate-source:human` —
  human estimates are never clobbered (same guard as `score-tickets --check-labels`).
- Putting the write in the scheduler (not the skill) preserves the CTL-497 negative guard in the
  execution-core e2e test and keeps the skill a pure read-only proposer.

```
phase-triage (read)                       execution-core scheduler (write, CTL-497)
─────────────────────                     ─────────────────────────────────────────
reference-class-lookup → triage.json  ──► reads triage.json.estimate
   (T-shirt + points + neighbours)        writes Issue.estimate (OVERWRITE, unless
                                          estimate-source:human) + estimation: YAML
```

---

## 7. Provenance

- **Proven source**: ADV-424 (score-tickets heuristic), ADV-458 (transcript actuals backfill),
  ADV-426 (estimation pass) — `Adva/scripts/estimate/`.
- **This port**: CTL-746 (port + recalibration), CTL-186 (reference-class lookup read-side),
  CTL-497 (scheduler-side estimate write-back).
- **Data contract**: [estimation signal schema v1](./estimation-signal-schema.md) (CTL-184).
