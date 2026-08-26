# Cycle review

## Get the active cycle

```bash
linearis cycles list --team ENG --active
```

## Read cycle with all issues

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100
```

## Summarize cycle progress

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100 | jq '
  .issues
  | group_by(.state.name)
  | map({status: .[0].state.name, count: length, tickets: [.[].identifier]})
'
```

## Nearby cycles (for planning)

```bash
# Active cycle plus 2 before and after
linearis cycles list --team ENG --window 2
```

`cycles list --active`/`--window <n>` are team-scoped — always pair with `--team` or you may grab another team's cycle (linearis skill Gotcha #7).
