---
name: research-curate
description: |
  Walk thoughts/shared/research/ and thoughts/shared/plans/, score each doc's
  staleness, and regenerate INDEX.md in each directory. Source docs are never
  modified. Classification: current (age<90d AND refs valid), needs-review
  (age>=90d OR broken refs), likely-stale (age>=180d AND no recent activity).
  Deterministic — no LLM calls in v1. CTL-467 (Initiative 4 Phase 1).
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
`thoughts/shared/plans/`. Each doc is classified by age, file:line ref validity,
and recent git topic activity. Source markdown is never modified — only the two
`INDEX.md` files are written.

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

## Invocation

```bash
# Curate both directories in-place
bash plugins/dev/scripts/research-curate/run.sh thoughts/shared/research
bash plugins/dev/scripts/research-curate/run.sh thoughts/shared/plans

# Dry run — writes to /tmp/research-curate-INDEX-<basename>.md
bash plugins/dev/scripts/research-curate/run.sh --dry-run thoughts/shared/research
```

Each invocation prints a one-line summary:

```
thoughts/shared/research: current=42 needs-review=83 likely-stale=80 → thoughts/shared/research/INDEX.md
```

## Skill body

When invoked as `/catalyst-dev:research-curate`, run both directories
sequentially and report the two summary lines back to the user.

```bash
set -euo pipefail
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.}/scripts/research-curate/run.sh"
[[ -x "$SCRIPT" ]] || SCRIPT="plugins/dev/scripts/research-curate/run.sh"

bash "$SCRIPT" thoughts/shared/research
bash "$SCRIPT" thoughts/shared/plans
```

Source-doc immutability is enforced by `inventory.sh` (which only ever reads
source markdown) and `run.sh` (which writes exclusively to `INDEX.md` or a
`/tmp/` dry-run path). The test suite asserts this property against a fixture
repo via a before/after hash comparison.

## Out of scope (deferred)

- `CONTRADICTIONS.md` clustering — Phase 2 of Initiative 4 (separate ticket).
- CMA Routine wiring (weekly cadence) — Phase 3 of Initiative 4.
- LLM-generated one-line summaries — plan permits but defers for testability.

## Tests

`bash plugins/dev/scripts/__tests__/research-curate-inventory.test.sh`
