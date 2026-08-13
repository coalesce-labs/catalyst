#!/usr/bin/env bash
# CTL-1813: a malformed first line must quarantine itself, not retire the month beside it.
#
# `canonical_jsonl_append` rotates the live month file aside when its first line is not a
# canonical event. That rotation exists for the v1 -> canonical MIGRATION, and for that it is
# correct. But the old test was `jq -e 'has("attributes")'`, which exits non-zero for BOTH a
# legacy line and an UNPARSEABLE one — so one torn line moved the whole month aside, and
# because the destination was a fixed `.legacy`, a second torn line one rotation later
# overwrote the only surviving copy.
#
# That composes with CTL-1809: our own bash appends TEAR above 1025 bytes (macOS BUFSIZ), so a
# torn first line is a predictable product of the writer, not a rare accident.
#
# Driven against the REAL function, not a model of it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(dirname "$SCRIPT_DIR")/lib/canonical-event.sh"
[[ -f "$LIB" ]] || { echo "FAIL: canonical-event.sh not found at $LIB"; exit 1; }
# shellcheck disable=SC1090
source "$LIB"

TMPS=()
# NOTE the trailing `true`: without it the loop's last conditional decides this script's
# EXIT STATUS, so a passing test can report failure. Cleanup must never be able to change
# the verdict.
cleanup() { local d; for d in "${TMPS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; true; }
trap cleanup EXIT
# NOTE: `newdir` is called inside a command substitution, which is a SUBSHELL — an array
# append inside it never reaches the parent, so registering the path here would silently leak
# every directory (Codex #3318 P2). The caller registers it instead.
newdir() { mktemp -d; }
monthfile() { printf '%s/%s.jsonl' "$1" "$(date -u +%Y-%m)"; }
fail() { echo "FAIL: $*"; exit 1; }

# --- 1. A TORN first line must NOT rotate, and must lose nothing ---------------
D="$(newdir)"; TMPS+=("$D"); F="$(monthfile "$D")"
printf 'not json at all\n' > "$F"
for i in $(seq 1 20); do printf '{"attributes":{"event.name":"e%s"}}\n' "$i" >> "$F"; done

WARNDIR="$(newdir)"; TMPS+=("$WARNDIR"); WARN="$WARNDIR/warn.txt"
canonical_jsonl_append "$D" '{"attributes":{"event.name":"new"}}' 2>"$WARN"

ROTATED="$(find "$D" -name '*legacy*' | wc -l | tr -d ' ')"
[[ "$ROTATED" == "0" ]] || fail "a torn first line rotated the live log ($ROTATED files) — 20 events would have been retired"

LIVE="$(grep -c 'event.name' "$F" || true)"
[[ "$LIVE" == "21" ]] || fail "expected 21 live events preserved (20 + the append), found $LIVE"

# Silence is a defect: refusing to rotate a DAMAGED log must be audible, or the damage is
# invisible until someone goes looking.
grep -q 'does not parse' "$WARN" || fail "refusing to rotate a damaged log was silent; stderr: $(cat "$WARN")"

# --- 2. A GENUINE legacy first line still rotates -----------------------------
# POSITIVE CONTROL for case 1: proves the rotation feature still works, so case 1 is testing
# the parse distinction rather than a rotation that has simply been disabled.
D2="$(newdir)"; TMPS+=("$D2"); F2="$(monthfile "$D2")"
printf '{"ts":"x","event":"MONTH_A"}\n' > "$F2"
canonical_jsonl_append "$D2" '{"attributes":{"event.name":"n1"}}' 2>/dev/null
[[ "$(find "$D2" -name '*legacy*' | wc -l | tr -d ' ')" == "1" ]] \
  || fail "a genuine legacy first line did NOT rotate — the migration path is broken"

# --- 3. A SECOND rotation must not clobber the first --------------------------
# The unrecoverable half of the defect: a fixed `.legacy` is a rescue slot of depth one.
printf '{"ts":"y","event":"MONTH_B"}\n' > "$F2"
canonical_jsonl_append "$D2" '{"attributes":{"event.name":"n2"}}' 2>/dev/null

COUNT="$(find "$D2" -name '*legacy*' | wc -l | tr -d ' ')"
[[ "$COUNT" == "2" ]] || fail "expected 2 distinct rotated files, found $COUNT — one rotation clobbered another"

ALL="$(cat "$D2"/*legacy* 2>/dev/null || true)"
grep -q MONTH_A <<<"$ALL" || fail "MONTH_A was destroyed by the second rotation"
grep -q MONTH_B <<<"$ALL" || fail "MONTH_B is missing from the rotated copies"

echo "PASS: a torn first line preserves the month; a legacy line still rotates; rotations cannot clobber each other"
exit 0
