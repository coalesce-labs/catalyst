# Suggest relay-dispatch candidates

Query Linear for tickets that look ready for a `/relay-ticket <TICKET>` dispatch — unblocked, high-priority, sitting in the tenant's triage or backlog stage. This is the same shape of readiness question `steward` asks before dispatching (`steward/references/readiness.md`), scoped here to a daily top-10 surfaced for a human to skim rather than acted on automatically:

⛔ **The stage names are resolved from the tenant's own `stateMap`, never typed (CTL-2300).** A board that calls its first stage something else — CTC-1597 renamed one mid-flight — returns an EMPTY list from `--status`, not an error, so a briefing built on typed names reports a quiet morning it cannot distinguish from a wrong query.

```bash
TEAM="$(jq -r '.catalyst.linear.teamKey' .catalyst/config.json)"
state() { bash "$CLAUDE_PLUGIN_ROOT/scripts/linear-transition.sh" --print-state --transition "$1" --team "$TEAM"; }

linearis issues list \
  --team "$TEAM" \
  --status "$(state triage),$(state backlog)" \
  --priority 1 --priority 2 \
  --limit 10 \
  2>/dev/null \
  | jq -c '{suggested_runs: ([.[] | select(.relations.nodes // [] | map(select(.type=="blocked_by")) | length == 0)] | map({id: .identifier, title: .title, priority: (.priority|tostring)}))}' \
  > "$SCRATCH/suggested.json" 2>/dev/null || echo '{"suggested_runs": []}' > "$SCRATCH/suggested.json"
```

`suggested_runs` is the fixed JSON key `render.sh` reads — do not rename it.

## Known residual: the rendered heading still says "orchestrator"

`render.sh` (a sibling script, unchanged by this rewrite) hardcodes the body heading as `## Suggest orchestrator runs`. The **candidates and their meaning** are relay-dispatch candidates as of CTL-2218 — nothing here still means "run the legacy orchestrator" — but the literal heading text in the rendered markdown has not been repointed. Read the section by what it does (ready-for-`/relay-ticket` candidates), not by that residual label, until a follow-up touches `render.sh` to rename it.
