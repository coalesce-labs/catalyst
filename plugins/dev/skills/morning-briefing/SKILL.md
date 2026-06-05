---
name: morning-briefing
description:
  Generate a daily briefing markdown at thoughts/briefings/YYYY-MM-DD.md with four sections —
  Review yesterday, Surface decisions, Plan today, Suggest orchestrator runs — synthesized from
  Linear, GitHub, Granola, Google Drive, and Google Calendar in parallel. Then fans the briefing
  out to four destinations (Slack DM, Slack channel, Notion page, Loom script file). User-invoked
  from `/catalyst-dev:morning-briefing` for ad-hoc runs. The CMA Routine wraps the same skill on
  a weekday-morning schedule (Phase 5 of the parent plan).
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, mcp__linear__*, mcp__notion__*
---

# Morning Briefing — canonical markdown + fan-out

## When to use

Invoke as `/catalyst-dev:morning-briefing` to produce today's briefing locally and fan it out
to Slack DM, Slack channel, Notion page, and a Loom recording script
([[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 2 Phase 3).

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

Populate the `decisions:` array from three sources:

1. **ADR drift** — `adr-drift.sh` reads ADR `code_assertions` frontmatter and surfaces patterns
   that drift from the codebase. See [ADR-DRIFT.md](./ADR-DRIFT.md).
2. **Blocked PRs** — `gh search prs --review-requested @me --state open --json …` filtered to
   PRs with no commit in the last 48h. Each becomes one `{type: blocked_pr, …}` decision.
3. **Judgment-call Linear tickets** — `linearis issues list --team <team> --status "Triage,In Progress" --label needs-decision` (label name is informational; substitute whatever signal the operator uses).

Synthesize into a `decisions.json` fragment:

```bash
# ADR drift detection (CTL-459)
bash "$SCRIPT_DIR/adr-drift.sh" --root "$(pwd)" > "$SCRATCH/adr-drift.json"

# Blocked-PR + judgment-call sources are still TODO — start with an empty fragment.
echo '{"decisions": []}' > "$SCRATCH/decisions-other.json"

# Merge all decision sources into one fragment
jq -s '{decisions: (((.[0] // {}).decisions // []) + ((.[1] // {}).decisions // []))}' \
  "$SCRATCH/adr-drift.json" "$SCRATCH/decisions-other.json" > "$SCRATCH/decisions.json"
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

Query Linear for tickets that look ready for `/catalyst-legacy:orchestrate`:

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

## Step 7: Fan-out (CTL-458)

Run the four fan-outs in parallel against the canonical briefing file. Each script writes a
status JSON document on stdout; the helper merges those into an `output_status:` block in the
briefing frontmatter. Each fan-out degrades silently to `{"status":"skipped"}` if its
credentials or destination ID are missing — the briefing always lands locally regardless.

```bash
mkdir -p "$SCRATCH/output-status"

bash "$SCRIPT_DIR/fanout-slack-dm.sh"      --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/slack-dm.json"      &
bash "$SCRIPT_DIR/fanout-slack-channel.sh" --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/slack-channel.json" &
bash "$SCRIPT_DIR/fanout-notion.sh"        --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/notion.json"        &
bash "$SCRIPT_DIR/fanout-loom-script.sh"   --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/loom-script.json"   &
wait

bash "$SCRIPT_DIR/write-output-status.sh" --in "$OUT_PATH" --statuses "$SCRATCH/output-status"

# Re-validate after fan-out — output_status is optional in the schema but we
# want to fail loudly if a fan-out wrote malformed JSON.
bash "$SCRIPT_DIR/validate-frontmatter.sh" "$OUT_PATH"
```

Fan-out destinations and their config keys:

| Script                       | Credentials env var | Destination key (`.catalyst.briefing.*`) | Profile  |
|------------------------------|---------------------|------------------------------------------|----------|
| `fanout-slack-dm.sh`         | `SLACK_BOT_TOKEN`   | `slackDmUserId`                          | `dm`     |
| `fanout-slack-channel.sh`    | `SLACK_BOT_TOKEN`   | `slackChannelId`                         | `channel`|
| `fanout-notion.sh`           | `NOTION_TOKEN`      | `notionPageId`                           | `notion` |
| `fanout-loom-script.sh`      | (none — local file) | (writes `<date>-loom-script.md`)         | `loom`   |

Sanitization profiles (see `sanitize.sh`):

- `dm` — full content preserved.
- `channel` / `notion` / `loom` — strip `decisions[].summary` and `decisions[].status`, rewrite
  the `## Surface decisions` body section to `_redacted_`, redact customer names from
  `.catalyst.briefing.sanitizationRedactList` (case-insensitive, whole-word), and redact PR URLs
  whose body contains any redact-list string.

## Step 8: End session

```bash
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done --reason "morning-briefing rendered + fan-out"
echo "Wrote: $OUT_PATH"
```

## Output contract

The rendered markdown has YAML frontmatter validated against
`plugins/dev/templates/briefing-frontmatter.schema.json` (required fields: `date`,
`generated_by`, `decisions`; optional `output_status` block populated by Step 7).
Four `## ...` sections follow. Empty sources render `_no data_` rather than failing.

A companion `<date>-loom-script.md` lands beside the briefing whenever Step 7's loom fan-out
runs (always, since it has no credential prerequisite).
