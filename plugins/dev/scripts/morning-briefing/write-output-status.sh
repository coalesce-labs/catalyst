#!/usr/bin/env bash
# write-output-status.sh — Merge per-fan-out status JSON files into the
# briefing markdown's frontmatter under an `output_status:` key. Preserves
# every other frontmatter field. Idempotent — running again overwrites the
# existing output_status block.
#
# Usage:
#   write-output-status.sh --in <briefing.md> --statuses <dir-with-*.json>
#
# The status dir is expected to contain any subset of:
#   slack-dm.json, slack-channel.json, notion.json, loom-script.json
# Each file is a single JSON object with at least {status, destination}.

set -euo pipefail

IN=""
STATUSES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)       IN="$2"; shift 2 ;;
    --statuses) STATUSES="$2"; shift 2 ;;
    -h|--help)  sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "write-output-status.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

[[ -n "$IN"       ]] || { echo "write-output-status.sh: --in is required"       >&2; exit 2; }
[[ -n "$STATUSES" ]] || { echo "write-output-status.sh: --statuses is required" >&2; exit 2; }
[[ -f "$IN"       ]] || { echo "write-output-status.sh: input file not found: $IN" >&2; exit 2; }
[[ -d "$STATUSES" ]] || { echo "write-output-status.sh: statuses dir not found: $STATUSES" >&2; exit 2; }

python3 - "$IN" "$STATUSES" <<'PY'
import json
import os
import re
import sys

import yaml

briefing_path = sys.argv[1]
status_dir = sys.argv[2]

# Map filename -> frontmatter key
file_to_key = {
    "slack-dm.json":      "slack_dm",
    "slack-channel.json": "slack_channel",
    "notion.json":        "notion",
    "loom-script.json":   "loom_script",
}

output_status = {}
for fname, key in file_to_key.items():
    fpath = os.path.join(status_dir, fname)
    if not os.path.exists(fpath):
        continue
    try:
        with open(fpath, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        continue
    # Drop the `destination` field — it duplicates the key.
    cleaned = {k: v for k, v in data.items() if k != "destination"}
    output_status[key] = cleaned

with open(briefing_path, "r", encoding="utf-8") as fh:
    raw = fh.read()

m = re.match(r"^---\s*\n(.*?\n)---\s*\n(.*)$", raw, re.DOTALL)
if not m:
    sys.stderr.write(f"write-output-status.sh: no frontmatter in {briefing_path}\n")
    sys.exit(1)

fm = yaml.safe_load(m.group(1)) or {}
fm["output_status"] = output_status

new_fm = yaml.safe_dump(fm, default_flow_style=False, sort_keys=False, allow_unicode=True)
new_text = "---\n" + new_fm + "---\n" + m.group(2)

with open(briefing_path, "w", encoding="utf-8") as fh:
    fh.write(new_text)
PY
