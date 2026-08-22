#!/usr/bin/env bash
# CTL-1216 Phase 4 — the WRITER resolves the same file the readers do.
#
# Phases 1-3 moved every reader onto the shared resolver while the writer still
# computed its own name. This suite pins the writer's half, and the property
# that actually matters: writer and reader agree under EITHER scheme. A test
# that only checks "the file has the right name" would pass even if the reader
# were looking somewhere else entirely.
#
# Run: bash plugins/dev/scripts/__tests__/canonical-event-rotation.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASSES=0
FAILURES=0
ASSERTIONS=0

ok() { PASSES=$((PASSES+1)); ASSERTIONS=$((ASSERTIONS+1)); echo "  PASS: $1"; }
bad() { FAILURES=$((FAILURES+1)); ASSERTIONS=$((ASSERTIONS+1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1" "expected='$2' actual='$3'"; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq required"; exit 0; }

emit_one() {
  # emit_one <events_dir> <name> — one canonical append through the REAL writer.
  # Args are passed positionally, never interpolated into the -c string: a
  # $(mktemp -d) path is data, and re-parsing it in an inner shell is how this
  # helper silently emitted nothing while every assertion read as a real failure.
  bash -c '
    source "$0/lib/canonical-event.sh"
    line="$(build_canonical_line --ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --event-name "$2" --severity INFO --service catalyst.ctl1216-test --orch ctl1216 --payload-json "{}")"
    [ -n "$line" ] || exit 1
    canonical_jsonl_append "$1" "$line"
  ' "$SCRIPTS" "$1" "$2"
}

echo "=== T1: default (no env) writes the monthly file — byte-identical to today ==="
D1="$(mktemp -d)/events"
emit_one "$D1" "ctl1216.t1"
expect_eq "default -> \$(date -u +%Y-%m).jsonl" "$(date -u +%Y-%m).jsonl" "$(ls "$D1" 2>/dev/null | head -1)"

echo "=== T2: week scheme writes the ISO-week file ==="
D2="$(mktemp -d)/events"
CATALYST_EVENT_LOG_ROTATION=week emit_one "$D2" "ctl1216.t2"
expect_eq "week -> \$(date -u +%G-W%V).jsonl" "$(date -u +%G-W%V).jsonl" "$(ls "$D2" 2>/dev/null | head -1)"

echo "=== T3: an unrecognized scheme DEGRADES to month, it does not invent a file ==="
D3="$(mktemp -d)/events"
CATALYST_EVENT_LOG_ROTATION=daily emit_one "$D3" "ctl1216.t3"
expect_eq "daily -> degrades to monthly" "$(date -u +%Y-%m).jsonl" "$(ls "$D3" 2>/dev/null | head -1)"

echo "=== T4: WRITER/READER AGREEMENT — the whole point ==="
# Emit under `week`, then ask the READER's own path resolver (the same mirror
# catalyst-events sources) where to look, and read THAT file. If the two halves
# disagreed about the filename this finds nothing on a file that plainly has one.
#
# `catalyst-events tail` FOLLOWS, so it is never invoked unbounded here — a
# blocking child in a test suite is how a run hangs for two minutes and leaves a
# process behind (AGENTS.md, "Spawning a background process"). The resolver is
# the thing under test anyway; the follow loop is not.
D4="$(mktemp -d)/events"
CATALYST_EVENT_LOG_ROTATION=week emit_one "$D4" "ctl1216.t4.agree"

reader_resolved_file() {
  # exactly what catalyst-events' events_file_path computes, via the same mirror
  CATALYST_EVENT_LOG_ROTATION="${1:-}" CATALYST_EVENTS_DIR="$2" bash -c '
    source "'"${SCRIPTS}"'/lib/catalyst-event-log-paths.sh"
    printf "%s/%s" "$(catalyst_events_dir)" "$(catalyst_event_log_basename)"
  '
}

READER_FILE="$(reader_resolved_file week "$D4")"
FOUND="$(/usr/bin/grep -c "ctl1216.t4.agree" "$READER_FILE" 2>/dev/null || true)"
expect_eq "reader resolves the SAME file the writer wrote" "1" "$FOUND"

# Positive control: the instrument must be able to return ZERO, or "it found it"
# proves only that grep works.
MISS="$(/usr/bin/grep -c "ctl1216.t4.NOT-EMITTED" "$READER_FILE" 2>/dev/null || true)"
expect_eq "positive control: 0 for a name never emitted" "0" "$MISS"

# And the reader must NOT be looking at the monthly name under `week` — this is
# the assertion that would have caught a writer/reader split.
expect_eq "reader is not pointed at the monthly file under week" \
  "$(date -u +%G-W%V).jsonl" "$(basename "$READER_FILE")"

echo "=== T5: CTL-1813 legacy quarantine still fires, on the WEEK file ==="
D5="$(mktemp -d)/events"
mkdir -p "$D5"
WEEKFILE="${D5}/$(date -u +%G-W%V).jsonl"
# A genuine v1 line: parses, and has no `attributes`.
printf '{"ts":"2026-01-01T00:00:00Z","event":"legacy.v1","orchestrator":"x"}\n' > "$WEEKFILE"
CATALYST_EVENT_LOG_ROTATION=week emit_one "$D5" "ctl1216.t5" 2>/dev/null
QUARANTINED="$(ls "$D5" | /usr/bin/grep -c '\.legacy\.' || true)"
expect_eq "v1 first line quarantined under the week scheme" "1" "$QUARANTINED"

echo "=== T6: an UNPARSEABLE first line still REFUSES to rotate (events preserved) ==="
D6="$(mktemp -d)/events"
mkdir -p "$D6"
WEEKFILE6="${D6}/$(date -u +%G-W%V).jsonl"
printf 'this is not json at all\n' > "$WEEKFILE6"
WARN6="$(CATALYST_EVENT_LOG_ROTATION=week emit_one "$D6" "ctl1216.t6" 2>&1 >/dev/null | /usr/bin/grep -c 'does not parse as JSON' || true)"
expect_eq "unparseable first line warns" "1" "$WARN6"
expect_eq "unparseable first line does NOT rotate" "0" "$(ls "$D6" | /usr/bin/grep -c '\.legacy\.' || true)"

echo "=== T7: no raw '>>' append was introduced — CTL-1809's one-write(2) primitive still owns it ==="
RAW="$(/usr/bin/grep -cE '^\s*printf .*>>\s*"\$(month_file|log_file)"' "${SCRIPTS}/lib/canonical-event.sh" || true)"
expect_eq "no raw >> append in canonical_jsonl_append" "0" "$RAW"

echo
echo "assertions: ${ASSERTIONS}  passed: ${PASSES}  failed: ${FAILURES}"
# Fail closed: a suite that barely ran is not evidence.
if [[ "$ASSERTIONS" -lt 10 ]]; then
  echo "FAIL: only ${ASSERTIONS} assertions ran"
  exit 1
fi
[[ "$FAILURES" -eq 0 ]] || exit 1
echo "PASS"
