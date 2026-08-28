# Compound digests — "since last briefing" window

Two compound-engineering digests the daily review scans: **Friction since last briefing** (the primary one — per-phase friction records the daily review wants to skim) and **Learnings since last briefing** (new entries in the curated store). Both filter on a *since-last-briefing* window: midnight of the most recent prior briefing, or — when there is no prior briefing — midnight of the day before `$DATE`. These render as body sections (`references/render-fanout.md`); both degrade to a single "_none_" line when their store is empty or absent.

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
