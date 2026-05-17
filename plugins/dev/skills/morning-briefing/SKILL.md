---
name: morning-briefing
description:
  Generate a daily briefing markdown at thoughts/briefings/YYYY-MM-DD.md with four sections —
  Review yesterday, Surface decisions, Plan today, Suggest orchestrator runs — synthesized from
  Linear, GitHub, Granola, Google Drive, and Google Calendar in parallel. User-invoked from
  `/catalyst-dev:morning-briefing` for ad-hoc runs. The CMA Routine wraps the same skill on a
  weekday-morning schedule (Phase 5 of the parent plan).
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, mcp__linear__*, mcp__notion__*
---

# Morning Briefing — canonical markdown MVP

## When to use

Invoke as `/catalyst-dev:morning-briefing` to produce today's briefing locally. Multi-output
fan-out (Slack DM, Notion, channel post, Loom script) is **Phase 3** of the parent plan
([[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 2 Phase 3) and lives in different
files; this skill only emits the canonical markdown.

## Flags

| Flag | Meaning |
|---|---|
| `--date YYYY-MM-DD` | Target date. Default: today (UTC). |
| `--dry-run` | Write to `/tmp/morning-briefing-<date>.md` instead of `thoughts/briefings/`. |

## Step 1: Prelude — start session, resolve date

```bash
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/morning-briefing"
SESSION_SCRIPT="${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/catalyst-session.sh"

CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "morning-briefing" \
  --ticket "" --workflow "${CATALYST_SESSION_ID:-}")
export CATALYST_SESSION_ID

# Resolve target date + output path. Pass --dry-run / --date through from the user.
OUT_PATH=$(bash "$SCRIPT_DIR/output-path.sh" "$@")
DATE=$(basename "$OUT_PATH" .md | sed 's/^morning-briefing-//')
echo "Target date: $DATE"
echo "Output path: $OUT_PATH"
```

## Step 2: Gather "yesterday" — parallel MCP/CLI queries

Launch the five gather helpers in parallel. Each prints a JSON fragment to its own scratch file;
each degrades silently to `{}` if its credentials are absent so the briefing always renders.

```bash
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

bash "$SCRIPT_DIR/gather-linear.sh"   --date "$DATE" > "$SCRATCH/linear.json"   &
bash "$SCRIPT_DIR/gather-github.sh"   --date "$DATE" > "$SCRATCH/github.json"   &
bash "$SCRIPT_DIR/gather-granola.sh"  --date "$DATE" > "$SCRATCH/granola.json"  &
bash "$SCRIPT_DIR/gather-drive.sh"    --date "$DATE" > "$SCRATCH/drive.json"    &
bash "$SCRIPT_DIR/gather-calendar.sh" --date "$DATE" > "$SCRATCH/calendar.json" &
wait
```

If a richer Linear or Notion query is needed beyond what the CLI/REST helpers expose, use the
`mcp__linear__*` / `mcp__notion__*` tools directly from this skill — write the result to
`$SCRATCH/<source>.json` in the same shape (`{"<source>": [...]}`).

## Step 3: Gather "decisions"

For the MVP, populate the `decisions:` array from two heuristics:

1. **Blocked PRs** — `gh search prs --review-requested @me --state open --json …` filtered to
   PRs with no commit in the last 48h. Each becomes one `{type: blocked_pr, …}` decision.
2. **Judgment-call Linear tickets** — `linearis issues list --team <team> --status "Triage,In Progress" --label needs-decision` (label name is informational; substitute whatever signal the operator uses).

ADR drift detection is **Phase 4** of the parent plan — do NOT implement it here. Emit an empty
list if no signals are found.

Synthesize into a `decisions.json` fragment:

```bash
cat > "$SCRATCH/decisions.json" <<JSON
{"decisions": []}
JSON
# Append blocked-PR decisions / judgment-call decisions as discovered.
```

## Step 4: Gather "today"

- In-progress Linear tickets — `linearis issues list --team <team> --status "In Progress" --limit 20`
- Today's calendar — already gathered in Step 2, reuse `$SCRATCH/calendar.json`
- Follow-ups — extract action items from the prior day's Granola notes (`$SCRATCH/granola.json`)
  via a Claude-side synthesis pass

```bash
cat > "$SCRATCH/today.json" <<JSON
{"today": {"linear_in_progress": [], "calendar": [], "followups": []}}
JSON
```

## Step 5: Suggest orchestrator runs

Query Linear for tickets that look ready for `/catalyst-dev:orchestrate`:

```bash
linearis issues list \
  --team "$(jq -r '.catalyst.linear.teamKey' .catalyst/config.json)" \
  --status "Triage,Backlog" \
  --priority 1 --priority 2 \
  --limit 10 \
  2>/dev/null \
  | jq -c '{suggested_runs: ([.[] | select(.relations.nodes // [] | map(select(.type=="blocked_by")) | length == 0)] | map({id: .identifier, title: .title, priority: (.priority|tostring)}))}' \
  > "$SCRATCH/suggested.json" 2>/dev/null || echo '{"suggested_runs": []}' > "$SCRATCH/suggested.json"
```

## Step 6: Render the markdown

Merge all fragments into one input JSON, then call `render.sh`.

```bash
jq -s --arg date "$DATE" '
  {date: $date}
  + {yesterday: ((.[0] // {}) + (.[1] // {}) + (.[2] // {}) + (.[3] // {}) + (.[4] // {}))}
  + (.[5] // {})
  + (.[6] // {})
  + (.[7] // {})
' \
  "$SCRATCH/linear.json" \
  "$SCRATCH/github.json" \
  "$SCRATCH/granola.json" \
  "$SCRATCH/drive.json" \
  "$SCRATCH/calendar.json" \
  "$SCRATCH/decisions.json" \
  "$SCRATCH/today.json" \
  "$SCRATCH/suggested.json" \
  > "$SCRATCH/input.json"

bash "$SCRIPT_DIR/render.sh" --input "$SCRATCH/input.json" --output "$OUT_PATH"

# Sanity-check the frontmatter against the schema before declaring success.
bash "$SCRIPT_DIR/validate-frontmatter.sh" "$OUT_PATH"
```

## Step 7: End session

```bash
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done --reason "morning-briefing rendered"
echo "Wrote: $OUT_PATH"
```

## Output contract

The rendered markdown has YAML frontmatter validated against
`plugins/dev/templates/briefing-frontmatter.schema.json` (required fields: `date`,
`generated_by`, `decisions`). Four `## ...` sections follow. Empty sources render
`_no data_` rather than failing.

Downstream Phase 3 fan-out scripts read this file as their sole input — they MUST NOT
re-query the source MCPs.
