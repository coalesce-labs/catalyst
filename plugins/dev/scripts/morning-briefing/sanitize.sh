#!/usr/bin/env bash
# sanitize.sh — Apply a sanitization profile to a briefing markdown file.
#
# Usage:
#   sanitize.sh --profile {dm|channel|notion|loom} --in <briefing.md>
#               [--out <path>] [--redact-list "A,B,C"] [--config <path>]
#
# Profiles:
#   dm      — no-op (full content preserved)
#   channel — strip decision summary/status + redact customer names + redact PR URLs
#   notion  — same rules as channel
#   loom    — same rules as channel (downstream loom-script renders prose)
#
# `--redact-list` overrides .catalyst/config.json's catalyst.briefing.sanitizationRedactList.
#
# Writes the sanitized briefing to --out (or stdout if --out omitted).

set -euo pipefail

PROFILE=""
IN=""
OUT=""
REDACT_LIST=""
CONFIG=".catalyst/config.json"
REDACT_FLAG_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)     PROFILE="$2"; shift 2 ;;
    --in)          IN="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    --redact-list) REDACT_LIST="$2"; REDACT_FLAG_SET=1; shift 2 ;;
    --config)      CONFIG="$2"; shift 2 ;;
    -h|--help)     sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "sanitize.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  dm|channel|notion|loom) ;;
  "") echo "sanitize.sh: --profile is required" >&2; exit 2 ;;
  *)  echo "sanitize.sh: unknown profile: $PROFILE" >&2; exit 2 ;;
esac

if [[ -z "$IN" ]]; then
  echo "sanitize.sh: --in is required" >&2
  exit 2
fi
if [[ ! -f "$IN" ]]; then
  echo "sanitize.sh: input file not found: $IN" >&2
  exit 2
fi

# Resolve redact list: --redact-list flag wins over config file.
if [[ "$REDACT_FLAG_SET" -eq 0 ]] && [[ -f "$CONFIG" ]]; then
  REDACT_LIST=$(jq -r '
    (.catalyst.briefing.sanitizationRedactList // []) | join(",")
  ' "$CONFIG" 2>/dev/null || echo "")
fi

emit() {
  if [[ -n "$OUT" ]]; then
    mkdir -p "$(dirname "$OUT")"
    cat > "$OUT"
  else
    cat
  fi
}

# DM profile = byte-for-byte passthrough.
if [[ "$PROFILE" == "dm" ]]; then
  cat "$IN" | emit
  exit 0
fi

# All other profiles share these transforms:
#   1. Frontmatter: keep only id + type per decision item.
#   2. Body `## Surface decisions` section: replace with `_redacted_`.
#   3. Body: redact customer names from REDACT_LIST (case-insensitive, whole-word).
#   4. Body: redact PR URLs whose body contains a redact-list string.

python3 - "$IN" "$REDACT_LIST" <<'PY' | emit
import sys
import re
import yaml

path = sys.argv[1]
redact_csv = sys.argv[2] if len(sys.argv) > 2 else ""
redact_terms = [t.strip() for t in redact_csv.split(",") if t.strip()]

with open(path, "r", encoding="utf-8") as fh:
    raw = fh.read()

# Split the first --- ... --- block from the body.
m = re.match(r"^---\s*\n(.*?\n)---\s*\n(.*)$", raw, re.DOTALL)
if not m:
    # No frontmatter — emit unchanged.
    sys.stdout.write(raw)
    sys.exit(0)

fm_text = m.group(1)
body = m.group(2)

# 1. Frontmatter: strip decision details.
fm = yaml.safe_load(fm_text) or {}
if isinstance(fm.get("decisions"), list):
    fm["decisions"] = [
        {k: v for k, v in d.items() if k in ("id", "type")}
        for d in fm["decisions"]
        if isinstance(d, dict)
    ]

# 2. Body: rewrite "## Surface decisions" block to "_redacted_".
def rewrite_decisions_section(text):
    pattern = re.compile(
        r"(## Surface decisions\n)(.*?)(?=\n## |\Z)",
        re.DOTALL,
    )
    return pattern.sub(r"\1\n_redacted_\n", text)

body = rewrite_decisions_section(body)

# 3. PR-URL redaction (must run before customer-name redaction so the
#    customer string is still detectable inside the raw URL).
if redact_terms:
    url_re = re.compile(r"https?://[^\s<>)\"]+")
    lowered = [t.lower() for t in redact_terms]
    def maybe_redact(match):
        url = match.group(0)
        low = url.lower()
        return "[redacted-url]" if any(t in low for t in lowered) else url
    body = url_re.sub(maybe_redact, body)

# 4. Customer-name redaction (whole-word, case-insensitive).
if redact_terms:
    escaped = [re.escape(t) for t in redact_terms]
    pattern = re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)
    body = pattern.sub("[REDACTED]", body)

# Re-emit. yaml.safe_dump with sort_keys=False preserves insertion order.
new_fm = yaml.safe_dump(fm, default_flow_style=False, sort_keys=False, allow_unicode=True)
sys.stdout.write("---\n")
sys.stdout.write(new_fm)
sys.stdout.write("---\n")
sys.stdout.write(body)
PY
