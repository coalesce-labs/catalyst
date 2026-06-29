---
name: morning-briefing
description:
  Generate a daily briefing markdown at thoughts/briefings/YYYY-MM-DD.md with six sections —
  Review yesterday, Surface decisions, Plan today, Suggest orchestrator runs, Friction since last
  briefing, and Learnings since last briefing — synthesized from Linear, GitHub, Granola, Google
  Drive, Google Calendar, and the compound-engineering stores (thoughts/shared/friction,
  thoughts/shared/learnings, thoughts/shared/compound/pending) in parallel. Then fans the briefing
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

> **Read source:** the `linearis` queries below are the standard-node direct read. On a Catalyst Cloud node the local replica is read first (evidence-based fallback to `linearis`) — see the `linearis` skill's "Reading Linear" section.

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

Populate the `decisions:` array from four sources:

1. **ADR drift** — `adr-drift.sh` reads ADR `code_assertions` frontmatter and surfaces patterns
   that drift from the codebase. See [ADR-DRIFT.md](./ADR-DRIFT.md).
2. **Blocked PRs** — `gh search prs --review-requested @me --state open --json …` filtered to
   PRs with no commit in the last 48h. Each becomes one `{type: blocked_pr, …}` decision.
3. **Judgment-call Linear tickets** — `linearis issues list --team <team> --status "Triage,In Progress" --label needs-decision` (label name is informational; substitute whatever signal the operator uses).
4. **Pending compound-engineering ADR proposals** — the `ticket-compound` curator queues
   APPROVE-gated ADR changes at `thoughts/shared/compound/pending/<TICKET>.md`. Each pending file
   becomes one decision the morning ritual can approve via `briefing-followup`'s
   `action-compound.sh`. Emitted as `type: judgment_call` (the frontmatter schema's `type` enum
   has no `compound_adr` value) carrying a `pending:` path — that field is the discriminator
   `briefing-followup` routes on.

Synthesize into a `decisions.json` fragment:

```bash
# ADR drift detection (CTL-459)
bash "$SCRIPT_DIR/adr-drift.sh" --root "$(pwd)" > "$SCRATCH/adr-drift.json"

# Blocked-PR + judgment-call sources are still TODO — start with an empty fragment.
echo '{"decisions": []}' > "$SCRATCH/decisions-other.json"

# Pending compound ADR proposals (CTL-789). Resilient to an absent/empty store:
# the glob below simply yields nothing when thoughts/shared/compound/pending/ is missing.
PENDING_DIR="thoughts/shared/compound/pending"
: > "$SCRATCH/compound-pending.jsonl"
if [[ -d "$PENDING_DIR" ]]; then
  for pf in "$PENDING_DIR"/*.md; do
    [[ -e "$pf" ]] || continue   # no-match glob guard (no nullglob needed)
    PTICKET=$(grep -m1 '^ticket:' "$pf" 2>/dev/null \
      | sed -E 's/^ticket:[[:space:]]*//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')
    [[ -z "$PTICKET" ]] && PTICKET="$(basename "$pf" .md)"
    PTARGET=$(grep -m1 '^target:'  "$pf" 2>/dev/null | sed -E 's/^target:[[:space:]]*//')
    PADRID=$(grep -m1 '^adr_id:'   "$pf" 2>/dev/null | sed -E 's/^adr_id:[[:space:]]*//')
    PRAT=$(grep -m1 '^rationale:'  "$pf" 2>/dev/null | sed -E 's/^rationale:[[:space:]]*//')
    PSUMMARY="ADR proposal (${PTARGET:-new}${PADRID:+ $PADRID}) from ${PTICKET}${PRAT:+: $PRAT}"
    jq -nc \
      --arg id "compound-${PTICKET}" \
      --arg summary "$PSUMMARY" \
      --arg ticket "$PTICKET" \
      --arg pending "$pf" \
      '{id: $id, type: "judgment_call", summary: $summary, status: "open",
        ticket: $ticket, pending: $pending}' >> "$SCRATCH/compound-pending.jsonl"
  done
fi
jq -sc '{decisions: .}' "$SCRATCH/compound-pending.jsonl" > "$SCRATCH/compound-pending.json"

# Merge all decision sources into one fragment
jq -s '{decisions: (
        ((.[0] // {}).decisions // [])
      + ((.[1] // {}).decisions // [])
      + ((.[2] // {}).decisions // []))}' \
  "$SCRATCH/adr-drift.json" "$SCRATCH/decisions-other.json" "$SCRATCH/compound-pending.json" \
  > "$SCRATCH/decisions.json"
```

## Step 3b: Compound digests — "since last briefing" window (CTL-789)

Two compound-engineering digests the daily review scans: **Friction since last briefing** (the
primary one — per-phase friction records the daily review wants to skim) and **Learnings since
last briefing** (new entries in the curated store). Both filter on a *since-last-briefing*
window: midnight of the most recent prior briefing, or — when there is no prior briefing —
midnight of the day before `$DATE`. These render as body sections appended after Step 6; they
degrade to a single "_none_" line when their store is empty or absent.

```bash
# ── Resolve the window floor (epoch seconds) ────────────────────────────────
# Most recent thoughts/briefings/YYYY-MM-DD.md strictly older than $DATE.
PREV_BRIEFING_DATE=""
if [[ -d thoughts/briefings ]]; then
  for bf in thoughts/briefings/*.md; do
    [[ -e "$bf" ]] || continue
    bd=$(basename "$bf" .md)
    [[ "$bd" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    if [[ "$bd" < "$DATE" ]]; then
      [[ -z "$PREV_BRIEFING_DATE" || "$bd" > "$PREV_BRIEFING_DATE" ]] && PREV_BRIEFING_DATE="$bd"
    fi
  done
fi
# Window floor: prior briefing's midnight, else $DATE minus one day. `date -d`
# (GNU) and `date -j` (BSD/macOS) differ — try both, fall back to "0".
WINDOW_DATE="${PREV_BRIEFING_DATE:-$(date -u -d "$DATE -1 day" +%Y-%m-%d 2>/dev/null \
  || date -j -v-1d -f %Y-%m-%d "$DATE" +%Y-%m-%d 2>/dev/null || echo "$DATE")}"
WINDOW_EPOCH=$(date -u -d "${WINDOW_DATE}T00:00:00Z" +%s 2>/dev/null \
  || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${WINDOW_DATE}T00:00:00Z" +%s 2>/dev/null || echo 0)
echo "Compound digest window: since ${WINDOW_DATE} (epoch ${WINDOW_EPOCH})"

# ── Friction digest (PRIMARY) ───────────────────────────────────────────────
# Each record header is the cross-phase contract:
#   ## <phase> · <TICKET> · <ISO-8601 timestamp>
# parse by that timestamp, keep records AFTER the window, render newest-first.
: > "$SCRATCH/friction-records.tsv"   # ticket \t phase \t iso \t one-line
FRICTION_DIR="thoughts/shared/friction"
if [[ -d "$FRICTION_DIR" ]]; then
  for ff in "$FRICTION_DIR"/*.md; do
    [[ -e "$ff" ]] || continue
    python3 - "$ff" "$WINDOW_EPOCH" >> "$SCRATCH/friction-records.tsv" <<'PY'
import sys, re, datetime
path, floor = sys.argv[1], int(sys.argv[2])
hdr = re.compile(r'^##\s+(?P<phase>[^·]+?)\s+·\s+(?P<ticket>[^·]+?)\s+·\s+(?P<ts>\S+)\s*$')
lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
i = 0
while i < len(lines):
    m = hdr.match(lines[i])
    if not m:
        i += 1; continue
    phase = m.group('phase').strip(); ticket = m.group('ticket').strip(); ts = m.group('ts').strip()
    # first non-empty body line that isn't "None."
    one = ""
    j = i + 1
    while j < len(lines) and not hdr.match(lines[j]):
        t = lines[j].strip().lstrip('-* ').strip()
        if t and t.rstrip('.').lower() != "none":
            one = t; break
        j += 1
    i = j
    try:
        epoch = int(datetime.datetime.fromisoformat(ts).timestamp())
    except ValueError:
        continue
    if epoch <= floor:
        continue
    # tabs/newlines in the one-liner would break the TSV; flatten them.
    one = re.sub(r'\s+', ' ', one)
    print(f"{ticket}\t{phase}\t{ts}\t{one}")
PY
  done
fi

# ── Learnings digest ────────────────────────────────────────────────────────
# New/updated entries in the curated store modified after the window floor.
: > "$SCRATCH/learnings-records.tsv"   # mtime-epoch \t title \t component \t path
LEARN_DIR="thoughts/shared/learnings"
if [[ -d "$LEARN_DIR" ]]; then
  while IFS= read -r lf; do
    [[ -n "$lf" ]] || continue
    mt=$(date -u -r "$lf" +%s 2>/dev/null || stat -c %Y "$lf" 2>/dev/null || echo 0)
    [[ "$mt" -gt "$WINDOW_EPOCH" ]] || continue
    title=$(grep -m1 '^title:' "$lf" 2>/dev/null | sed -E 's/^title:[[:space:]]*//; s/^"//; s/"$//')
    [[ -z "$title" ]] && title="$(basename "$lf" .md)"
    comp=$(grep -m1 '^component:' "$lf" 2>/dev/null | sed -E 's/^component:[[:space:]]*//')
    printf '%s\t%s\t%s\t%s\n' "$mt" "$title" "${comp:-?}" "$lf" >> "$SCRATCH/learnings-records.tsv"
  done < <(find "$LEARN_DIR" -type f -name '*.md' 2>/dev/null)
fi
```

## Step 4: Gather "today"

- In-progress Linear tickets — `linearis issues list --team <team> --status "In Progress" --limit 20`
- Today's calendar — already gathered in Step 2, reuse `$SCRATCH/calendar.json`
- Follow-ups — extract action items from the prior day's Granola notes (`$SCRATCH/granola.json`)
  via a Claude-side synthesis pass
- **Retro signals (CTL-814)** — the most recent `/catalyst-dev:ticket-retro` artifact's open
  watch-items, rendered as a `Plan today → Retro signals` sub-section. Degrades to an empty
  array (`_no data_`) when no retro has ever run.

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

## Step 6b: Append the compound digests (CTL-789)

`render.sh` owns the fixed sections. The two compound digests from Step 3b are appended to the
body here — **Friction since last briefing** first (the primary, easy-to-skim section the daily
review scans: a flat reverse-chronological list, one line per record as
`timestamp · ticket · phase — friction`) then **Learnings since last briefing**. Both are
body-only (they touch no frontmatter, so the schema stays valid) and both degrade to `_none_`
when their store is empty or absent. POSIX append only — no frontmatter rewrite.

```bash
{
  printf '\n## Friction since last briefing\n\n'
  if [[ -s "$SCRATCH/friction-records.tsv" ]]; then
    # Flat reverse-chronological list, one line per record:
    #   timestamp · ticket · phase — one-line friction
    # (sort by ISO timestamp, col 3, descending). TSV cols: ticket\tphase\tts\tone-line.
    sort -t$'\t' -k3,3r "$SCRATCH/friction-records.tsv" \
      | awk -F'\t' '{ printf "- `%s` · %s · %s — %s\n", $3, $1, $2, ($4 == "" ? "(no detail)" : $4) }'
  else
    printf '_none_\n'
  fi

  printf '\n## Learnings since last briefing\n\n'
  if [[ -s "$SCRATCH/learnings-records.tsv" ]]; then
    # Newest-first by mtime (col 1, numeric descending). TSV cols: mtime\ttitle\tcomponent\tpath.
    sort -t$'\t' -k1,1nr "$SCRATCH/learnings-records.tsv" \
      | awk -F'\t' '{ printf "- [%s] %s  \x60%s\x60\n", $3, $2, $4 }'
  else
    printf '_none_\n'
  fi
} >> "$OUT_PATH"

# Frontmatter is untouched by the append, but re-validate to fail loud if a
# concurrent edit corrupted it.
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
Six `## ...` sections follow: the four `render.sh` owns (Review yesterday, Surface decisions,
Plan today, Suggest orchestrator runs) plus the two compound digests appended in Step 6b
(Friction since last briefing, Learnings since last briefing). Plan today carries a
`### Retro signals` sub-section (CTL-814) surfacing the latest `ticket-retro` watch-items.
Empty render sources render `_no data_`; empty compound stores render `_none_`. Neither path
fails the run.

Pending compound-engineering ADR proposals (`thoughts/shared/compound/pending/*.md`) surface as
`decisions:` entries (`type: judgment_call`, carrying a `pending:` path) so `briefing-followup`'s
`action-compound.sh` can apply / edit / defer / reject them — the human-gated ADR approval surface.

A companion `<date>-loom-script.md` lands beside the briefing whenever Step 7's loom fan-out
runs (always, since it has no credential prerequisite).
