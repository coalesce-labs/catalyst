---
name: research-curate
description: |
  Walk thoughts/shared/research/ and thoughts/shared/plans/, score each doc's
  staleness, regenerate INDEX.md, and append LLM-surfaced contradictions to
  CONTRADICTIONS.md (append-only). Source docs are never modified.
  Classification: current (age<90d AND refs valid), needs-review (age>=90d OR
  broken refs), likely-stale (age>=180d AND no recent activity). Inventory is
  deterministic; contradiction detection runs one LLM call per cluster
  (CTL-467 + CTL-468 / Initiative 4 Phase 1+2).
disable-model-invocation: true
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Task
---

# research-curate

Regenerates `INDEX.md` inventories for `thoughts/shared/research/` and
`thoughts/shared/plans/`, then clusters docs by topic and asks an LLM to
identify contradicting claims, appending findings to `CONTRADICTIONS.md`.
Source markdown is never modified — only `INDEX.md` (overwritten) and
`CONTRADICTIONS.md` (appended) are written.

## What it does

1. **Inventory** — walks each directory, parses frontmatter (`date`, `topic`,
   `tags`), counts words, extracts file:line references (`file.ext:N` pattern).
2. **Score** — for each doc, computes age, validates ref paths against
   `HEAD`, and counts last-30d git log hits for the doc's top-3 tags.
3. **Classify**:
   - `current` — age < 90d AND all refs resolve at HEAD
   - `needs-review` — age >= 90d OR at least one broken ref
   - `likely-stale` — age >= 180d AND zero recent topic activity
4. **Generate** — overwrites `<dir>/INDEX.md` with three sections sorted by
   date descending. Output is fully deterministic.
5. **Cluster + contradict** (CTL-468) — tokenizes `tags` ∪ `topic`, computes
   pairwise Jaccard similarity, unions docs with score ≥ 0.4 via union-find.
   Clusters of size 3–10 are kept (smaller dropped, larger capped at 10).
   For each cluster, one LLM call (default `claude -p`) receives a
   token-bounded prompt (1500 chars/doc) asking for contradictions. New
   findings are appended to `<dir>/CONTRADICTIONS.md` under a
   `## YYYY-MM-DD — <topic>` heading. Existing entries are never modified.

## Invocation

```bash
# Curate both directories in-place (inventory + contradictions)
bash plugins/dev/scripts/research-curate/run.sh thoughts/shared/research
bash plugins/dev/scripts/research-curate/run.sh thoughts/shared/plans

# Inventory only — skip the LLM-driven contradiction pass
bash plugins/dev/scripts/research-curate/run.sh --skip-contradictions \
  thoughts/shared/research

# Dry run — INDEX written to /tmp; contradictions never touched
bash plugins/dev/scripts/research-curate/run.sh --dry-run thoughts/shared/research
```

Each invocation prints summary lines:

```
thoughts/shared/research: current=42 needs-review=83 likely-stale=80 → thoughts/shared/research/INDEX.md
thoughts/shared/research: contradictions clusters=5 appended=3 → thoughts/shared/research/CONTRADICTIONS.md
```

Projected cost for the weekly Routine: ~$0.38/run (75K input tokens × $5/M),
~$1.50/month.

## Skill body

When invoked as `/catalyst-dev:research-curate`, run both directories
sequentially and report the summary lines back to the user.

```bash
set -euo pipefail
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.}/scripts/research-curate/run.sh"
[[ -x "$SCRIPT" ]] || SCRIPT="plugins/dev/scripts/research-curate/run.sh"

bash "$SCRIPT" thoughts/shared/research
bash "$SCRIPT" thoughts/shared/plans
```

Source-doc immutability is enforced by `inventory.sh` (which only ever reads
source markdown), `run.sh` (which writes exclusively to `INDEX.md` or a
`/tmp/` dry-run path), and `append-contradictions.sh` (which opens
`CONTRADICTIONS.md` in append-mode only). The test suite asserts this
property against fixture repos via before/after hash comparisons.

## Out of scope (deferred)

- CMA Routine wiring (weekly cadence) — Phase 3 of Initiative 4 (CTL-469).
- LLM-generated one-line summaries — plan permits but defers for testability.
- LLM-driven clustering — fallback to deterministic Jaccard is preserved for
  cost predictability (Phase 3 refactor option in the plan).

## Tests

```
bash plugins/dev/scripts/__tests__/research-curate-inventory.test.sh
bash plugins/dev/scripts/__tests__/research-curate-contradictions.test.sh
```
