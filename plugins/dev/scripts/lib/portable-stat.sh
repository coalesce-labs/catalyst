#!/usr/bin/env bash
# The shared portable file-metadata seam (CAT-85).
#
# A single `stat -f ... || stat -c ...` capture is unsafe: GNU stat treats -f
# as --file-system, writes a filesystem report to stdout, and can still fail.
# The fallback output is then concatenated with that report. This caused the
# CTL-1473, CTL-1628, CTL-1509, and CAT-21 incidents. Probe each dialect in a
# separate capture and validate its shape before returning it.
[[ -n "${_CATALYST_PORTABLE_STAT_SH_LOADED:-}" ]] && return 0
_CATALYST_PORTABLE_STAT_SH_LOADED=1

portable_stat() {
  local gnu_fmt="$1" bsd_fmt="$2" path="$3" pattern="${4:-^[0-9]+$}" out
  out="$(stat -c "$gnu_fmt" "$path" 2>/dev/null)" || out=""
  if [[ ! "$out" =~ $pattern ]]; then
    out="$(stat -f "$bsd_fmt" "$path" 2>/dev/null)" || out=""
  fi
  [[ "$out" =~ $pattern ]] || return 1
  printf '%s\n' "$out"
}

portable_stat_mtime() { portable_stat '%Y' '%m' "$1"; }
portable_stat_size() { portable_stat '%s' '%z' "$1"; }
portable_stat_owner() { portable_stat '%u' '%u' "$1"; }
portable_stat_inode() { portable_stat '%i' '%i' "$1"; }

# BSD %Lp drops special bits, so use raw %p and mask permission/special bits.
portable_stat_mode() {
  local raw
  raw="$(portable_stat '%a' '%p' "$1" '^[0-7]+$')" || return 1
  printf '%04o\n' "$(( 8#$raw & 4095 ))"
}

portable_stat_mode_oct() {
  local raw
  raw="$(portable_stat '%a' '%p' "$1" '^[0-7]+$')" || return 1
  printf '%s\n' "$(( 8#$raw & 4095 ))"
}
