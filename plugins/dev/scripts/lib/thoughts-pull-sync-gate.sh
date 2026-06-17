#!/usr/bin/env bash
# thoughts-pull-sync-gate.sh (CTL-1236) — roster-gated, ff-only, NON-FATAL
# pull-before-read gate for phase-research and research-codebase.
#
# Called before any thoughts read to fast-forward all HumanLayer thoughts
# checkouts so research picks up the freshest peer state even between timer
# ticks (ai.coalesce.catalyst-thoughts-sync). thoughts-locator and
# thoughts-analyzer read whatever this gate (or the periodic timer) last
# fast-forwarded; results reflect the last successful pull, not a live remote
# fetch.
#
# Contract (diverges from the write-side thoughts-sync-gate.sh):
#   roster <= 1 (absent/malformed hosts.json) → exit 0, pull NOT invoked
#   roster >  1 + pull succeeds               → exit 0
#   roster >  1 + pull fails                  → warn to stderr, STILL exit 0
#                                               (never blocks research)
#
# Usage (from phase-research / research-codebase):
#   "${PLUGIN_ROOT}/scripts/lib/thoughts-pull-sync-gate.sh" || true
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve roster — mirrors getClusterHosts: absent/malformed → single-host default.
CFG_DIR="$(dirname "${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}")"
HOSTS_FILE="${CFG_DIR}/hosts.json"
ROSTER_SIZE=1
if [[ -f "$HOSTS_FILE" ]]; then
  n="$(jq -r '[.[] | select(type=="string" and length>0)] | length' "$HOSTS_FILE" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && ROSTER_SIZE="$n"
fi
[[ "$ROSTER_SIZE" -le 1 ]] && exit 0   # single-host → exact no-op

# Multi-host: run the pull-sync script (full data-driven fetch+ff-merge).
# CATALYST_PULL_SYNC_CMD can be injected by tests; otherwise prefer the
# installed CLI symlink, fall back to the in-repo script.
if [[ -n "${CATALYST_PULL_SYNC_CMD:-}" ]]; then
  PULL_CMD="$CATALYST_PULL_SYNC_CMD"
elif [[ -x "${HOME}/.catalyst/bin/thoughts-pull-sync" ]]; then
  PULL_CMD="${HOME}/.catalyst/bin/thoughts-pull-sync"
else
  PULL_CMD="${SELF_DIR}/../thoughts-pull-sync.sh"
fi

if ! "$PULL_CMD" >/dev/null 2>&1; then
  echo "thoughts-pull-sync-gate: pull failed (roster=${ROSTER_SIZE}) — continuing anyway (non-fatal)" >&2
fi

exit 0
