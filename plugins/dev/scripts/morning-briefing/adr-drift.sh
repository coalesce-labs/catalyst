#!/usr/bin/env bash
# adr-drift.sh — Detect drift between ADR `code_assertions` and the current codebase.
#
# Usage:
#   adr-drift.sh [--adrs-dir DIR] [--root DIR] [--deep-adr-check]
#
# Reads ADR markdown files with YAML frontmatter:
#   ---
#   adr_id: ADR-005
#   code_assertions:
#     - pattern: "regex"
#       expectation: found | not_found
#       description: "human label"
#   ---
#
# For each assertion, greps the codebase. Emits drift records to stdout:
#   {"decisions": [{"id": ..., "type": "adr_drift", "summary": ..., "status": "open",
#                   "adr": ..., "drift_status": ..., "pattern": ...}, ...]}
#
# Always exits 0. Silent no-op when the configured ADRs directory does not exist —
# this satisfies the "zero false positives on the catalyst single-file legacy layout"
# acceptance criterion.
#
# See plugins/dev/skills/morning-briefing/ADR-DRIFT.md for the full convention.

set -uo pipefail

ADRS_DIR=""
ROOT="."
DEEP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --adrs-dir) ADRS_DIR="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --deep-adr-check) DEEP=true; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "adr-drift.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

# Normalize root to an absolute path so subsequent paths are unambiguous.
if [[ -d "$ROOT" ]]; then
  ROOT="$(cd "$ROOT" && pwd)"
fi

# Resolve adrs-dir: flag wins, then .catalyst/config.json, then default.
if [[ -z "$ADRS_DIR" ]]; then
  if [[ -f "$ROOT/.catalyst/config.json" ]] && command -v jq >/dev/null 2>&1; then
    ADRS_DIR=$(jq -r '.catalyst.adrs.directory // "docs/adrs"' "$ROOT/.catalyst/config.json" 2>/dev/null || echo "docs/adrs")
  else
    ADRS_DIR="docs/adrs"
  fi
fi
[[ "$ADRS_DIR" = /* ]] || ADRS_DIR="$ROOT/$ADRS_DIR"

# Silent no-op when the configured directory doesn't exist. Single-file ADR layouts
# (e.g. catalyst's own docs/adrs.md) intentionally fall here — they're informational
# only and produce zero structured drift records.
if [[ ! -d "$ADRS_DIR" ]]; then
  echo '{"decisions": []}'
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo '{"decisions": []}'
  exit 0
fi

# Extract code_assertions for one ADR file as a JSON array. Empty array if no
# frontmatter, no code_assertions, or YAML is malformed (logged to stderr).
extract_assertions() {
  local file="$1"
  python3 - "$file" <<'PY' 2>/dev/null || echo '[]'
import json, sys
try:
    import yaml
except ImportError:
    print("[]")
    sys.exit(0)
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
except Exception:
    print("[]")
    sys.exit(0)
if not text.startswith("---"):
    print("[]")
    sys.exit(0)
end = text.find("\n---", 3)
if end == -1:
    print("[]")
    sys.exit(0)
fm = text[3:end].lstrip("\n")
try:
    data = yaml.safe_load(fm) or {}
except yaml.YAMLError as e:
    sys.stderr.write(f"adr-drift: skipping {path}: bad YAML ({e})\n")
    print("[]")
    sys.exit(0)
if not isinstance(data, dict):
    print("[]")
    sys.exit(0)
assertions = data.get("code_assertions") or []
if not isinstance(assertions, list):
    print("[]")
    sys.exit(0)
clean = []
for a in assertions:
    if not isinstance(a, dict):
        continue
    pattern = a.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        continue
    expectation = a.get("expectation", "found")
    if expectation not in ("found", "not_found"):
        expectation = "found"
    description = a.get("description") or ""
    if not isinstance(description, str):
        description = str(description)
    clean.append({"pattern": pattern, "expectation": expectation, "description": description})
print(json.dumps(clean))
PY
}

# Check whether $1 matches anywhere under $ROOT. Excludes vendor / generated dirs
# AND the ADRs directory itself (so an assertion's own pattern text isn't a self-hit).
pattern_present() {
  local pattern="$1"
  local adrs_basename
  adrs_basename=$(basename "$ADRS_DIR")
  grep -rE \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=thoughts \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=.next \
    --exclude-dir=.venv \
    --exclude-dir=__pycache__ \
    --exclude-dir="$adrs_basename" \
    -l "$pattern" "$ROOT" >/dev/null 2>&1
}

DRIFTS='[]'

shopt -s nullglob
for adr in "$ADRS_DIR"/*.md; do
  [[ -f "$adr" ]] || continue
  ASSERTS=$(extract_assertions "$adr")
  COUNT=$(jq 'length' <<<"$ASSERTS" 2>/dev/null || echo 0)
  [[ "$COUNT" -gt 0 ]] || continue

  ADR_BASE=$(basename "$adr" .md)
  IDX=0
  while IFS= read -r ASSERT; do
    [[ -z "$ASSERT" ]] && continue
    PATTERN=$(jq -r '.pattern' <<<"$ASSERT")
    EXPECTATION=$(jq -r '.expectation' <<<"$ASSERT")
    DESCRIPTION=$(jq -r '.description' <<<"$ASSERT")

    if pattern_present "$PATTERN"; then
      FOUND=true
    else
      FOUND=false
    fi

    DRIFT=""
    case "$EXPECTATION" in
      found)     [[ "$FOUND" == "false" ]] && DRIFT="adr_ahead_of_code" ;;
      not_found) [[ "$FOUND" == "true"  ]] && DRIFT="code_ahead_of_adr" ;;
    esac

    if [[ -n "$DRIFT" ]]; then
      SUMMARY="ADR ${ADR_BASE} drift (${DRIFT}): ${DESCRIPTION:-$PATTERN}"
      DRIFTS=$(jq \
        --arg id "adr-drift-${ADR_BASE}-${IDX}" \
        --arg summary "$SUMMARY" \
        --arg adr "$adr" \
        --arg drift_status "$DRIFT" \
        --arg pattern "$PATTERN" \
        '. + [{
          id: $id,
          type: "adr_drift",
          summary: $summary,
          status: "open",
          adr: $adr,
          drift_status: $drift_status,
          pattern: $pattern
        }]' <<<"$DRIFTS")
    fi
    IDX=$((IDX + 1))
  done < <(jq -c '.[]' <<<"$ASSERTS")
done
shopt -u nullglob

# LLM-driven path (--deep-adr-check) is documented in ADR-DRIFT.md but out of scope
# for this MVP. The flag is parsed so the orchestrator can plumb it through today.
if [[ "$DEEP" == "true" ]]; then
  echo "adr-drift: --deep-adr-check is not yet implemented (MVP supports structured assertions only)" >&2
fi

jq -c '{decisions: .}' <<<"$DRIFTS"
