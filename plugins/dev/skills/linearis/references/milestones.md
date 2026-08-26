# Milestone management

## See milestones for a project

```bash
linearis milestones list --project "Auth System"
```

## Read milestone details (including its issues)

```bash
linearis milestones read "Beta Launch" --project "Auth System"
linearis milestones read "Beta Launch" --project "Auth System" --limit 100
```

## Create a milestone

```bash
linearis milestones create "Beta Launch" --project "Auth System" --target-date 2026-06-15
linearis milestones create "GA Release" --project "Auth System" --description "General availability" --target-date 2026-09-01
```

## Rename or reschedule a milestone

```bash
linearis milestones update "Beta Launch" --project "Auth System" --name "Beta 2.0"
linearis milestones update "Beta Launch" --project "Auth System" --target-date 2026-07-01
```

## Assign tickets to a milestone

```bash
linearis issues update ENG-123 --project-milestone "Beta Launch"

# Clear a milestone assignment
linearis issues update ENG-123 --clear-project-milestone
```

## Audit milestone coverage

```bash
# Tickets in a project with no milestone
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.projectMilestone == null) | {identifier, title}'
```

## Gotcha: milestone/cycle name resolution isn't globally unique

Milestone names can collide across projects — always pass `--project` (or a UUID) on
`milestones read`/`update`. `cycles list --active`/`--window <n>` are team-scoped — always pair
with `--team` or you may grab another team's cycle (linearis skill Gotcha #7).
