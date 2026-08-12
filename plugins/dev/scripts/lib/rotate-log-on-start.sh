#!/usr/bin/env bash
# CTL-1755: preserve the previous run's log across a daemon restart.
#
# rotate_log_on_start <log_path>
#   Before a daemon's `> "$log" 2>&1` truncation, shift a bounded numbered ring
#   (.1 … .N) and COPY the current log to .1 — leaving <log_path> in place so the
#   daemon's own `>` truncates it (preserving its inode, so a static-path tailer
#   such as Alloy keeps following the same file). Best-effort / fail-open: any
#   error returns 0 so a daemon start is never blocked by rotation.
#
# Retention: CATALYST_LOG_RETAIN (default 5). 0 disables rotation entirely.
rotate_log_on_start() {
  local log="${1:-}"
  [ -n "$log" ] || return 0

  local retain="${CATALYST_LOG_RETAIN:-5}"
  case "$retain" in (*[!0-9]*) retain=5 ;; esac   # non-numeric → default
  # Force base-10: an all-digit value with a leading zero (e.g. 08, 09, 010)
  # is otherwise read as octal by every `$(( ))` below — 08/09 are a fatal
  # arithmetic error and 010 would mean 8, not 10. All-digit is guaranteed above.
  retain=$((10#$retain))
  [ "$retain" -gt 0 ] 2>/dev/null || return 0     # 0 (or invalid) → disabled

  # No-op unless there is real prior content to preserve.
  [ -s "$log" ] || return 0

  {
    # Drop the oldest, then shift .k -> .(k+1) from the top down.
    rm -f "${log}.${retain}"
    local k
    k=$((retain - 1))
    while [ "$k" -ge 1 ]; do
      [ -e "${log}.${k}" ] && mv -f "${log}.${k}" "${log}.$((k + 1))"
      k=$((k - 1))
    done
    # Copy (do NOT rename) the primary log so its inode survives the daemon's `>`.
    cp -p "$log" "${log}.1"
  } 2>/dev/null || true

  return 0
}
