#!/usr/bin/env bash
# cluster-roster-size.sh (CTL-1490) — roster size for bash callers that must make
# the same multi-host decision the daemon makes.
#
# Exposes: resolve_cluster_roster_size → echoes the roster length, rc 0
#          rc 1 (and echoes nothing) when the canonical roster cannot be read
#
# DELEGATES rather than mirrors. The canonical precedence lives in
# execution-core/config.mjs `resolveClusterHosts()`:
#
#   1. the catalyst-cluster repo's cluster.json.roster   (CTL-1274)
#   2. a static explicit roster                          (escape hatch)
#   3. single-host default                               ([getHostName()])
#
# Re-implementing that ladder in bash is exactly the drift this repo's
# "single source of truth" rule exists to prevent — and it is how the bug this
# helper fixes was introduced: the caller read the RETIRED per-repository
# `.catalyst/hosts.json`, which no longer exists, so every real multi-host
# install resolved to 1 and silently skipped the sync it depends on. Shelling
# out to the real resolver costs one bun start per phase-boundary call and can
# never disagree with the daemon.
#
# config.mjs imports bun:sqlite, so this needs `bun`, not bare node.
#
# Sourceable and bash-3.2 safe. No side-effects on sourcing.

if [[ -n "${_CLUSTER_ROSTER_SIZE_LOADED:-}" ]]; then
  return 0
fi
_CLUSTER_ROSTER_SIZE_LOADED=1

resolve_cluster_roster_size() {
  local root="${1:-${PLUGIN_ROOT:-}}"
  local cfg_mjs="${root}/scripts/execution-core/config.mjs"
  local n=""

  [[ -r "$cfg_mjs" ]] || return 1
  command -v bun >/dev/null 2>&1 || return 1

  # The path travels by env var, not argv, so a path containing spaces or quotes
  # cannot break out of the -e program.
  n="$(CATALYST_ROSTER_CFG_MJS="$cfg_mjs" bun -e '
    import(process.env.CATALYST_ROSTER_CFG_MJS)
      .then((m) => {
        const hosts = m.getClusterHosts();
        process.stdout.write(String(Array.isArray(hosts) ? hosts.length : 1));
      })
      .catch(() => {});
  ' 2>/dev/null)"

  if [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]]; then
    printf '%s' "$n"
    return 0
  fi
  return 1
}
