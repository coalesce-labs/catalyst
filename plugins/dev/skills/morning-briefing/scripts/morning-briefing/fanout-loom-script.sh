#!/usr/bin/env bash
# fanout-loom-script.sh — Render a ~60–90 second spoken script from the briefing
# into thoughts/briefings/<date>-loom-script.md. Uses the `loom` sanitization
# profile, then renders a deterministic prose template. Reads ~75s aloud at
# 150 wpm = ~225 words target.
#
# Usage:
#   fanout-loom-script.sh --in <briefing.md> --date YYYY-MM-DD
#                         [--root <repo-root>] [--target-words N]
#                         [--tone casual|formal] [--dry-run] [--config <path>]
#
# Prints final {"status":"posted|failed", "destination":"loom_script", ...}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IN=""
DATE=""
ROOT="."
TARGET_WORDS=""
TONE=""
DRY_RUN=0
CONFIG=".catalyst/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)           IN="$2"; shift 2 ;;
    --date)         DATE="$2"; shift 2 ;;
    --root)         ROOT="$2"; shift 2 ;;
    --target-words) TARGET_WORDS="$2"; shift 2 ;;
    --tone)         TONE="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --config)       CONFIG="$2"; shift 2 ;;
    -h|--help)      sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "fanout-loom-script.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

emit_status() {
  local status="$1" reason="${2:-}" details="${3:-{\}}"
  if [[ -n "$reason" ]]; then
    jq -nc --arg s "$status" --arg r "$reason" --argjson d "$details" \
      '{status:$s, destination:"loom_script", reason:$r, details:$d}'
  else
    jq -nc --arg s "$status" --argjson d "$details" \
      '{status:$s, destination:"loom_script", details:$d}'
  fi
}

if [[ -z "$IN" ]] || [[ ! -f "$IN" ]]; then
  emit_status failed input_not_found
  exit 0
fi

if [[ -z "$DATE" ]]; then
  DATE="$(date -u +%Y-%m-%d)"
fi

# Resolve target words + tone (flag > config > defaults).
if [[ -z "$TARGET_WORDS" ]] && [[ -f "$CONFIG" ]]; then
  TARGET_WORDS=$(jq -r '.catalyst.briefing.loomScript.targetWords // empty' "$CONFIG" 2>/dev/null || echo "")
fi
[[ -z "$TARGET_WORDS" ]] && TARGET_WORDS=225

if [[ -z "$TONE" ]] && [[ -f "$CONFIG" ]]; then
  TONE=$(jq -r '.catalyst.briefing.loomScript.tone // empty' "$CONFIG" 2>/dev/null || echo "")
fi
[[ -z "$TONE" ]] && TONE="casual"

# Sanitize via loom profile (same rules as channel).
SANITIZED_FILE="$(mktemp)"
trap 'rm -f "$SANITIZED_FILE"' EXIT
bash "$SCRIPT_DIR/sanitize.sh" --profile loom --in "$IN" --config "$CONFIG" > "$SANITIZED_FILE"

# Render the loom script. Pass the sanitized content via file path (NOT stdin)
# because the heredoc below also occupies stdin.
SCRIPT_TEXT=$(python3 - "$DATE" "$TONE" "$SANITIZED_FILE" <<'PY'
import re
import sys

date = sys.argv[1]
tone = sys.argv[2] if len(sys.argv) > 2 else "casual"
sanitized_path = sys.argv[3]

with open(sanitized_path, "r", encoding="utf-8") as fh:
    text = fh.read()
m = re.match(r"^---\s*\n(.*?\n)---\s*\n(.*)$", text, re.DOTALL)
fm_text = m.group(1) if m else ""
body = m.group(2) if m else text

# Parse minimal frontmatter info.
import yaml
fm = yaml.safe_load(fm_text) if fm_text else {}
n_decisions = len(fm.get("decisions") or [])
n_meetings = len(fm.get("meetings_yesterday") or [])
n_prs = len(fm.get("prs_merged_yesterday") or [])

# Count items under each top-level "## " section by looking at lines starting with "- ".
def count_items_under(heading, body):
    pattern = re.compile(
        rf"## {re.escape(heading)}\n(.*?)(?=\n## |\Z)",
        re.DOTALL,
    )
    m = pattern.search(body)
    if not m:
        return 0
    return sum(1 for line in m.group(1).splitlines() if line.startswith("- "))

n_linear_changes = count_items_under("Review yesterday", body)
n_today_items = count_items_under("Plan today", body)
n_suggested = count_items_under("Suggest orchestrator runs", body)

greeting = "Good morning." if tone == "casual" else "Greetings."
closer   = "Full briefing in thoughts slash briefings slash %s dot md." % date \
    if tone == "casual" \
    else "Refer to the canonical briefing file for full detail."

def pluralize(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"

lines = []
lines.append(f"# Loom Script — {date}")
lines.append("")
lines.append(f"{greeting} Today is {date}.")
lines.append("")

# Yesterday paragraph
y_parts = []
if n_linear_changes:
    y_parts.append(pluralize(n_linear_changes, "Linear update"))
if n_prs:
    y_parts.append(pluralize(n_prs, "merged pull request"))
if n_meetings:
    y_parts.append(pluralize(n_meetings, "meeting"))
if y_parts:
    lines.append("Looking at yesterday: " + ", ".join(y_parts) + ".")
else:
    lines.append("Yesterday was quiet, with no tracked activity to report.")

# Decisions paragraph
if n_decisions:
    lines.append(
        f"There {'is' if n_decisions == 1 else 'are'} {pluralize(n_decisions, 'open decision')} "
        f"surfaced for today. Internals are redacted in this clip; "
        f"open the briefing file for the full context."
    )
else:
    lines.append("Nothing is currently waiting on a decision from you.")

# Today paragraph
if n_today_items:
    lines.append(
        f"For today: about {n_today_items} item{'s' if n_today_items != 1 else ''} are queued up "
        f"across in-progress work, calendar, and follow-ups. "
        f"Worth a quick scan before the first meeting."
    )
else:
    lines.append("Your day is wide open with no items queued so far.")

# Suggested runs paragraph
if n_suggested:
    lines.append(
        f"Heads up: {pluralize(n_suggested, 'ticket')} look ready for an orchestrator run "
        f"if you want to dispatch them this morning."
    )
else:
    lines.append("No new tickets look ready for orchestration this morning.")

lines.append("")
lines.append(closer)

out = "\n".join(lines) + "\n"
sys.stdout.write(out)
PY
)

# Determine output path
if [[ "$DRY_RUN" -eq 1 ]]; then
  OUT_PATH="/tmp/morning-briefing-${DATE}-loom-script.md"
else
  OUT_DIR="${ROOT%/}/thoughts/briefings"
  mkdir -p "$OUT_DIR"
  OUT_PATH="${OUT_DIR}/${DATE}-loom-script.md"
fi

printf '%s' "$SCRIPT_TEXT" > "$OUT_PATH"

WORDS=$(wc -w < "$OUT_PATH" | tr -d ' ')

# Soft-warn if outside the [0.7 * target, 1.3 * target] band. Pass TARGET_WORDS
# as argv (not inline) to avoid shell-substitution concerns.
LO=$(python3 -c "import sys; print(int(int(sys.argv[1]) * 0.7))" "$TARGET_WORDS")
HI=$(python3 -c "import sys; print(int(int(sys.argv[1]) * 1.3))" "$TARGET_WORDS")
if (( WORDS < LO || WORDS > HI )); then
  echo "fanout-loom-script.sh: warning: word count ${WORDS} outside [${LO}, ${HI}] band" >&2
fi

emit_status posted "" "$(jq -nc --arg p "$OUT_PATH" --argjson w "$WORDS" --argjson t "$TARGET_WORDS" \
  '{path:$p, words:$w, targetWords:$t}')"
