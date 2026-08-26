---
name: compound-estimate
description:
  "Closing ritual for the AI-native estimation feedback loop. **ALWAYS use when** a ticket's PR
  has just merged (today, that still runs automatically per ticket via merge-pr step 12b /
  phase-monitor-merge, CTL-189/CTL-831 — this skill's trigger wiring is out of scope for this
  rewrite and unchanged, see CTL-2244), or when the user says 'compound-estimate', 'close the
  estimation loop', 'record actuals', 'compound-log', or wants to log post-merge actuals for a
  shipped Linear ticket. Writes a structured entry (linear.key, pr_number, merged_at,
  estimate_at_start, estimate_actual, cost_usd, wall_time_hours, what_worked, what_surprised_me)
  to thoughts/shared/retros/estimate/YYYY-WW-compound-log.md — one file per ISO week, appends."
disable-model-invocation: false
allowed-tools: Bash(gh *), Bash(linearis *), Bash(jq *), Bash(git *), Bash(./plugins/dev/scripts/compound-log.sh *), Bash(plugins/dev/scripts/compound-log.sh *), Bash(./plugins/dev/scripts/estimate/refresh-corpus.sh *), Bash(plugins/dev/scripts/estimate/refresh-corpus.sh *), Read, Write
version: 1.1.0
---

# Compound Estimate — Closing Ritual at PR Merge

Write a compound-log entry for a just-shipped ticket. This is the Phase 1 exit gate for AI-native
estimation: without this closer, cost/wall-time signals never feed future estimates and the
calibration loop stays open. All mechanical work delegates to `plugins/dev/scripts/compound-log.sh`
— your job is collecting the three human-authored inputs and invoking it.

## Invocation

```
/compound-estimate <TICKET-ID>
```

`<TICKET-ID>` is required unless it can be detected from the current branch name
(`gh pr view --json headRefName` → parse the ticket prefix).

## Load on demand

| when | read |
| -- | -- |
| resolving the ticket, collecting the three inputs, invoking the helper, reporting back | `references/process.md` |
| where `estimate_at_start` and `cost_usd` actually come from today | `references/data-source.md` |
| the opportunistic corpus refresh, flags, entry schema, testing, troubleshooting | `references/corpus-refresh.md` |

## Invariants

- **Don't skip the re-score.** `estimate_actual` is the calibration signal; ask for it even when the ticket felt routine.
- **Reads → the replica** (via the helper's `linear_read_ticket`, gated by cloud-detection); **writes → `linearis`**. See `references/data-source.md`.
- **A refresh failure never fails the ritual** — the corpus refresh in `references/corpus-refresh.md` is best-effort, off the critical path.
- **This skill owns content and data source, not the trigger.** How `compound-estimate` gets invoked after a merge is a separate concern (CTL-2244); this rewrite does not change when or how it fires.

## Output

Appends an entry to `thoughts/shared/retros/estimate/YYYY-WW-compound-log.md` (creating the
weekly file if needed). Weeks are ISO-8601, derived from the PR's `mergedAt`, not today's date.

## Related

- Spec/plan: `thoughts/shared/research/2026-04-24-CTL-159-compound-closing-ritual.md`,
  `thoughts/shared/plans/2026-04-24-CTL-159-compound-closing-ritual.md`
- Consumers: `compound-log.sh read`/`aggregate` → `refresh-corpus.sh` feeds `estimate_actual` into
  `reference-class-corpus.json`; `/catalyst-dev:ticket-retro` reads the weekly files for the
  estimation-calibration summary.
