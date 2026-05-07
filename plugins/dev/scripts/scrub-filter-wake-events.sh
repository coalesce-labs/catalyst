#!/usr/bin/env bash
# Removes empty-match filter.wake.* events from event log files.
#
# These are events with empty source_event_ids written when the filter daemon's
# watchdog ran, found no matching events, and wrote a record of finding nothing.
# They serve no operational purpose and bloat the log.
#
# Usage: ./scrub-filter-wake-events.sh [logfile...]
# Default: scrubs ~/catalyst/events/2026-04.jsonl and ~/catalyst/events/2026-05.jsonl

set -euo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"

scrub_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Skipping $file (not found)"
    return 0
  fi
  python3 - "$file" <<'PYTHON'
import json, sys

path = sys.argv[1]
kept = []
dropped = 0
with open(path) as f:
    for line in f:
        stripped = line.rstrip('\n')
        if not stripped:
            continue
        try:
            e = json.loads(stripped)
            if e.get('event', '').startswith('filter.wake'):
                ids = (e.get('detail') or {}).get('source_event_ids', [])
                if not ids:
                    dropped += 1
                    continue
        except Exception:
            pass
        kept.append(stripped)

with open(path, 'w') as f:
    f.write('\n'.join(kept))
    if kept:
        f.write('\n')
print(f"Scrubbed {path}: removed {dropped} empty-match filter.wake events, kept {len(kept)}")
PYTHON
}

if [[ $# -gt 0 ]]; then
  for f in "$@"; do
    scrub_file "$f"
  done
else
  scrub_file "${CATALYST_DIR}/events/2026-04.jsonl"
  scrub_file "${CATALYST_DIR}/events/2026-05.jsonl"
fi
