# Corpus refresh, flags, schema, testing, troubleshooting

## Opportunistic corpus refresh (off the critical path)

After a successful write, check whether the committed reference-class corpus is stale and offer to refresh it. **Best-effort: a refresh failure never fails the ritual.**

```bash
CORPUS="plugins/dev/scripts/estimate/reference-class-corpus.json"
STALE=$(jq -r '
  (.generated_at // "1970-01-01T00:00:00Z")
  | sub("\\.[0-9]+"; "")
  | (try fromdateiso8601 catch 0)
  | (now - .) > 604800
' "$CORPUS" 2>/dev/null || echo "false")
```

If `STALE` is `true` (corpus older than 7 days), tell the user and offer to run:

```bash
plugins/dev/scripts/estimate/refresh-corpus.sh
```

It re-runs Extract → Collect → Score and merges fresh entries over the committed corpus (the just-written `estimate_actual` flows in as the human ground-truth override). The refresh leaves the change in the working tree — show the summary line and let the user commit/PR it (or re-run with `--commit`). If the user declines or the refresh fails, log and move on.

## Flags the helper accepts (power users, or auto-trigger from other skills)

```
plugins/dev/scripts/compound-log.sh write <ticket> [options]

  --pr <number>               PR number (default: gh pr view on current branch)
  --merged-at <iso-ts>        override (default: gh pr view mergedAt)
  --created-at <iso-ts>       override (default: gh pr view createdAt)
  --estimate-start <int>      override (default: linearis .estimate)
  --estimate-actual <int>     REQUIRED — post-merge re-score on same scale
  --cost-usd <float>          override (default: local aggregate — see references/data-source.md)
  --wall-time-hours <float>   override (default: computed from PR timestamps)
  --what-worked <text>        REQUIRED
  --what-surprised-me <text>  REQUIRED
  --thoughts-dir <path>       override thoughts root (default: ./thoughts)
  --force                     replace existing (ticket, pr) entry
  --dry-run                   print entry; write nothing
```

## Schema of a written entry

```markdown
### CTL-159 — #273 — 2026-04-24T18:32:10Z

​```yaml
linear_key: CTL-159
pr_number: 273
merged_at: 2026-04-24T18:32:10Z
estimate_at_start: 3     # CTL-746 scale: 3 → S
estimate_actual: 5       # CTL-746 scale: 5 → M
cost_usd: 2.47
wall_time_hours: 3.2
what_worked: "Tests-first TDD kept the helper script testable."
what_surprised_me: "Prometheus integration wasn't plumbed; local state.json sufficed."
​```
```

Read entries back with `compound-log.sh read` (JSON Lines) or `... aggregate` (per-ticket latest + calibration stats).

## Testing

```bash
bash plugins/dev/scripts/__tests__/compound-log.test.sh
```

Covers ISO-week derivation, happy-path writes, append-idempotence, dedup + `--force`, fail-loud paths for each required field, wall-time computation, and mergedAt-based week routing.

## Troubleshooting

| Error fragment | Meaning | Fix |
|---|---|---|
| `required: --estimate-actual` | You did not collect the re-score | Re-prompt the user |
| `PR #N has no mergedAt` | PR isn't merged yet | Run after merge |
| `could not resolve estimate via linearis` | Linear unreachable, or ticket has no estimate | Pass `--estimate-start <int>` |
| `no cost data for <ticket> in local aggregates` | No cost telemetry resolved locally | Pass `--cost-usd <float>` explicitly |
| `already exists in ...; pass --force to replace` | Skill was run twice for the same (ticket, pr) | Skip, or re-run with `--force` |
