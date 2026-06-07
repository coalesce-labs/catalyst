---
name: compound-estimate
description:
  "Closing ritual for the AI-native estimation feedback loop. **ALWAYS use when** a ticket's PR
  has just merged (runs automatically per ticket: merge-pr step 12b / phase-monitor-merge,
  CTL-189/CTL-831), or when the user says 'compound-estimate', 'close the estimation loop',
  'record actuals', 'compound-log', or wants to log post-merge actuals for a shipped Linear
  ticket. Writes a structured entry (linear.key, pr_number, merged_at, estimate_at_start,
  estimate_actual, cost_usd, wall_time_hours, what_worked, what_surprised_me)
  to `thoughts/shared/retros/estimate/YYYY-WW-compound-log.md` — one file per ISO week, appends."
disable-model-invocation: false
allowed-tools: Bash(gh *), Bash(linearis *), Bash(jq *), Bash(git *), Bash(./plugins/dev/scripts/compound-log.sh *), Bash(plugins/dev/scripts/compound-log.sh *), Bash(./plugins/pm/scripts/estimate/refresh-corpus.sh *), Bash(plugins/pm/scripts/estimate/refresh-corpus.sh *), Read, Write
version: 1.0.0
---

# Compound Estimate — Closing Ritual at PR Merge

Write a compound-log entry for a just-shipped ticket. This is the Phase 1 exit gate for AI-native estimation: without this closer, `claude-code-otel` cost/wall-time signals never feed future estimates and the calibration loop stays open.

The skill delegates all mechanical work to `plugins/dev/scripts/compound-log.sh`. Your job is to collect the three human-authored inputs (estimate_actual, what_worked, what_surprised_me) and invoke the helper.

## Invocation

```
/compound-estimate <TICKET-ID>
```

**Inputs:**
- `<TICKET-ID>` — required. Linear ticket key (e.g. `CTL-159`). If omitted, detect from the current branch name (`gh pr view --json headRefName` → parse ticket prefix).

## Output

Appends an entry to `thoughts/shared/retros/estimate/YYYY-WW-compound-log.md`, creating the weekly file with a header if it doesn't exist. Weeks are ISO-8601 and derived from the PR's `mergedAt` (not today's date).

## Process

### 1. Resolve the ticket

If the user passed a ticket ID, use it. Otherwise:

```bash
BRANCH=$(git branch --show-current)
# Extract ticket prefix from .catalyst/config.json
TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // "PROJ"' .catalyst/config.json)
TICKET_ID=$(echo "$BRANCH" | grep -oE "${TICKET_PREFIX}-[0-9]+" | head -1)
```

If no ticket can be resolved, ask the user explicitly. Do not guess.

### 2. Verify the PR is merged

The helper will fail loud if `mergedAt` is missing, but give the user a clearer error up front:

```bash
PR_JSON=$(gh pr view --json number,state,mergedAt 2>/dev/null)
STATE=$(echo "$PR_JSON" | jq -r '.state')
if [ "$STATE" != "MERGED" ]; then
  echo "error: PR on current branch is not merged (state=$STATE). Run /compound-estimate after the PR merges."
  exit 1
fi
```

### 3. Collect the three human-authored inputs

Prompt the user interactively (one at a time). Keep the prompts short and concrete; the estimate re-scoring is the calibration signal, so do not skip it.

- **estimate_actual** — re-score the ticket on the CTL-746 T-shirt → points scale (XS=1, S=3, M=5, L=8, XL=13 — the same Fibonacci mirror `phase-triage` writes to `Issue.estimate`). Ask: "After shipping, what T-shirt would you set this ticket to? (XS/S/M/L/XL or integer 1/3/5/8/13)". Off-scale integers are accepted by the helper but the corpus-refresh override ignores them — stick to the scale.
- **what_worked** — ask: "What worked? (one or two sentences)"
- **what_surprised_me** — ask: "What surprised you? (one or two sentences — this is the highest-signal calibration input)"

If the user answers with a T-shirt letter, convert to the integer before passing to the helper.

### 4. Invoke the helper

```bash
plugins/dev/scripts/compound-log.sh write "$TICKET_ID" \
  --estimate-actual "$EST_ACTUAL_INT" \
  --what-worked "$WHAT_WORKED" \
  --what-surprised-me "$WHAT_SURPRISED"
```

The helper resolves the rest:
- `pr_number`, `merged_at`, `created_at` via `gh pr view`
- `estimate_at_start` via `linearis issues read <ticket> | jq .estimate`
- `cost_usd` from `catalyst-state.sh` worker aggregate (orchestrator mode) or `catalyst-session.sh history --ticket` (local fallback)
- `wall_time_hours` computed from PR `createdAt` → `mergedAt`

### 5. Report back

On success, the helper prints the target file and a one-line summary. Show that to the user.

### 6. Opportunistic corpus refresh (CTL-813 — off the critical path)

After a successful write, check whether the committed reference-class corpus is stale and offer to
refresh it. **Best-effort: a refresh failure never fails the ritual.**

```bash
CORPUS="plugins/pm/scripts/estimate/reference-class-corpus.json"
STALE=$(jq -r '
  (.generated_at // "1970-01-01T00:00:00Z")
  | sub("\\.[0-9]+"; "")
  | (try fromdateiso8601 catch 0)
  | (now - .) > 604800
' "$CORPUS" 2>/dev/null || echo "false")
```

If `STALE` is `true` (corpus older than 7 days), tell the user and offer to run the refresh:

```bash
plugins/pm/scripts/estimate/refresh-corpus.sh
```

It re-runs Extract → Collect → Score and merges fresh entries over the committed corpus (your
just-written `estimate_actual` flows in as the human ground-truth override). The refresh leaves the
corpus change in the working tree — show the user the summary line and let them commit/PR it (or
re-run with `--commit`). If the user declines or the refresh fails, log and move on.

On failure, surface the helper's error verbatim. The helper fails loud with actionable messages — don't paraphrase them. Common causes and fixes:

| Error fragment | Meaning | Fix |
|---|---|---|
| `required: --estimate-actual` | You did not collect the re-score | Re-prompt the user |
| `PR #N has no mergedAt` | PR isn't merged yet | Run after merge |
| `could not resolve estimate via linearis` | Linear unreachable or ticket has no estimate | Pass `--estimate-start <int>` |
| `no cost data for <ticket> in catalyst-state or session history` | No cost telemetry captured for this ticket | Pass `--cost-usd <float>` explicitly |
| `already exists in ...; pass --force to replace` | Skill was run twice for same (ticket, pr) | Either skip, or re-run with `--force` |

## Flags the helper accepts (for power users or auto-trigger from other skills)

```
plugins/dev/scripts/compound-log.sh write <ticket> [options]

  --pr <number>               PR number (default: gh pr view on current branch)
  --merged-at <iso-ts>        override (default: gh pr view mergedAt)
  --created-at <iso-ts>       override (default: gh pr view createdAt)
  --estimate-start <int>      override (default: linearis .estimate)
  --estimate-actual <int>     REQUIRED — post-merge re-score on same scale
  --cost-usd <float>          override (default: catalyst-state/session aggregate)
  --wall-time-hours <float>   override (default: computed from PR timestamps)
  --what-worked <text>        REQUIRED
  --what-surprised-me <text>  REQUIRED
  --thoughts-dir <path>       override thoughts root (default: ./thoughts)
  --force                     replace existing (ticket, pr) entry
  --dry-run                   print entry; write nothing
```

## Schema of a written entry

Each entry is a level-3 heading with a fenced YAML block. Machine consumers (CTL-813): read them
back with `plugins/dev/scripts/compound-log.sh read` (JSON Lines) or `… aggregate` (per-ticket
latest + calibration stats) — `refresh-corpus.sh` joins `estimate_actual` into the reference-class
corpus as the human ground-truth override.

```markdown
### CTL-159 — #273 — 2026-04-24T18:32:10Z

```yaml
linear_key: CTL-159
pr_number: 273
merged_at: 2026-04-24T18:32:10Z
estimate_at_start: 3     # CTL-746 scale: 3 → S
estimate_actual: 5       # CTL-746 scale: 5 → M
cost_usd: 2.47
wall_time_hours: 3.2
what_worked: "Tests-first TDD kept the helper script testable."
what_surprised_me: "Prometheus integration wasn't plumbed; local state.json sufficed."
```
```

## Data source notes

- **Primary cost source** is local: the `catalyst-state.sh` worker-usage aggregate (when orchestrated) or `catalyst-session.sh history` (standalone). This is deliberate — `claude-code-otel` + Prometheus is referenced in the original spec but not yet wired up in this repo.
- **Prometheus overlay** is gated by `CATALYST_PROMETHEUS_URL`. When set, the helper logs a note to stderr; the HTTP client itself is a follow-up ticket.
- **Linear estimate** is read as an integer from `linearis issues read`. The team's estimation config (T-shirt, Fibonacci, linear) is applied client-side when re-scoring in step 3.

## Testing

```bash
bash plugins/dev/scripts/__tests__/compound-log.test.sh
```

Covers ISO-week derivation, happy-path writes, append-idempotence, dedup + `--force`, fail-loud paths for each required field, wall-time computation, and mergedAt-based week routing.

## Related

- Spec: `thoughts/shared/research/2026-04-24-CTL-159-compound-closing-ritual.md`
- Plan: `thoughts/shared/plans/2026-04-24-CTL-159-compound-closing-ritual.md`
- Auto-invoked (CTL-189/CTL-813): interactively from `merge-pr` step 12b; autonomously
  (agent-authored re-score) from `phase-monitor-merge` after the merge lands
- Consumers (CTL-813): `compound-log.sh read`/`aggregate` → `refresh-corpus.sh` feeds
  `estimate_actual` into `reference-class-corpus.json`; `/catalyst-dev:ticket-retro` reads the
  weekly files for the estimation-calibration summary
