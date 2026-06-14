#!/usr/bin/env bash
# lib/host-identity.sh — host-identity primitives for bash emitters.
#
# Mirrors execution-core/lib/host-identity.mjs and orch-monitor/lib/canonical-event-shared.ts.
# All three runtimes use the same algorithm so host.id is identical for a given
# machine regardless of which stack emits the event (cross-stack equality test
# in __tests__/host-identity.test.sh locks this invariant).
#
# Algorithm:
#   host.name = CATALYST_HOST_NAME  (if set and non-empty)
#               else os.hostname() with trailing ".local" stripped
#   host.id   = sha256(host.name)[:16]   # 16 hex chars, same shape as spanId
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_HOST_IDENTITY_SH_LOADED:-}" ]] && return 0
_CATALYST_HOST_IDENTITY_SH_LOADED=1

# __host_name_from RAW — strip trailing .local from a hostname string.
__host_name_from() { printf '%s' "${1%.local}"; }

# catalyst_host_name — resolve the effective host name.
# Honors CATALYST_HOST_NAME override for multi-host alias scenarios.
catalyst_host_name() {
  if [[ -n "${CATALYST_HOST_NAME:-}" ]]; then
    printf '%s' "$CATALYST_HOST_NAME"
    return
  fi
  __host_name_from "$(hostname 2>/dev/null || uname -n)"
}

# __host_id_from NAME — sha256(NAME)[:16], mirrors deriveSpanId truncation shape.
__host_id_from() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -c1-16
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-16
  else
    printf '0000000000000000'
  fi
}

# catalyst_host_id — sha256(catalyst_host_name)[:16].
catalyst_host_id() { __host_id_from "$(catalyst_host_name)"; }
