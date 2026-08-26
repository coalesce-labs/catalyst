# Gather — prelude, "yesterday", "today"

## Prelude: start session, resolve date

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

## Gather "yesterday" — parallel MCP/CLI queries

> **Read source:** per the `linearis` skill's "Reading Linear" section, single-ticket reads go to
> the replica via direct SQL, gated by cloud-detection (`steward/references/cloud-detection.md`).
> `gather-linear.sh` below is a *filtered `issues list`* (an activity window, not a single-ticket
> read) — the list-shaped case that has no replica form yet, so it correctly stays on `linearis`.

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
`mcp__linear__*` / `mcp__notion__*` tools directly — write the result to `$SCRATCH/<source>.json`
in the same shape (`{"<source>": [...]}`).

## Gather "today"

- In-progress Linear tickets — `linearis issues list --team <team> --status "In Progress" --limit 20`
- Today's calendar — already gathered above, reuse `$SCRATCH/calendar.json`
- Follow-ups — extract action items from the prior day's Granola notes (`$SCRATCH/granola.json`) via a Claude-side synthesis pass
- **Retro signals** — the most recent `/catalyst-dev:ticket-retro` artifact's open watch-items, rendered as a `Plan today → Retro signals` sub-section. Degrades to an empty array (`_no data_`) when no retro has ever run.

```bash
# ── Retro signals: open watch-items from the latest retro ────────────────────
# Parse the machine contract (the fenced `yaml watch-items` block) from the
# newest thoughts/shared/retros/ticket/YYYY-MM-DD.md. Cap at 5 — the
# briefing surfaces the watch list, the retro doc holds the detail.
RETRO_DIR="thoughts/shared/retros/ticket"
: > "$SCRATCH/retro-signals.jsonl"
LATEST_RETRO=""
if [[ -d "$RETRO_DIR" ]]; then
  for rf in "$RETRO_DIR"/*.md; do
    [[ -e "$rf" ]] || continue
    [[ "$(basename "$rf" .md)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    [[ -z "$LATEST_RETRO" || "$rf" > "$LATEST_RETRO" ]] && LATEST_RETRO="$rf"
  done
fi
if [[ -n "$LATEST_RETRO" ]]; then
  awk '/^```yaml watch-items/{f=1; next} f && /^```/{f=0} f && /^- pattern:/ {
         sub(/^- pattern:[ ]*/, ""); gsub(/^"|"$/, ""); print
       }' "$LATEST_RETRO" | head -5 \
    | while IFS= read -r wi; do
        jq -nc --arg t "watch: $wi" '{title: $t}' >> "$SCRATCH/retro-signals.jsonl"
      done
fi

jq -nc --slurpfile rs <(jq -sc '.' "$SCRATCH/retro-signals.jsonl") \
  '{today: {linear_in_progress: [], calendar: [], followups: [],
            retro_signals: ($rs[0] // [])}}' > "$SCRATCH/today.json"
```
