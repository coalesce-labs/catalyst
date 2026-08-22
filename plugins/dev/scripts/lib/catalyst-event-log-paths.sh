#!/usr/bin/env bash
# lib/catalyst-event-log-paths.sh — CTL-1216: bash mirror of
# lib/event-log-paths.mjs. Bash cannot import the JS leaf, so this is a SECOND,
# independently-maintained implementation of the same scheme — kept honest by
# the three-way cross-stack parity suite at
# __tests__/event-log-paths-parity.test.sh, where BOTH engines are checked
# against a COMPUTED-EXPECTED value (`date -u +%G-W%V`), never merely against
# each other: two implementations can agree with one another while both
# disagreeing with the spec.
#
# Any scheme, precedence or default change here MUST land together with the
# matching change in lib/event-log-paths.mjs, or the parity suite fails loudly.
# This is the same one-registry / two-hand-written-engines / parity-suite
# posture as lib/secret-contract.mjs + lib/catalyst-secret-contract.sh and
# lib/deployment-mode.mjs + lib/catalyst-deployment-mode.sh.
#
# ISO-WEEK PORTABILITY: `%G-W%V` is the ISO year + ISO week. %G is NOT %Y —
# 2027-01-01 is 2026-W53, and 2026 is a 53-week year. The BSD `date -j -f` /
# GNU `date -d` fallback pair is the pattern already proven in-tree at
# compound-log.sh:73-79.
#
# JQ-ABSENT DIVERGENCE (loud, by design): the config-file layer is read with
# jq. On a jq-less host a config FILE that could decide the scheme is treated
# as ABSENT (env-else-default), matching the declared asymmetry
# lib/catalyst-deployment-mode.sh already documents. The breadcrumb
# CATALYST_EVENT_LOG_ROTATION_JQ_MISSING=1 is exported so `catalyst doctor` can
# grade a host that is silently degrading on this axis. Degradation lands on
# `month` — the scheme already on disk — so it asserts the fewest new things.
#
# Depends only on coreutils `date` (+ optional jq). bash >= 3.2 compatible
# (no ${var,,}, no mapfile — see the presweep bash-3.2 fail-close incident).

# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_EVENT_LOG_PATHS_SH_LOADED:-}" ]] && return 0
_CATALYST_EVENT_LOG_PATHS_SH_LOADED=1

CATALYST_EVENT_LOG_DEFAULT_ROTATION="month"

# catalyst_event_log_scheme — env > config > default; degrades to the default
# on ANY unrecognized value. Never fails.
catalyst_event_log_scheme() {
  local v="${CATALYST_EVENT_LOG_ROTATION:-}"

  if [[ -z "$v" ]]; then
    v="$(_catalyst_event_log_scheme_from_config)"
  fi

  # bash 3.2 has no ${v,,}. Trim whitespace (including \r) and lowercase.
  v="$(printf '%s' "$v" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

  case "$v" in
    week | month) printf '%s' "$v" ;;
    *) printf '%s' "$CATALYST_EVENT_LOG_DEFAULT_ROTATION" ;;
  esac
}

# Layer-2 (machine-local) then Layer-1 (repo) config, matching the JS leaf's
# `config?.catalyst?.events?.rotation` read. A malformed or absent file falls
# through silently — this function's contract is "never fails".
_catalyst_event_log_scheme_from_config() {
  if ! command -v jq >/dev/null 2>&1; then
    export CATALYST_EVENT_LOG_ROTATION_JQ_MISSING=1
    return 0
  fi
  local f out
  for f in \
    "${CATALYST_LAYER2_CONFIG_FILE:-$HOME/.config/catalyst/config.json}" \
    "${CATALYST_LAYER1_CONFIG_FILE:-.catalyst/config.json}"; do
    [[ -f "$f" ]] || continue
    out="$(jq -r 'if (.catalyst.events.rotation | type) == "string"
                  then .catalyst.events.rotation else empty end' "$f" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then
      printf '%s' "$out"
      return 0
    fi
  done
  return 0
}

# catalyst_event_log_basename — the active-scheme basename for "now" (UTC).
catalyst_event_log_basename() {
  local scheme
  scheme="$(catalyst_event_log_scheme)"
  if [[ "$scheme" == "week" ]]; then
    printf '%s.jsonl' "$(date -u +%G-W%V)"
  else
    printf '%s.jsonl' "$(date -u +%Y-%m)"
  fi
}

# catalyst_events_dir — CATALYST_EVENTS_DIR > CATALYST_DIR/events > ~/catalyst/events.
catalyst_events_dir() {
  if [[ -n "${CATALYST_EVENTS_DIR:-}" ]]; then
    printf '%s' "$CATALYST_EVENTS_DIR"
    return 0
  fi
  printf '%s/events' "${CATALYST_DIR:-$HOME/catalyst}"
}

# catalyst_event_log_path — the full path to the active log file.
# Resolved PER CALL, never captured: a long-lived shell that crosses a period
# boundary must write where the tailer now reads.
catalyst_event_log_path() {
  printf '%s/%s' "$(catalyst_events_dir)" "$(catalyst_event_log_basename)"
}

# catalyst_event_log_paths_since <epoch_seconds> — every EXISTING log file whose
# interval overlaps [since, now], oldest-first, one per line, mixing schemes.
# The bash counterpart of resolveEventLogPathsForWindow.
#
# Sorting is lexical over a normalized `<startEpoch>\t<path>` key rather than
# over the filename, because "2026-08.jsonl" and "2026-W34.jsonl" do not sort
# into chronological order as strings.
#
# Fail-open: an unreadable dir yields nothing and never fails the caller. An
# empty result is NOT evidence of an empty window — a caller that must tell
# "no events" from "could not look" has to check the directory itself.
catalyst_event_log_paths_since() {
  local since="${1:-0}" dir now
  dir="$(catalyst_events_dir)"
  now="$(date -u +%s)"
  [[ -d "$dir" ]] || return 0

  local f base start end
  for f in "$dir"/*.jsonl; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    start="$(_catalyst_event_log_interval_start "$base")"
    end="$(_catalyst_event_log_interval_end "$base")"
    [[ -n "$start" && -n "$end" ]] || continue
    # half-open [start, end)
    [[ "$end" -le "$since" ]] && continue
    [[ "$start" -gt "$now" ]] && continue
    printf '%s\t%s\n' "$start" "$f"
  done | sort -n -k1,1 | cut -f2-
}

# _catalyst_event_log_interval_start <basename> — epoch seconds, or empty for
# anything that is not EXACTLY a log file. Notably empty for the CTL-1813
# `*.legacy.<stamp>.<pid>` quarantine files: the `*.jsonl` glob above already
# excludes them, and this is the second, explicit refusal.
_catalyst_event_log_interval_start() {
  local base="$1"
  if [[ "$base" =~ ^([0-9]{4})-([0-9]{2})\.jsonl$ ]]; then
    local y="${BASH_REMATCH[1]}" m="${BASH_REMATCH[2]}"
    # 10#-prefix: 08/09 are not valid octal, and a bare arithmetic context
    # would fail on them.
    [[ $((10#$m)) -ge 1 && $((10#$m)) -le 12 ]] || return 0
    _catalyst_utc_epoch "${y}-${m}-01T00:00:00Z"
    return 0
  fi
  if [[ "$base" =~ ^([0-9]{4})-W([0-9]{2})\.jsonl$ ]]; then
    _catalyst_iso_week_start_epoch "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  return 0
}

_catalyst_event_log_interval_end() {
  local base="$1" start
  if [[ "$base" =~ ^([0-9]{4})-([0-9]{2})\.jsonl$ ]]; then
    local y="${BASH_REMATCH[1]}" m="${BASH_REMATCH[2]}"
    [[ $((10#$m)) -ge 1 && $((10#$m)) -le 12 ]] || return 0
    local ny=$((10#$y)) nm=$((10#$m + 1))
    if [[ "$nm" -gt 12 ]]; then nm=1; ny=$((ny + 1)); fi
    _catalyst_utc_epoch "$(printf '%04d-%02d-01T00:00:00Z' "$ny" "$nm")"
    return 0
  fi
  start="$(_catalyst_iso_week_start_epoch_raw "$base")"
  [[ -n "$start" ]] && printf '%s' "$((start + 604800))"
  return 0
}

_catalyst_iso_week_start_epoch_raw() {
  local base="$1"
  if [[ "$base" =~ ^([0-9]{4})-W([0-9]{2})\.jsonl$ ]]; then
    _catalyst_iso_week_start_epoch "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  fi
}

# _catalyst_iso_week_start_epoch <isoYear> <isoWeek> — the Monday 00:00:00Z that
# starts that ISO week, or empty when that week does not exist in that ISO year
# (W53 is real in some years and fabricated in others — 2026 has 53 weeks,
# 2027 has 52). The round-trip through `date -u +%G-W%V` is what rejects a
# fabricated one instead of silently returning a date in the following January.
_catalyst_iso_week_start_epoch() {
  local y="$1" w="$2" jan4 jan4_dow week1_mon start rt
  [[ $((10#$w)) -ge 1 && $((10#$w)) -le 53 ]] || return 0

  jan4="$(_catalyst_utc_epoch "${y}-01-04T00:00:00Z")" || return 0
  [[ -n "$jan4" ]] || return 0
  # Mon=1 .. Sun=7 (date's %u is already ISO-numbered on both BSD and GNU).
  jan4_dow="$(_catalyst_utc_fmt "$jan4" '+%u')"
  week1_mon=$((jan4 - (jan4_dow - 1) * 86400))
  start=$((week1_mon + (10#$w - 1) * 604800))

  rt="$(_catalyst_utc_fmt "$start" '+%G-W%V')"
  [[ "$rt" == "$(printf '%04d-W%02d' "$((10#$y))" "$((10#$w))")" ]] || return 0
  printf '%s' "$start"
}

# _catalyst_utc_epoch <ISO8601Z> — epoch seconds. BSD `date -j -f` first, GNU
# `date -d` fallback (compound-log.sh:73-79's proven pair).
_catalyst_utc_epoch() {
  local ts="$1" out
  out="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s" 2>/dev/null)" ||
    out="$(date -u -d "$ts" "+%s" 2>/dev/null)" || return 1
  printf '%s' "$out"
}

# _catalyst_utc_fmt <epoch> <fmt> — format epoch seconds as UTC.
_catalyst_utc_fmt() {
  local e="$1" fmt="$2" out
  out="$(date -u -j -f "%s" "$e" "$fmt" 2>/dev/null)" ||
    out="$(date -u -d "@${e}" "$fmt" 2>/dev/null)" || return 1
  printf '%s' "$out"
}
