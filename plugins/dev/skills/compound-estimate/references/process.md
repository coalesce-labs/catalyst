# Process — resolve, verify, collect, invoke, report

## 1. Resolve the ticket

If the user passed a ticket ID, use it. Otherwise:

```bash
BRANCH=$(git branch --show-current)
TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // "PROJ"' .catalyst/config.json)
TICKET_ID=$(echo "$BRANCH" | grep -oE "${TICKET_PREFIX}-[0-9]+" | head -1)
```

If no ticket can be resolved, ask the user explicitly. Do not guess.

## 2. Verify the PR is merged

The helper fails loud if `mergedAt` is missing, but give the user a clearer error up front:

```bash
PR_JSON=$(gh pr view --json number,state,mergedAt 2>/dev/null)
STATE=$(echo "$PR_JSON" | jq -r '.state')
if [ "$STATE" != "MERGED" ]; then
  echo "error: PR on current branch is not merged (state=$STATE). Run /compound-estimate after the PR merges."
  exit 1
fi
```

## 3. Collect the three human-authored inputs

Prompt the user interactively, one at a time. Keep prompts short and concrete — the estimate
re-scoring is the calibration signal, so don't skip it.

- **estimate_actual** — re-score on the CTL-746 T-shirt → points scale (XS=1, S=3, M=5, L=8,
  XL=13 — the same Fibonacci mirror `phase-triage` writes to `Issue.estimate`). Ask: "After
  shipping, what T-shirt would you set this ticket to? (XS/S/M/L/XL or integer 1/3/5/8/13)".
  Off-scale integers are accepted by the helper, but the corpus-refresh override ignores them.
- **what_worked** — "What worked? (one or two sentences)"
- **what_surprised_me** — "What surprised you? (one or two sentences — the highest-signal
  calibration input)"

Convert a T-shirt letter to its integer before passing it to the helper.

## 4. Invoke the helper

```bash
plugins/dev/scripts/compound-log.sh write "$TICKET_ID" \
  --estimate-actual "$EST_ACTUAL_INT" \
  --what-worked "$WHAT_WORKED" \
  --what-surprised-me "$WHAT_SURPRISED"
```

The helper resolves the rest — `pr_number` / `merged_at` / `created_at` via `gh pr view`,
`estimate_at_start` and `cost_usd` per `references/data-source.md`, and `wall_time_hours` computed
from PR `createdAt` → `mergedAt`.

## 5. Report back

On success, the helper prints the target file and a one-line summary. Show that to the user.

On failure, surface the helper's error verbatim — don't paraphrase it; see
`references/corpus-refresh.md` for the troubleshooting table.
