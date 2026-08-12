#!/usr/bin/env bash
# Shared process identity/termination helpers. The -ww identity guard and
# zombie-aware death proof originate in catalyst-monitor.sh:820-872.

cpi_pid_is_ours() {
  local pid="$1" pattern="$2" command
  command="$(ps -ww -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ -n "$command" && "$command" == *"$pattern"* ]]
}

cpi_pid_gone() {
  local pid="$1" state
  kill -0 "$pid" 2>/dev/null || return 0
  command -v ps >/dev/null 2>&1 || return 1
  # kill -0 just proved the pid existed. If ps now fails, that may be a race
  # with exit or a permission/tool failure; neither proves death, so fail closed.
  state="$(ps -o state= -p "$pid" 2>/dev/null)" || return 1
  state="${state//[[:space:]]/}"
  [[ -z "$state" ]] && return 0
  case "$state" in [Zz]*) return 0 ;; *) return 1 ;; esac
}

cpi_find_orphans() {
  local pattern="$1" uid pid command self_cmd ancestors=" $$ " current="${PPID:-}"
  uid="$(id -u)" || return 1
  # Exclude scanner forks by their runtime command identity. The callers run
  # this function inside command substitution and the ps pipeline forks again;
  # those descendants inherit our argv but are not covered by the ancestor walk.
  # Exact equality avoids the old broad `awk ` substring false negative. If ps
  # cannot read our identity, fail open so a real orphan is not hidden.
  self_cmd="$(ps -ww -o command= -p "$$" 2>/dev/null | awk '{ $1=$1; print }')"
  while [[ "$current" =~ ^[0-9]+$ && "$current" -gt 1 ]]; do
    ancestors="$ancestors$current "
    current="$(ps -o ppid= -p "$current" 2>/dev/null)" || break
    current="${current//[[:space:]]/}"
  done
  while read -r pid command; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ " $ancestors " == *" $pid "* ]] && continue
    [[ "$command" == *"$pattern"* ]] || continue
    [[ -n "$self_cmd" && "$command" == "$self_cmd" ]] && continue
    printf '%s\n' "$pid"
  done < <(ps -ww -axo uid=,pid=,command= 2>/dev/null | awk -v uid="$uid" '$1 == uid { p=$2; $1=$2=""; sub(/^ +/, ""); print p, $0 }')
}

cpi_stop_pid() {
  local pid="$1" wait_limit="${2:-30}" waited=0
  kill "$pid" 2>/dev/null || true
  while [[ "$waited" -lt "$wait_limit" ]] && ! cpi_pid_gone "$pid"; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if ! cpi_pid_gone "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
    waited=0
    while [[ "$waited" -lt "$wait_limit" ]] && ! cpi_pid_gone "$pid"; do
      sleep 0.1
      waited=$((waited + 1))
    done
  fi
  cpi_pid_gone "$pid"
}
