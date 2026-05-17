# ADR-Drift Detector

`adr-drift.sh` compares ADR documents to the current code state and emits `adr_drift`
decisions for the morning briefing. Invoked by `morning-briefing` Step 3.

## What it does

For each ADR markdown file under the configured `adrs.directory`, the detector:

1. Parses YAML frontmatter
2. Reads `code_assertions` (a list of `{pattern, expectation, description}`)
3. Greps the codebase for each pattern (excluding `.git`, `node_modules`, `thoughts`,
   `dist`, `build`, `.next`, `.venv`, `__pycache__`, and the ADRs directory itself)
4. Records a drift decision when an assertion does not hold

ADRs without `code_assertions` are skipped from the structured path. The acceptance
contract is: **zero false positives** on legacy ADR sets that have no frontmatter, and
**at least one true positive** when an assertion is intentionally violated.

## The `code_assertions` frontmatter

ADR files use standard YAML frontmatter at the top of the file:

```yaml
---
adr_id: ADR-005
title: Configurable Worktree Convention
date: 2026-04-15
code_assertions:
  - pattern: "WORKTREE_BASE_DIR"
    expectation: found
    description: "code references the configurable worktree base dir"
  - pattern: "/Users/[a-z]+/code-repos/.*/wt"
    expectation: not_found
    description: "no hardcoded worktree paths remain"
---

# ADR-005: Configurable Worktree Convention

...
```

Fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | yes | Extended regex passed to `grep -rE`. |
| `expectation` | `found` \| `not_found` | no | Default `found`. |
| `description` | string | no | Human label used in the drift summary. |

Each assertion produces at most one drift record per detector run.

## Drift status values

| `drift_status` | Meaning |
|---|---|
| `adr_ahead_of_code` | The ADR asserts a pattern should be found but it is missing. The decision needs implementation (or the ADR needs updating). |
| `code_ahead_of_adr` | The ADR asserts a pattern should NOT be found but it is present. The ADR is stale and needs revision. |

## Output shape

```json
{
  "decisions": [
    {
      "id": "adr-drift-0005-worktree-1",
      "type": "adr_drift",
      "summary": "ADR 0005-worktree drift (code_ahead_of_adr): no hardcoded worktree paths remain",
      "status": "open",
      "adr": "/abs/path/docs/adrs/0005-worktree.md",
      "drift_status": "code_ahead_of_adr",
      "pattern": "/Users/[a-z]+/code-repos/.*/wt"
    }
  ]
}
```

The shape conforms to `plugins/dev/templates/briefing-frontmatter.schema.json` —
`type: adr_drift` is already in the schema's enum and `adr` is a permitted optional
property. The renderer surfaces these in the "Surface decisions" section of the
canonical briefing markdown.

## Configuration

The ADRs directory is resolved in this order:

1. `--adrs-dir DIR` flag (explicit override)
2. `.catalyst/config.json` → `catalyst.adrs.directory` (relative to `--root`)
3. Default: `docs/adrs/`

If the resolved directory does not exist, the detector emits
`{"decisions": []}` and exits 0 — single-file ADR layouts (e.g. catalyst's own
`docs/adrs.md`) intentionally fall here.

Example `.catalyst/config.json` fragment:

```json
{
  "catalyst": {
    "adrs": { "directory": "docs/adrs" }
  }
}
```

## Single-file ADR layouts

Repositories that keep ADRs in a single file (e.g. `docs/adrs.md` with many `## ADR-NNN:`
sections) cannot use the structured path because YAML frontmatter is by definition a
file-level header. The detector treats single-file layouts as informational/legacy and
produces zero structured drift records for them. To opt into structured drift detection,
migrate to a directory of per-ADR files.

## `--deep-adr-check` (LLM-driven path) — future work

The parent plan ([[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 2 Phase 4)
describes a second, LLM-driven path that samples each ADR alongside a code stat
(file count, top imports) and asks the LLM whether the ADR's decision still describes
how the code works. This path is gated behind a `--deep-adr-check` flag so it can be
run weekly rather than daily (cost amortization).

For this MVP, the flag is parsed but emits a stderr note and does no LLM work. Wiring
the LLM path is a follow-up.

## Invocation

Standalone:

```bash
bash plugins/dev/scripts/morning-briefing/adr-drift.sh --root .
```

From a morning-briefing run, Step 3 of the skill calls the detector and merges the
result into the `decisions:` block of the briefing's YAML frontmatter.

## Testing

`plugins/dev/scripts/__tests__/adr-drift-detector.test.sh` exercises the detector
against isolated fixture projects covering: missing directory, passing assertions,
both drift directions, ADRs without frontmatter, multiple assertions in one ADR,
schema conformance, malformed YAML tolerance, and config-driven directory resolution.

Run with `bash plugins/dev/scripts/__tests__/adr-drift-detector.test.sh`.
