#!/usr/bin/env bash
# gather-retro.sh — deterministic read side of /catalyst-dev:ticket-retro (CTL-814).
#
# Collects everything the cross-ticket retro VIEW reads into ONE JSON document
# on stdout. READ-ONLY by contract: this script writes nothing anywhere. Every
# section degrades to empty/null — an absent store, missing CLI, or empty
# window never fails the run (mirrors morning-briefing Step 3b resilience).
#
# Usage:
#   gather-retro.sh [--thoughts-dir <path>] [--since YYYY-MM-DD]
#                   [--tickets CTL-1,CTL-2] [--db <path>]
#                   [--retros-dir <path>] [--no-github]
#
# Window resolution (the since-last-retro default, plan line 114):
#   --since wins; else the DATE of the most recent <retros-dir>/YYYY-MM-DD.md
#   (records strictly AFTER that date's midnight UTC); else 14 days back.
#   --tickets without --since drops the floor to 0 (explicit scope = all time).
#
# Output shape:
# {
#   "window":      {"since": "YYYY-MM-DD", "floor_epoch": N, "source": "..."},
#   "prior_retro": {"path","date","watch_items":[{pattern,component,first_seen,source}]} | null,
#   "friction":    [{"ticket","phase","ts","line"}],            # '## <phase> · <TICKET> · <ISO>' contract
#   "learnings":   [{"title","component","problem_type","path"}],
#   "calibration": {…compound-log.sh aggregate…},               # {} when store empty/helper absent
#   "merged_prs":  [{"ticket","pr","title","merged_at","additions","deletions"}],
#   "db_stats":    [{"ticket_key","sessions","cost_usd","hours"}]   # sparse by design
# }

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOUND_LOG="${SCRIPT_DIR}/../compound-log.sh"

THOUGHTS_DIR="./thoughts"
SINCE=""
TICKETS=""
DB="${HOME}/catalyst/catalyst.db"
RETROS_DIR=""
NO_GITHUB=0

while [ $# -gt 0 ]; do
  case "$1" in
    --thoughts-dir) THOUGHTS_DIR="$2"; shift 2 ;;
    --since)        SINCE="$2"; shift 2 ;;
    --tickets)      TICKETS="$2"; shift 2 ;;
    --db)           DB="$2"; shift 2 ;;
    --retros-dir)   RETROS_DIR="$2"; shift 2 ;;
    --no-github)    NO_GITHUB=1; shift ;;
    -h|--help)      sed -n '2,28p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "gather-retro: unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "gather-retro: jq is required" >&2; exit 1; }

[ -z "$RETROS_DIR" ] && RETROS_DIR="${THOUGHTS_DIR}/shared/compound/retros"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gather-retro.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# ── Prior retro + window floor ───────────────────────────────────────────────

PRIOR_RETRO=""
if [ -d "$RETROS_DIR" ]; then
  for rf in "$RETROS_DIR"/*.md; do
    [ -e "$rf" ] || continue
    case "$(basename "$rf" .md)" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
        if [ -z "$PRIOR_RETRO" ] || [ "$rf" \> "$PRIOR_RETRO" ]; then PRIOR_RETRO="$rf"; fi ;;
    esac
  done
fi

WINDOW_SOURCE=""
if [ -n "$SINCE" ]; then
  WINDOW_DATE="$SINCE"; WINDOW_SOURCE="--since"
elif [ -n "$TICKETS" ]; then
  WINDOW_DATE="1970-01-01"; WINDOW_SOURCE="--tickets (all time)"
elif [ -n "$PRIOR_RETRO" ]; then
  WINDOW_DATE="$(basename "$PRIOR_RETRO" .md)"; WINDOW_SOURCE="last-retro"
else
  # First retro ever: 14 days back. GNU date first, then BSD (macOS).
  WINDOW_DATE="$(date -u -d '14 days ago' +%Y-%m-%d 2>/dev/null \
    || date -j -u -v-14d +%Y-%m-%d 2>/dev/null || echo 1970-01-01)"
  WINDOW_SOURCE="default-14d"
fi
WINDOW_EPOCH=$(date -u -d "${WINDOW_DATE}T00:00:00Z" +%s 2>/dev/null \
  || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${WINDOW_DATE}T00:00:00Z" +%s 2>/dev/null || echo 0)

jq -nc --arg since "$WINDOW_DATE" --arg src "$WINDOW_SOURCE" --argjson floor "$WINDOW_EPOCH" \
  '{since: $since, floor_epoch: $floor, source: $src}' > "$SCRATCH/window.json"

# ── Prior retro watch-items (the only stateful contract, CTL-814) ───────────
# Parsed from the fenced block:   ```yaml watch-items … ```
# Items:  - pattern: "…"\n  component: …\n  first_seen: …\n  source: …

if [ -n "$PRIOR_RETRO" ]; then
  awk '
    /^```yaml watch-items/ { f = 1; next }
    f && /^```/            { f = 0; next }
    f && /^- pattern:/ {
      if (started) printf "%s\t%s\t%s\t%s\n", p, c, fs, s
      started = 1; c = ""; fs = ""; s = ""
      p = $0; sub(/^- pattern:[ ]*/, "", p); gsub(/^"|"$/, "", p)
      next
    }
    f && /^[ ]+component:/  { c = $0;  sub(/^[ ]+component:[ ]*/,  "", c);  next }
    f && /^[ ]+first_seen:/ { fs = $0; sub(/^[ ]+first_seen:[ ]*/, "", fs); next }
    f && /^[ ]+source:/     { s = $0;  sub(/^[ ]+source:[ ]*/,     "", s);  next }
    END { if (started) printf "%s\t%s\t%s\t%s\n", p, c, fs, s }
  ' "$PRIOR_RETRO" \
  | jq -R -c 'split("\t") | {pattern: .[0], component: .[1], first_seen: .[2], source: .[3]}' \
  > "$SCRATCH/watch-items.jsonl" || : > "$SCRATCH/watch-items.jsonl"

  jq -sc --arg path "$PRIOR_RETRO" --arg date "$(basename "$PRIOR_RETRO" .md)" \
    '{path: $path, date: $date, watch_items: .}' "$SCRATCH/watch-items.jsonl" \
    > "$SCRATCH/prior-retro.json"
else
  echo 'null' > "$SCRATCH/prior-retro.json"
fi

# ── Friction records after the floor ─────────────────────────────────────────
# Same header contract the morning briefing parses (Step 3b):
#   ## <phase> · <TICKET> · <ISO-8601 timestamp>

: > "$SCRATCH/friction.jsonl"
FRICTION_DIR="${THOUGHTS_DIR}/shared/friction"
if [ -d "$FRICTION_DIR" ] && command -v python3 >/dev/null 2>&1; then
  for ff in "$FRICTION_DIR"/*.md; do
    [ -e "$ff" ] || continue
    python3 - "$ff" "$WINDOW_EPOCH" >> "$SCRATCH/friction.jsonl" <<'PY'
import sys, re, json, datetime
path, floor = sys.argv[1], int(sys.argv[2])
hdr = re.compile(r'^##\s+(?P<phase>[^·]+?)\s+·\s+(?P<ticket>[^·]+?)\s+·\s+(?P<ts>\S+)\s*$')
lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
i = 0
while i < len(lines):
    m = hdr.match(lines[i])
    if not m:
        i += 1; continue
    phase, ticket, ts = m.group('phase').strip(), m.group('ticket').strip(), m.group('ts').strip()
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
    # Strip the bullet's bold field label ("**Backtracks / redone work:** …")
    # so pattern clustering sees the substance, not the template.
    one = re.sub(r'^\*\*[^*]+:\*\*\s*', '', one)
    print(json.dumps({"ticket": ticket, "phase": phase, "ts": ts,
                      "line": re.sub(r'\s+', ' ', one)}))
PY
  done
fi

# ── Learnings entries modified after the floor ───────────────────────────────

: > "$SCRATCH/learnings.jsonl"
LEARN_DIR="${THOUGHTS_DIR}/shared/learnings"
if [ -d "$LEARN_DIR" ]; then
  find "$LEARN_DIR" -type f -name '*.md' 2>/dev/null | while IFS= read -r lf; do
    [ -n "$lf" ] || continue
    mt=$(date -u -r "$lf" +%s 2>/dev/null || stat -c %Y "$lf" 2>/dev/null || echo 0)
    [ "$mt" -gt "$WINDOW_EPOCH" ] || continue
    title=$(grep -m1 '^title:' "$lf" 2>/dev/null | sed -E 's/^title:[[:space:]]*//; s/^"//; s/"$//')
    [ -z "$title" ] && title="$(basename "$lf" .md)"
    comp=$(grep -m1 '^component:' "$lf" 2>/dev/null | sed -E 's/^component:[[:space:]]*//')
    ptype=$(grep -m1 '^problem_type:' "$lf" 2>/dev/null | sed -E 's/^problem_type:[[:space:]]*//')
    jq -nc --arg t "$title" --arg c "${comp:-}" --arg p "${ptype:-}" --arg path "$lf" \
      '{title: $t, component: $c, problem_type: $p, path: $path}' >> "$SCRATCH/learnings.jsonl"
  done
fi

# ── Estimation calibration (compound-log aggregate, CTL-813) ─────────────────

if [ -x "$COMPOUND_LOG" ]; then
  "$COMPOUND_LOG" aggregate --thoughts-dir "$THOUGHTS_DIR" > "$SCRATCH/calibration.json" 2>/dev/null \
    || echo '{}' > "$SCRATCH/calibration.json"
else
  echo '{}' > "$SCRATCH/calibration.json"
fi

# ── Merged PRs in the window ("what we did") ─────────────────────────────────

echo '[]' > "$SCRATCH/merged-prs.json"
if [ "$NO_GITHUB" -eq 0 ] && command -v gh >/dev/null 2>&1; then
  gh pr list --state merged --limit 200 \
    --json number,title,headRefName,mergedAt,additions,deletions 2>/dev/null \
  | jq -c --arg since "${WINDOW_DATE}T00:00:00Z" '
      [ .[]
        | select(.mergedAt > $since)
        | . + {ticket: (try ((.headRefName + " " + .title)
                             | capture("(?<t>[A-Za-z][A-Za-z0-9]*-[0-9]+)"; "i").t
                             | ascii_upcase)
                        catch null)}
        | select(.ticket != null)
        | {ticket, pr: .number, title, merged_at: .mergedAt, additions, deletions}
      ]' > "$SCRATCH/merged-prs.json" 2>/dev/null \
  || echo '[]' > "$SCRATCH/merged-prs.json"
fi

# ── catalyst.db aggregate stats (sparse cross-check) ─────────────────────────

echo '[]' > "$SCRATCH/db-stats.json"
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 -json "$DB" "
    SELECT s.ticket_key AS ticket_key,
           COUNT(*) AS sessions,
           ROUND(SUM(m.cost_usd), 2) AS cost_usd,
           ROUND(SUM(m.duration_ms) / 3600000.0, 2) AS hours
    FROM sessions s JOIN session_metrics m ON s.session_id = m.session_id
    WHERE s.ticket_key IS NOT NULL AND s.ticket_key != ''
    GROUP BY s.ticket_key;" > "$SCRATCH/db-stats.json" 2>/dev/null \
  || echo '[]' > "$SCRATCH/db-stats.json"
  [ -s "$SCRATCH/db-stats.json" ] || echo '[]' > "$SCRATCH/db-stats.json"
fi

# ── Optional --tickets filter ────────────────────────────────────────────────

TICKETS_JSON='null'
if [ -n "$TICKETS" ]; then
  TICKETS_JSON=$(printf '%s' "$TICKETS" | jq -R -c 'split(",") | map(ascii_upcase | gsub("^\\s+|\\s+$"; ""))')
fi

# ── Assemble ─────────────────────────────────────────────────────────────────

jq -n \
  --slurpfile window "$SCRATCH/window.json" \
  --slurpfile prior "$SCRATCH/prior-retro.json" \
  --slurpfile cal "$SCRATCH/calibration.json" \
  --slurpfile prs "$SCRATCH/merged-prs.json" \
  --slurpfile db "$SCRATCH/db-stats.json" \
  --argjson tickets "$TICKETS_JSON" \
  '
  ($tickets) as $tk
  | {
      window: $window[0],
      prior_retro: $prior[0],
      friction: $ARGS.positional[0],
      learnings: $ARGS.positional[1],
      calibration: $cal[0],
      merged_prs: $prs[0],
      db_stats: $db[0]
    }
  | if $tk != null then
      .friction   |= map(select(.ticket | ascii_upcase as $u | $tk | index($u)))
    | .merged_prs |= map(select(.ticket | ascii_upcase as $u | $tk | index($u)))
    | .db_stats   |= map(select(.ticket_key | ascii_upcase as $u | $tk | index($u)))
    else . end
  ' \
  --jsonargs \
  "$(jq -sc '.' "$SCRATCH/friction.jsonl")" \
  "$(jq -sc '.' "$SCRATCH/learnings.jsonl")"
