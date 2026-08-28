# Render + fan-out

## Render the markdown

Merge all fragments into one input JSON, then call `render.sh`:

```bash
jq -s --arg date "$DATE" '
  {date: $date}
  + {yesterday: ((.[0] // {}) + (.[1] // {}) + (.[2] // {}) + (.[3] // {}) + (.[4] // {}))}
  + (.[5] // {})
  + (.[6] // {})
  + (.[7] // {})
' \
  "$SCRATCH/linear.json" "$SCRATCH/github.json" "$SCRATCH/granola.json" \
  "$SCRATCH/drive.json" "$SCRATCH/calendar.json" "$SCRATCH/decisions.json" \
  "$SCRATCH/today.json" "$SCRATCH/suggested.json" \
  > "$SCRATCH/input.json"

bash "$SCRIPT_DIR/render.sh" --input "$SCRATCH/input.json" --output "$OUT_PATH"

# Sanity-check the frontmatter against the schema before declaring success.
bash "$SCRIPT_DIR/validate-frontmatter.sh" "$OUT_PATH"
```

## Append the compound digests

`render.sh` owns the fixed sections. The two compound digests (`references/digests.md`) are appended to the body here — **Friction since last briefing** first (a flat reverse-chronological list, one line per record as `timestamp · ticket · phase — friction`), then **Learnings since last briefing**. Both are body-only (no frontmatter rewrite) and degrade to `_none_` when their store is empty or absent:

```bash
{
  printf '\n## Friction since last briefing\n\n'
  if [[ -s "$SCRATCH/friction-records.tsv" ]]; then
    sort -t$'\t' -k3,3r "$SCRATCH/friction-records.tsv" \
      | awk -F'\t' '{ printf "- `%s` · %s · %s — %s\n", $3, $1, $2, ($4 == "" ? "(no detail)" : $4) }'
  else
    printf '_none_\n'
  fi

  printf '\n## Learnings since last briefing\n\n'
  if [[ -s "$SCRATCH/learnings-records.tsv" ]]; then
    sort -t$'\t' -k1,1nr "$SCRATCH/learnings-records.tsv" \
      | awk -F'\t' '{ printf "- [%s] %s  \x60%s\x60\n", $3, $2, $4 }'
  else
    printf '_none_\n'
  fi
} >> "$OUT_PATH"

bash "$SCRIPT_DIR/validate-frontmatter.sh" "$OUT_PATH"
```

## Fan-out

Run the four fan-outs in parallel against the canonical briefing file. Each writes a status JSON document on stdout; `write-output-status.sh` merges those into an `output_status:` block in the frontmatter. Each fan-out degrades silently to `{"status":"skipped"}` if its credentials or destination ID are missing — the briefing always lands locally regardless:

```bash
mkdir -p "$SCRATCH/output-status"

bash "$SCRIPT_DIR/fanout-slack-dm.sh"      --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/slack-dm.json"      &
bash "$SCRIPT_DIR/fanout-slack-channel.sh" --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/slack-channel.json" &
bash "$SCRIPT_DIR/fanout-notion.sh"        --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/notion.json"        &
bash "$SCRIPT_DIR/fanout-loom-script.sh"   --in "$OUT_PATH" --date "$DATE" > "$SCRATCH/output-status/loom-script.json"   &
wait

bash "$SCRIPT_DIR/write-output-status.sh" --in "$OUT_PATH" --statuses "$SCRATCH/output-status"
bash "$SCRIPT_DIR/validate-frontmatter.sh" "$OUT_PATH"
```

| Script | Credentials env var | Destination key (`.catalyst.briefing.*`) | Profile |
|---|---|---|---|
| `fanout-slack-dm.sh` | `SLACK_BOT_TOKEN` | `slackDmUserId` | `dm` |
| `fanout-slack-channel.sh` | `SLACK_BOT_TOKEN` | `slackChannelId` | `channel` |
| `fanout-notion.sh` | `NOTION_TOKEN` | `notionPageId` | `notion` |
| `fanout-loom-script.sh` | (none — local file) | (writes `<date>-loom-script.md`) | `loom` |

Sanitization profiles (`sanitize.sh`): `dm` preserves full content; `channel` / `notion` / `loom` strip `decisions[].summary` / `.status`, rewrite `## Surface decisions` to `_redacted_`, redact customer names from `.catalyst.briefing.sanitizationRedactList`, and redact PR URLs whose body contains a redact-list string.

## End the session

```bash
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done --reason "morning-briefing rendered + fan-out"
echo "Wrote: $OUT_PATH"
```
