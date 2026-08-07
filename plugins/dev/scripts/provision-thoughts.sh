#!/usr/bin/env bash
# provision-thoughts.sh — lay down a clean HLT (HumanLayer Thoughts) layout for a Catalyst NODE.
#
# Purpose (CTL-1214 / bug #6): make the thoughts system a PROVISIONED, VERIFIED part of a node so a
# fresh box (or server-side install) gets the right per-org thoughts repos, a clean humanlayer.json
# (a correct global fallback, deterministic repoMappings for headless bg agents), and working
# bidirectional sync — BEFORE the node is added to the roster (the sync-gate activates at roster>1).
#
# DESIGN: thoughts/shared/plans/2026-06-16-cluster-hlt-thoughts-model.md
#
# This script is for NODES (fresh clean layout under $HLT). It does NOT relocate existing embedded
# clones on a dev laptop / live seed (100+ worktree symlinks point at them) — those keep their layout
# and only get the config fixes applied out-of-band.
#
# Usage:
#   provision-thoughts.sh [--node-user NAME] [--hlt-root DIR] [--config FILE] [--orgs a,b,c]
#                         [--registry FILE] [--primary-org ORG]
#                         [--dry-run] [--no-clone] [--verify-only]
#
# Where each org comes from: a registry project's thoughts org is read from that
# project's own Layer-1 `.catalyst/config.json` → `catalyst.thoughts.org` (a
# GitHub owner). It falls back — loudly — to `catalyst.thoughts.profile` (a
# HumanLayer alias, right only when the names coincide), then to the checkout
# path's own org segment. There is no hardcoded org catalog.
#
# --primary-org declares the global-fallback/defaultProfile org explicitly, so a
# registry's ORDER never decides it. catalyst-join.sh forwards the join bundle's
# .thoughtsOrg here.
#
# Env overrides (for sandbox testing):
#   HLT_ROOT          default ${CATALYST_DIR:-$HOME/catalyst}/hlt
#   HL_CONFIG         default $HOME/.config/humanlayer/humanlayer.json
#   CATALYST_REGISTRY default $HOME/catalyst/registry.json  (or execution-core/registry.json)
#   CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG
#                     default for --primary-org. No hardcoded default — a
#                     from-scratch standalone invocation with none of --orgs,
#                     --registry, --primary-org, or this set is a hard error.
#
set -uo pipefail

info() { echo "[provision-thoughts] $*"; }
warn() { echo "[provision-thoughts] WARN: $*" >&2; }
fail() { echo "[provision-thoughts] ERROR: $*" >&2; }

# ── Org → thoughts remote ─────────────────────────────────────────────────────
# The thoughts repo is always <org>/thoughts over HTTPS (node auth = gh + HTTPS).
org_remote() { echo "https://github.com/$1/thoughts.git"; }

# Map a registry repoRoot path → its GitHub org (…github/<org>/<repo>). Empty if unrecognized.
# This is the org of the CODE checkout, which is only a last-resort guess at the
# thoughts org — the two legitimately differ (see root_thoughts_org below).
repo_root_org() { sed -nE 's|.*/github/([^/]+)/[^/]+/?.*|\1|p' <<<"$1" | head -1; }

# ── Per-org profile map (parallel arrays — macOS bash 3.2 has no assoc arrays) ─
# ORGS[i] ↔ ORG_PROFILES[i]. The HumanLayer profile key need NOT equal the org:
# a project can host its thoughts under github.com/rightsite-cloud while reaching
# them through the local profile alias `adva`. Both come from the project's own
# Layer-1 config, never a hardcoded catalog.
declare -a ORGS=() ORG_PROFILES=()
org_profile() {
  local i=0
  while [[ $i -lt ${#ORGS[@]} ]]; do
    [[ "${ORGS[$i]}" == "$1" ]] && { echo "${ORG_PROFILES[$i]}"; return 0; }
    i=$((i + 1))
  done
  echo "$1"
}
# Append an org (and its profile) if not already present.
add_org() {
  local org="$1" prof="${2:-$1}" i=0
  while [[ $i -lt ${#ORGS[@]} ]]; do
    [[ "${ORGS[$i]}" == "$org" ]] && return 0
    i=$((i + 1))
  done
  ORGS+=("$org"); ORG_PROFILES+=("$prof")
}

# ── Defaults / args ───────────────────────────────────────────────────────────
NODE_USER="${USER:-$(whoami)}"
HLT_ROOT="${HLT_ROOT:-${CATALYST_DIR:-$HOME/catalyst}/hlt}"
HL_CONFIG="${HL_CONFIG:-$HOME/.config/humanlayer/humanlayer.json}"
REGISTRY="${CATALYST_REGISTRY:-}"
ORGS_CSV=""
DRY_RUN=0; NO_CLONE=0; VERIFY_ONLY=0
# The global fallback + defaultProfile target. Deliberately NOT hardcoded to any
# specific org — this script is shared across forks/deployments with different
# thoughts orgs, and baking one in was the CTL-1214 verify bug in the first place
# (a stale upstream org default that doesn't exist for a downstream fork).
# Declared by --primary-org (or this env default); when nothing declares it, it
# settles on the first derived org.
PRIMARY_ORG="${CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG:-}"

while [[ $# -gt 0 ]]; do case "$1" in
  --node-user) NODE_USER="$2"; shift 2 ;;
  --hlt-root)  HLT_ROOT="$2"; shift 2 ;;
  --config)    HL_CONFIG="$2"; shift 2 ;;
  --orgs)      ORGS_CSV="$2"; shift 2 ;;
  --registry)  REGISTRY="$2"; shift 2 ;;
  --primary-org) PRIMARY_ORG="$2"; shift 2 ;;
  --dry-run)   DRY_RUN=1; shift ;;
  --no-clone)  NO_CLONE=1; shift ;;
  --verify-only) VERIFY_ONLY=1; shift ;;
  -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) fail "unknown arg: $1"; exit 2 ;;
esac; done

command -v jq >/dev/null || { fail "jq required"; exit 1; }
command -v git >/dev/null || { fail "git required"; exit 1; }

# ── Resolve each registry project's thoughts org / profile / subdir ───────────
# Parallel arrays, one entry per registry repoRoot we could resolve.
declare -a ROOT_PATHS=() ROOT_ORGS=() ROOT_PROFILES=() ROOT_SUBS=()

# Resolve one repoRoot from its OWN Layer-1 config — the only place that knows
# which GitHub org hosts its thoughts repo. Ordered sources, each fallback loud:
#   1. catalyst.thoughts.org      — authoritative GitHub owner
#   2. catalyst.thoughts.profile  — a HumanLayer alias; right only when the two
#                                   names coincide, so WARN and keep going
#   3. the repoRoot's own /github/<org>/ path segment — the code repo's owner,
#      which legitimately differs from the thoughts owner; WARN
# A repoRoot that yields none of the three is skipped (warned), never guessed.
load_registry_roots() {
  local root cfg o p d
  while IFS= read -r root; do
    [[ -z "$root" ]] && continue
    cfg="$root/.catalyst/config.json"
    o=""; p=""; d=""
    if [[ -f "$cfg" ]]; then
      o="$(jq -r '.catalyst.thoughts.org // empty' "$cfg" 2>/dev/null)"
      p="$(jq -r '.catalyst.thoughts.profile // empty' "$cfg" 2>/dev/null)"
      # The repo's declared thoughts subdir — e.g. catalyst's Layer-1 maps
      # repoRoot "catalyst" → "catalyst-workspace". Nested under the top-level
      # "catalyst" object: .catalyst.thoughts.directory.
      d="$(jq -r '.catalyst.thoughts.directory // empty' "$cfg" 2>/dev/null)"
    fi
    if [[ -z "$o" && -n "$p" ]]; then
      warn "$root: catalyst.thoughts.org is unset — falling back to catalyst.thoughts.profile ('$p') as the GitHub org. profile is a HumanLayer alias and need not equal the owner; set catalyst.thoughts.org in that repo's .catalyst/config.json."
      o="$p"
    fi
    if [[ -z "$o" ]]; then
      o="$(repo_root_org "$root")"
      [[ -n "$o" ]] && warn "$root: no catalyst.thoughts.org or .profile — falling back to the checkout's own path org ('$o'). The thoughts owner can differ from the code owner; set catalyst.thoughts.org."
    fi
    if [[ -z "$o" ]]; then
      warn "$root: cannot determine a thoughts org (no Layer-1 thoughts config, unrecognized path) — skipping this project."
      continue
    fi
    ROOT_PATHS+=("$root"); ROOT_ORGS+=("$o"); ROOT_PROFILES+=("${p:-$o}")
    ROOT_SUBS+=("${d:-$(basename "$root")}")
  done < <(jq -r '(.projects // [])[].repoRoot // empty' "$REGISTRY" 2>/dev/null)
}

# Always resolve the registry when one is readable — even under --orgs, since
# repoMappings are seeded from it regardless of which orgs get provisioned.
[[ -n "$REGISTRY" && -f "$REGISTRY" ]] && load_registry_roots

# ── Derive the org set ────────────────────────────────────────────────────────
if [[ -n "$ORGS_CSV" ]]; then
  # A bare CSV carries no profile information — profile == org (identity).
  declare -a _csv=()
  IFS=',' read -r -a _csv <<<"$ORGS_CSV"
  for o in "${_csv[@]}"; do [[ -n "$o" ]] && add_org "$o"; done
elif [[ -n "$REGISTRY" && -f "$REGISTRY" ]]; then
  info "Deriving orgs from registry: $REGISTRY"
  # add_org de-dupes, so no separate dedupe pass. Guard the empty-array
  # expansion: under `set -u`, macOS system bash 3.2 (the default on a fresh box
  # before Homebrew) aborts on "${ROOT_ORGS[@]}" when the array is empty.
  if ((${#ROOT_ORGS[@]})); then
    i=0
    while [[ $i -lt ${#ROOT_ORGS[@]} ]]; do
      add_org "${ROOT_ORGS[$i]}" "${ROOT_PROFILES[$i]}"
      i=$((i + 1))
    done
  fi
elif [[ -n "$PRIMARY_ORG" ]]; then
  warn "no --orgs and no readable --registry; defaulting to primary only ($PRIMARY_ORG)"
  add_org "$PRIMARY_ORG"
else
  fail "no org specified — pass --orgs, --registry, --primary-org, or set CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG"
  exit 1
fi
# ORGS may still be empty here (a --registry whose repoRoots resolved to no org
# at all, and no CSV/override). Fall back to the declared primary if one was
# given; otherwise this is a genuine "don't know which org" error — do NOT
# silently guess. (bash 3.2 + set -u safety: the empty-array expansions below
# are never reached in the failure case.)
if ((${#ORGS[@]} == 0)); then
  if [[ -n "$PRIMARY_ORG" ]]; then
    add_org "$PRIMARY_ORG"
  else
    fail "registry yielded no recognized org and no --primary-org / CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG is set"
    exit 1
  fi
elif [[ -n "$PRIMARY_ORG" ]]; then
  # Force-include the declared primary. A no-op when the registry already
  # resolved it — which is what we want, since that entry carries the project's
  # real profile alias and this one would only know the identity default.
  add_org "$PRIMARY_ORG"
fi
# No primary declared: it is whichever org came out first (--orgs order, or
# registry derivation order). Callers that care must declare one — see
# catalyst-join.sh, which forwards the seed's bundle .thoughtsOrg.
PRIMARY_ORG="${PRIMARY_ORG:-${ORGS[0]}}"
info "Node org set: ${ORGS[*]}"
# Machine-readable: catalyst-join.sh parses this to locate the primary clone
# on the provisioner's failure path instead of assuming a hardcoded org name.
info "Primary org: $PRIMARY_ORG"
info "HLT root: $HLT_ROOT   config: $HL_CONFIG   user: $NODE_USER"
[[ "$DRY_RUN" -eq 1 ]] && info "DRY-RUN: will not clone or write config"

# ── 1. Clone each org's thoughts repo into $HLT/<org>/thoughts ─────────────────
clone_org() {
  local org="$1" dest="$HLT_ROOT/$1/thoughts" remote; remote="$(org_remote "$org")"
  if [[ -d "$dest/.git" ]]; then info "  $org: already present at $dest"; return 0; fi
  if [[ "$DRY_RUN" -eq 1 || "$NO_CLONE" -eq 1 ]]; then info "  $org: WOULD clone $remote → $dest"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  info "  $org: cloning $remote → $dest"
  git clone -q "$remote" "$dest" || { fail "clone failed for $org ($remote)"; return 1; }
}

# ── 2. Write a clean humanlayer.json ──────────────────────────────────────────
write_config() {
  local profiles="{}" pname dest
  for org in "${ORGS[@]}"; do
    pname="$(org_profile "$org")"; dest="$HLT_ROOT/$org/thoughts"
    profiles="$(jq --arg p "$pname" --arg r "$dest" \
      '. + {($p): {thoughtsRepo:$r, reposDir:"repos", globalDir:"global"}}' <<<"$profiles")"
  done
  local primary_repo="$HLT_ROOT/$PRIMARY_ORG/thoughts"
  local primary_profile; primary_profile="$(org_profile "$PRIMARY_ORG")"
  # seed repoMappings from registry repoRoots (deterministic — bg agents resolve w/o direnv)
  # Every field here was resolved once, up front, by load_registry_roots — from
  # each project's OWN Layer-1 config, not from its checkout path.
  local mappings="{}"
  local i=0
  while [[ $i -lt ${#ROOT_PATHS[@]} ]]; do
    mappings="$(jq --arg path "${ROOT_PATHS[$i]}" --arg repo "${ROOT_SUBS[$i]}" \
      --arg prof "${ROOT_PROFILES[$i]}" \
      '. + {($path): {repo:$repo, profile:$prof}}' <<<"$mappings")"
    i=$((i + 1))
  done

  local new_thoughts
  new_thoughts="$(jq -n \
    --arg tr "$primary_repo" --arg dp "$primary_profile" --arg user "$NODE_USER" \
    --argjson profiles "$profiles" --argjson mappings "$mappings" \
    '{thoughtsRepo:$tr, defaultProfile:$dp, reposDir:"repos", globalDir:"global",
      user:$user, profiles:$profiles, repoMappings:$mappings}')"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "DRY-RUN humanlayer.json .thoughts would be:"; echo "$new_thoughts" | jq .
    return 0
  fi
  mkdir -p "$(dirname "$HL_CONFIG")"
  local base="{}"; [[ -f "$HL_CONFIG" ]] && base="$(cat "$HL_CONFIG")"
  local tmp; tmp="$(mktemp "$(dirname "$HL_CONFIG")/.hl.XXXXXX")"
  jq --argjson t "$new_thoughts" '.thoughts = $t' <<<"$base" > "$tmp" && mv "$tmp" "$HL_CONFIG"
  chmod 600 "$HL_CONFIG"
  info "Wrote clean .thoughts into $HL_CONFIG (0600)"
}

# ── 3. Verify read + push auth + resolution ───────────────────────────────────
verify() {
  local ok=1
  for org in "${ORGS[@]}"; do
    local dest="$HLT_ROOT/$org/thoughts" remote; remote="$(org_remote "$org")"
    printf '[provision-thoughts]   %-16s ' "$org:"
    if [[ ! -d "$dest/.git" ]]; then echo "MISSING (not cloned)"; ok=0; continue; fi
    if git -C "$dest" ls-remote --heads origin main >/dev/null 2>&1; then printf 'read:OK '; else printf 'read:FAIL '; ok=0; fi
    # push auth probe: dry-run push (exercises credentials without writing).
    # non-ff is OK (means auth works), only real auth errors = FAIL.
    # Reset push_rc/push_out EVERY iteration: bash does not clear a same-named
    # `local` across loop iterations, and `... || push_rc=$?` only assigns on
    # failure — so a stale rc from a prior org would leak and mis-report later
    # orgs as push:FAIL (CTL-1214 verify finding).
    local push_out="" push_rc=""
    push_out="$(git -C "$dest" push --dry-run origin main 2>&1)" || push_rc=$?
    if [[ -z "${push_rc:-}" ]] || grep -q 'non-fast-forward\|up to date' <<<"$push_out"; then echo "push:OK"; else echo "push:FAIL (gh auth / HTTPS creds needed)"; ok=0; fi
  done
  [[ "$ok" -eq 1 ]] && info "VERIFY: all orgs read+push OK" || warn "VERIFY: one or more orgs failed (see above)"
  return $((1-ok))
}

# ── Main ──────────────────────────────────────────────────────────────────────
if [[ "$VERIFY_ONLY" -eq 0 ]]; then
  info "== clone phase =="
  for org in "${ORGS[@]}"; do clone_org "$org" || true; done
  info "== config phase =="
  write_config
fi
info "== verify phase =="
verify
