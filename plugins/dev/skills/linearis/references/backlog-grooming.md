# Backlog grooming

> ⛔ **Assign the stage name, then check it — never inline `$(state …)` into the query (CTL-2300, Codex round 2).** A command substitution used as an *argument* does not propagate its exit status, so a refused slot leaves `linearis` running with an empty `--status` and the named refusal becomes an empty result set. `VAR=$(state slot) || exit 1` DOES propagate: the assignment's status is the substitution's. `state() { bash "$CLAUDE_PLUGIN_ROOT/scripts/linear-transition.sh" --print-state --transition "$1" --team "$TEAM"; }`


Cookbook for a grooming pass: lay of the land, pull by project, find orphans, triage by priority, find stale tickets. All reads here are bulk `linearis` calls (not the replica) because they cross many tickets at once — the replica has no bulk-query CLI form yet (see the `linearis` skill's "Reading Linear" → "Still needs linearis").

## Get the lay of the land

```bash
linearis teams list | jq '.nodes[] | {key, name}'
linearis projects list | jq '.nodes[] | {name, status: .status.name, id}'
```

## Pull tickets by project

```bash
linearis issues list --project "Auth System" --limit 100

# Grouped by status (requires --team for --status filter)
linearis issues list --team "$TEAM" --project "Auth System" --status "$(state backlog),$(state todo)" --limit 100
```

## Find orphaned tickets (no project assigned)

```bash
linearis issues list --team ENG --limit 200 | jq '[.nodes[] | select(.project == null)] | length'
linearis issues list --team ENG --limit 200 | jq '.nodes[] | select(.project == null) | {identifier, title, state: .state.name}'
```

## Triage by priority

```bash
linearis issues list --team ENG --priority 1 --limit 50   # urgent
linearis issues list --team ENG --priority 2 --limit 50   # high

# Unestimated tickets in a project
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.estimate == null) | {identifier, title}'
```

## Find stale tickets

```bash
# Not updated in 30+ days
linearis issues list --team "$TEAM" --updated-before 2026-03-13 --status "$(state inProgress)" --limit 50
```

## Assign a ticket to a project

```bash
linearis issues update ENG-123 --project "Auth System"
```
