# Label management

## Discover labels

```bash
linearis labels list --team ENG
linearis labels list --team ENG | jq '.nodes[] | {name, color}'
```

## See what a label contains

```bash
linearis issues list --team ENG --label "bug" --limit 100
linearis issues list --team ENG --label "tech-debt" --limit 100
```

## Re-label tickets

```bash
# Add a label (keeps existing labels)
linearis issues update ENG-123 --labels "needs-triage" --label-mode add

# Replace all labels
linearis issues update ENG-123 --labels "bug,P1" --label-mode overwrite

# Remove all labels
linearis issues update ENG-123 --clear-labels
```

> **`--labels` defaults to OVERWRITE.** Omitting `--label-mode` replaces every label on the
> ticket, silently dropping the ones you did not name. Pass `--label-mode add` unless you
> positively intend a full replacement.

## Trap: a label name can exist on more than one team

A team-scoped label is identified by `(name, team)`, and a workspace can hold **two different
labels with the same name on different teams**. A migration or a team split leaves exactly that.
Applying the label **by name** then fails even though the label plainly exists on the issue's team:

```
linearis issues update PROJ-123 --labels orchestrator
  -> "LabelIds for incorrect team — The label 'orchestrator' is not
      associated with the same team as the issue."
```

The failure is **name→id resolution**, not a missing vocabulary: the name resolved to the other
team's twin. `labels list --team <TEAM>` is *correct* and lists only applicable labels, which is
exactly why this is easy to misread as "discovery and write disagree."

**Step 1 — replica first (free, no API quota).** Confirm which team's issues actually carry the
name, and get the label id, without touching Linear:

```bash
sqlite3 -separator '  ' ~/catalyst/catalyst-replica.db "
  SELECT l.name, l.id, i.team_key, COUNT(*) AS issues
    FROM issue_labels il
    JOIN labels l  ON l.id = il.label_id
    JOIN issues i  ON i.id = il.issue_id
   WHERE l.name = 'orchestrator'
   GROUP BY l.name, l.id, i.team_key;"
```

This answers "which id is in use on MY team's issues" — usually all you need.

**Step 2 — only if step 1 is inconclusive.** The replica **cannot** prove a duplicate exists (its
`labels` table carries no team column and mirrors only this team's issues), so this is the
documented single-bounded-check last resort — run **once**, never in a loop or script:

```bash
# LAST RESORT — one call, one label name, during an active diagnosis only.
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ issueLabels(filter:{name:{eq:\"orchestrator\"}},first:50){ nodes{ id name team{ key } } } }"}' \
  | jq -r '.data.issueLabels.nodes[] | "\(.name)\tteam=\(.team.key // "WORKSPACE")\t\(.id)"'
```

**Apply by UUID** — the only unambiguous form when a name is duplicated:

```bash
linearis issues update PROJ-123 --labels <label-uuid> --label-mode add
```

Two things that make this trap hard to see:

- **Workspace-scoped labels are immune.** A label with no team (`team=WORKSPACE`) has no twin to
  disambiguate against, so type vocabularies like `bug`/`feature`/`chore` keep resolving by name
  while every component label fails. Half your labels working is not evidence the rest are broken
  differently — it is evidence they are team-scoped.
- **The error names the label, not the team.** It reads as "this label is on the wrong team", when
  the truth is "the name you gave me resolved to a label on the wrong team, and the right one
  exists too."
