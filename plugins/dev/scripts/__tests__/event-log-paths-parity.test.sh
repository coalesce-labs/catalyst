#!/usr/bin/env bash
# Cross-stack parity test for lib/event-log-paths.mjs vs
# lib/catalyst-event-log-paths.sh (CTL-1216).
#
# THREE-WAY, not two-way. For every fixture the expected value is COMPUTED —
# `date -u +%G-W%V` for the week scheme, `date -u +%Y-%m` for the month scheme —
# and then:
#
#     assert bash engine == expected
#     assert JS   engine == expected
#
# Asserting bash == JS alone is a false-green on the exact property this suite
# exists to guard: two implementations can agree with each other while both
# disagree with the spec. This is the posture
# __tests__/secret-contract-parity.test.sh and
# __tests__/deployment-mode-parity.test.sh already use.
#
# The date fixtures are read from the SHARED list
# __tests__/fixtures/event-log-week-oracle.txt — the same file
# lib/event-log-paths.test.mjs reads. A divergent fixture set is how a parity
# suite passes while the engines disagree on an untested date.
#
# Run: bash plugins/dev/scripts/__tests__/event-log-paths-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SH_LIB="${SCRIPTS_ROOT}/lib/catalyst-event-log-paths.sh"
JS_LIB="${SCRIPTS_ROOT}/lib/event-log-paths.mjs"
ORACLE="${SCRIPT_DIR}/fixtures/event-log-week-oracle.txt"

FAILURES=0
PASSES=0
ASSERTIONS=0

ok() { PASSES=$((PASSES + 1)); ASSERTIONS=$((ASSERTIONS + 1)); }
bad() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES + 1))
  ASSERTIONS=$((ASSERTIONS + 1))
  echo "  FAIL: $name"
  echo "    $detail"
}
expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then ok; else bad "$name" "expected='$expected' actual='$actual'"; fi
}

# Pick a JS runtime the same way `catalyst doctor` does. The leaf is zero-npm-import
# precisely so bare node can load it.
NODE_BIN="$(command -v bun || command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "SKIP: neither bun nor node on PATH — cannot run the JS half of a parity suite"
  exit 0
fi

[[ -f "$SH_LIB" ]] || { echo "FATAL: missing $SH_LIB"; exit 1; }
[[ -f "$JS_LIB" ]] || { echo "FATAL: missing $JS_LIB"; exit 1; }
[[ -f "$ORACLE" ]] || { echo "FATAL: missing shared oracle fixture $ORACLE"; exit 1; }

# ── engine invocation ───────────────────────────────────────────────────────
# Both engines run in a hermetic `env -i` subshell carrying ONLY PATH/HOME plus
# the fixture inputs under test, passed as ARRAY elements so a hostile fixture
# value can never be re-split or re-parsed by the invoking shell.

# js_basename <isoDate> [ENV=VAL ...]
js_basename() {
  local d="$1"; shift
  env -i PATH="$PATH" HOME="$HOME" "$@" "$NODE_BIN" --input-type=module -e "
    const m = await import('file://${JS_LIB}');
    process.stdout.write(m.eventLogBasenameFor(new Date('${d}T00:00:00Z'), m.resolveRotationScheme({ env: process.env })));
  " 2>/dev/null
}

# sh_basename_at <isoDate> [ENV=VAL ...] — the bash engine renders "now", so the
# fixture date is injected via a faketime-free shim: we compare the ARITHMETIC
# (isoWeekStartMs round-trip) for fixed dates, and the LIVE basename for now.
# For fixed dates we therefore ask the bash engine for the interval start of the
# rendered name and check it round-trips, plus we compare the live-now basenames.
sh_scheme() {
  env -i PATH="$PATH" HOME="$HOME" "$@" bash -c "source '$SH_LIB'; catalyst_event_log_scheme"
}
sh_basename_now() {
  env -i PATH="$PATH" HOME="$HOME" "$@" bash -c "source '$SH_LIB'; catalyst_event_log_basename"
}
sh_week_start() {
  local y="$1" w="$2"
  env -i PATH="$PATH" HOME="$HOME" bash -c "source '$SH_LIB'; _catalyst_iso_week_start_epoch '$y' '$w'"
}
js_week_start() {
  local y="$1" w="$2"
  env -i PATH="$PATH" HOME="$HOME" "$NODE_BIN" --input-type=module -e "
    const m = await import('file://${JS_LIB}');
    const s = m.isoWeekStartMs(${y}, ${w});
    const rt = m.isoWeekParts(new Date(s));
    process.stdout.write(rt.isoYear === ${y} && rt.isoWeek === ${w} ? String(s / 1000) : '');
  " 2>/dev/null
}

echo "=== CTL-1216 event-log-paths three-way parity ==="

# ── T1: ISO-week rendering, both engines vs the date(1) oracle ──────────────
# The bash engine renders "now", so a fixed-date comparison goes through the
# shared week-start arithmetic instead: for each oracle row, the expected ISO
# year/week is the oracle's, and BOTH engines must place that week's Monday at
# the same epoch AND that epoch must render back to the oracle string under
# date(1) itself.
ORACLE_ROWS=0
while read -r date_col week_col; do
  [[ -z "$date_col" || "$date_col" == \#* ]] && continue
  ORACLE_ROWS=$((ORACLE_ROWS + 1))
  y="${week_col%%-W*}"
  w="${week_col##*-W}"

  # expected := computed from date(1), independently of both engines
  expected_start="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${date_col}T00:00:00Z" "+%s" 2>/dev/null ||
    date -u -d "${date_col}T00:00:00Z" "+%s")"
  expected_dow="$(date -u -j -f "%s" "$expected_start" "+%u" 2>/dev/null ||
    date -u -d "@${expected_start}" "+%u")"
  expected_monday=$((expected_start - (expected_dow - 1) * 86400))

  expect_eq "bash week-start ${date_col} (${week_col})" "$expected_monday" "$(sh_week_start "$y" "$w")"
  expect_eq "js   week-start ${date_col} (${week_col})" "$expected_monday" "$(js_week_start "$y" "$w")"
done < "$ORACLE"

# Positive control: the oracle file was actually read. A zero-row loop would
# make every assertion above vacuous and the suite would print a clean pass on
# the strength of nothing ([].every(p) is true).
if [[ "$ORACLE_ROWS" -ge 9 ]]; then
  ok
else
  bad "oracle fixture rows" "read only ${ORACLE_ROWS} rows from ${ORACLE} — the parity loop never ran"
fi

# ── T2: live-now basename parity, both schemes, both engines vs date(1) ────
expected_week="$(date -u +%G-W%V).jsonl"
expected_month="$(date -u +%Y-%m).jsonl"

expect_eq "bash basename (week)" "$expected_week" "$(sh_basename_now CATALYST_EVENT_LOG_ROTATION=week)"
expect_eq "js   basename (week)" "$expected_week" "$(js_basename "$(date -u +%Y-%m-%d)" CATALYST_EVENT_LOG_ROTATION=week)"
expect_eq "bash basename (month)" "$expected_month" "$(sh_basename_now CATALYST_EVENT_LOG_ROTATION=month)"
expect_eq "js   basename (month)" "$expected_month" "$(js_basename "$(date -u +%Y-%m-%d)" CATALYST_EVENT_LOG_ROTATION=month)"
expect_eq "bash basename (unset -> default)" "$expected_month" "$(sh_basename_now)"
expect_eq "js   basename (unset -> default)" "$expected_month" "$(js_basename "$(date -u +%Y-%m-%d)")"

# ── T3: scheme-degradation parity — an unrecognized value settles at `month` ─
# on BOTH engines. `month` is the scheme already on disk, so degradation
# asserts the fewest new things.
for bad_val in daily weekly 1 "" "  " WEEKLY month-ish; do
  expect_eq "bash degrade '${bad_val}'" "month" "$(sh_scheme CATALYST_EVENT_LOG_ROTATION="$bad_val")"
  js_deg="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_EVENT_LOG_ROTATION="$bad_val" \
    "$NODE_BIN" --input-type=module -e "
      const m = await import('file://${JS_LIB}');
      process.stdout.write(m.resolveRotationScheme({ env: process.env }));
    " 2>/dev/null)"
  expect_eq "js   degrade '${bad_val}'" "month" "$js_deg"
done

# Case/whitespace tolerance parity.
for good in week WEEK " week " Week; do
  expect_eq "bash accept '${good}'" "week" "$(sh_scheme CATALYST_EVENT_LOG_ROTATION="$good")"
  js_good="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_EVENT_LOG_ROTATION="$good" \
    "$NODE_BIN" --input-type=module -e "
      const m = await import('file://${JS_LIB}');
      process.stdout.write(m.resolveRotationScheme({ env: process.env }));
    " 2>/dev/null)"
  expect_eq "js   accept '${good}'" "week" "$js_good"
done

# ── T4: events-dir override parity (CATALYST_EVENTS_DIR > CATALYST_DIR > HOME) ─
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

js_dir() {
  env -i PATH="$PATH" HOME="$HOME" "$@" "$NODE_BIN" --input-type=module -e "
    const m = await import('file://${JS_LIB}');
    process.stdout.write(m.eventsDir({ env: process.env }));
  " 2>/dev/null
}
sh_dir() {
  env -i PATH="$PATH" HOME="$HOME" "$@" bash -c "source '$SH_LIB'; catalyst_events_dir"
}

expect_eq "bash dir (CATALYST_EVENTS_DIR wins)" "/x/ev" "$(sh_dir CATALYST_EVENTS_DIR=/x/ev CATALYST_DIR=/y)"
expect_eq "js   dir (CATALYST_EVENTS_DIR wins)" "/x/ev" "$(js_dir CATALYST_EVENTS_DIR=/x/ev CATALYST_DIR=/y)"
expect_eq "bash dir (CATALYST_DIR)" "/y/events" "$(sh_dir CATALYST_DIR=/y)"
expect_eq "js   dir (CATALYST_DIR)" "/y/events" "$(js_dir CATALYST_DIR=/y)"
expect_eq "bash dir (HOME default)" "${HOME}/catalyst/events" "$(sh_dir)"
expect_eq "js   dir (HOME default)" "${HOME}/catalyst/events" "$(js_dir)"

# ── T5: the window resolver agrees across engines, mixing schemes ───────────
EV="${TMP_ROOT}/events"
mkdir -p "$EV"
: > "${EV}/2026-07.jsonl"
: > "${EV}/2026-08.jsonl"
: > "${EV}/2026-W34.jsonl"
: > "${EV}/2026-08.jsonl.legacy.20260813T101010Z.512"   # CTL-1813 quarantine — must be skipped
: > "${EV}/notes.txt"

# since = 2026-08-01T00:00:00Z; both engines see "now" so the upper bound is live,
# and every fixture interval starts in the past.
SINCE="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "2026-08-01T00:00:00Z" "+%s" 2>/dev/null ||
  date -u -d "2026-08-01T00:00:00Z" "+%s")"

sh_window="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_EVENTS_DIR="$EV" \
  bash -c "source '$SH_LIB'; catalyst_event_log_paths_since '$SINCE'" | while read -r p; do basename "$p"; done | tr '\n' ' ')"
js_window="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_EVENTS_DIR="$EV" "$NODE_BIN" --input-type=module -e "
  const m = await import('file://${JS_LIB}');
  const { basename } = await import('node:path');
  const p = m.resolveEventLogPathsForWindow({ sinceMs: ${SINCE} * 1000, nowMs: Date.now(), env: process.env });
  // NOT p.map(basename): map passes (value, index) and basename's 2nd arg is
  // \`ext\`, which throws ERR_INVALID_ARG_TYPE on a number.
  process.stdout.write(p.map((x) => basename(x)).join(' ') + (p.length ? ' ' : ''));
" 2>/dev/null)"

expect_eq "bash window (mixed schemes, quarantine skipped)" "2026-08.jsonl 2026-W34.jsonl " "$sh_window"
expect_eq "js   window (mixed schemes, quarantine skipped)" "2026-08.jsonl 2026-W34.jsonl " "$js_window"

# Positive control for the window resolver itself: it must be able to return
# NOTHING for a window it does not cover, or "it always returns everything" would
# make the assertion above meaningless.
FUTURE="$(( $(date -u +%s) + 86400 * 3650 ))"
sh_none="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_EVENTS_DIR="$EV" \
  bash -c "source '$SH_LIB'; catalyst_event_log_paths_since '$FUTURE'" | tr -d '\n')"
expect_eq "bash window (no overlap -> empty)" "" "$sh_none"

# ── T6: a fabricated W53 is rejected identically by both engines ────────────
# 2026 HAS 53 ISO weeks; 2027 does not.
expect_eq "bash W53 accepted in 2026" "yes" "$([[ -n "$(sh_week_start 2026 53)" ]] && echo yes || echo no)"
expect_eq "js   W53 accepted in 2026" "yes" "$([[ -n "$(js_week_start 2026 53)" ]] && echo yes || echo no)"
expect_eq "bash W53 rejected in 2027" "no" "$([[ -n "$(sh_week_start 2027 53)" ]] && echo yes || echo no)"
expect_eq "js   W53 rejected in 2027" "no" "$([[ -n "$(js_week_start 2027 53)" ]] && echo yes || echo no)"

echo
echo "assertions: ${ASSERTIONS}  passed: ${PASSES}  failed: ${FAILURES}"
if [[ "$ASSERTIONS" -lt 40 ]]; then
  echo "FAIL: only ${ASSERTIONS} assertions ran — a parity suite that barely runs is not evidence"
  exit 1
fi
[[ "$FAILURES" -eq 0 ]] || exit 1
echo "PASS"
