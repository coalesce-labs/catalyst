---
name: compound
description:
  "Closing ritual for the AI-native estimation feedback loop. **ALWAYS use when** the user says
  'compound', 'close the loop', 'record learnings', 'compound-log', or wants to log post-merge
  actuals for a shipped Linear ticket. Writes a structured entry (linear.key, pr_number, merged_at,
  estimate_at_start, estimate_actual, cost_usd, wall_time_hours, what_worked, what_surprised_me)
  to `thoughts/shared/pm/metrics/YYYY-WW-compound-log.md` — one file per ISO week, appends."
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(linearis *), Bash(jq *), Bash(git *), Bash(./plugins/dev/scripts/compound-log.sh *), Bash(plugins/dev/scripts/compound-log.sh *), Read, Write
version: 1.0.0
---

# Compound — Closing Ritual at PR Merge

Write a compound-log entry for a just-shipped ticket. This is the Phase 1 exit gate for AI-native estimation: without this closer, `claude-code-otel` cost/wall-time signals never feed future estimates and the calibration loop stays open.

The skill delegates all mechanical work to `plugins/dev/scripts/compound-log.sh`. Your job is to collect the three human-authored inputs (estimate_actual, what_worked, what_surprised_me) and invoke the helper.

## Invocation

```
/compound <TICKET-ID>
```

**Inputs:**
- `<TICKET-ID>` — required. Linear ticket key (e.g. `CTL-159`). If omitted, detect from the current branch name (`gh pr view --json headRefName` → parse ticket prefix).

## Output

Appends an entry to `thoughts/shared/pm/metrics/YYYY-WW-compound-log.md`, creating the weekly file with a header if it doesn't exist. Weeks are ISO-8601 and derived from the PR's `mergedAt` (not today's date).

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
  echo "error: PR on current branch is not merged (state=$STATE). Run /compound after the PR merges."
  exit 1
fi
```

### 3. Collect the three human-authored inputs

Prompt the user interactively (one at a time). Keep the prompts short and concrete; the estimate re-scoring is the calibration signal, so do not skip it.

- **estimate_actual** — re-score the ticket on the same T-shirt scale used at ticket creation (XS=1, S=2, M=3, L=5, XL=8). Ask: "After shipping, what T-shirt would you set this ticket to? (XS/S/M/L/XL or integer 1/2/3/5/8)"
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

Each entry is a level-3 heading with a fenced YAML block (parseable by the forthcoming `/pm:weekly-cycle-review` aggregator):

```markdown
### CTL-159 — #273 — 2026-04-24T18:32:10Z

```yaml
linear_key: CTL-159
pr_number: 273
merged_at: 2026-04-24T18:32:10Z
estimate_at_start: 3     # team scale: 3 → M
estimate_actual: 5       # team scale: 5 → L
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
- Unblocks: CTL-189 (auto-invoke from `merge-pr` / `oneshot` Phase 5)
- Consumer (future): `/pm:weekly-cycle-review` reads all `YYYY-WW-compound-log.md` files and joins to Linear cycle data for the retrospective
