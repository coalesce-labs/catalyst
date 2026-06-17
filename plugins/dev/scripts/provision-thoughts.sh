#!/usr/bin/env bash
# provision-thoughts.sh — lay down a clean HLT (HumanLayer Thoughts) layout for a Catalyst NODE.
#
# Purpose (CTL-1214 / bug #6): make the thoughts system a PROVISIONED, VERIFIED part of a node so a
# fresh box (or server-side install) gets the right per-org thoughts repos, a clean humanlayer.json
# (no groundworkapp global fallback, deterministic repoMappings for headless bg agents), and working
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
#                         [--registry FILE] [--dry-run] [--no-clone] [--verify-only]
#
# Env overrides (for sandbox testing):
#   HLT_ROOT          default ${CATALYST_DIR:-$HOME/catalyst}/hlt
#   HL_CONFIG         default $HOME/.config/humanlayer/humanlayer.json
#   CATALYST_REGISTRY default $HOME/catalyst/registry.json  (or execution-core/registry.json)
#
set -uo pipefail

info() { echo "[provision-thoughts] $*"; }
warn() { echo "[provision-thoughts] WARN: $*" >&2; }
fail() { echo "[provision-thoughts] ERROR: $*" >&2; }

# ── Canonical org → {profile, thoughts remote} catalog ────────────────────────
# Standardized on GitHub ORG names (Q-DIRNAME: rightsite-cloud, not groundworkapp).
# profile name is the HumanLayer profile key; remote is the HTTPS git URL (node auth = gh + HTTPS).
org_profile() { case "$1" in
  coalesce-labs)   echo "coalesce-labs" ;;
  rightsite-cloud) echo "adva" ;;
  ryanrozich)      echo "ryanrozich" ;;
  *)               echo "$1" ;;  # default: profile == org
esac; }
org_remote() { echo "https://github.com/$1/thoughts.git"; }

# Map a registry repoRoot path → its GitHub org (…github/<org>/<repo>). Empty if unrecognized.
repo_root_org() { sed -nE 's|.*/github/([^/]+)/[^/]+/?.*|\1|p' <<<"$1" | head -1; }
# Adva code repo lives under groundworkapp/ locally but its THOUGHTS repo is rightsite-cloud.
normalize_org() { case "$1" in groundworkapp) echo "rightsite-cloud" ;; *) echo "$1" ;; esac; }

# ── Defaults / args ───────────────────────────────────────────────────────────
NODE_USER="${USER:-$(whoami)}"
HLT_ROOT="${HLT_ROOT:-${CATALYST_DIR:-$HOME/catalyst}/hlt}"
HL_CONFIG="${HL_CONFIG:-$HOME/.config/humanlayer/humanlayer.json}"
REGISTRY="${CATALYST_REGISTRY:-}"
ORGS_CSV=""
DRY_RUN=0; NO_CLONE=0; VERIFY_ONLY=0
PRIMARY_ORG="coalesce-labs"   # global fallback + defaultProfile target

while [[ $# -gt 0 ]]; do case "$1" in
  --node-user) NODE_USER="$2"; shift 2 ;;
  --hlt-root)  HLT_ROOT="$2"; shift 2 ;;
  --config)    HL_CONFIG="$2"; shift 2 ;;
  --orgs)      ORGS_CSV="$2"; shift 2 ;;
  --registry)  REGISTRY="$2"; shift 2 ;;
  --dry-run)   DRY_RUN=1; shift ;;
  --no-clone)  NO_CLONE=1; shift ;;
  --verify-only) VERIFY_ONLY=1; shift ;;
  -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) fail "unknown arg: $1"; exit 2 ;;
esac; done

command -v jq >/dev/null || { fail "jq required"; exit 1; }
command -v git >/dev/null || { fail "git required"; exit 1; }

# ── Derive the org set ────────────────────────────────────────────────────────
declare -a ORGS=()
if [[ -n "$ORGS_CSV" ]]; then
  IFS=',' read -r -a ORGS <<<"$ORGS_CSV"
elif [[ -n "$REGISTRY" && -f "$REGISTRY" ]]; then
  info "Deriving orgs from registry: $REGISTRY"
  while IFS= read -r root; do
    [[ -z "$root" ]] && continue
    o="$(normalize_org "$(repo_root_org "$root")")"
    [[ -n "$o" ]] && ORGS+=("$o")
  done < <(jq -r '(.projects // [])[].repoRoot // empty' "$REGISTRY" 2>/dev/null)
  # de-dupe — guard the empty-array expansion: under `set -u`, macOS system bash
  # 3.2 (the default on a fresh box before Homebrew) aborts on "${ORGS[@]}" when
  # ORGS is empty (e.g. a registry whose repoRoots match no /github/<org>/ path).
  if ((${#ORGS[@]})); then
    IFS=$'\n' ORGS=($(printf '%s\n' "${ORGS[@]}" | awk '!seen[$0]++')); unset IFS
  fi
else
  warn "no --orgs and no readable --registry; defaulting to primary only ($PRIMARY_ORG)"
  ORGS=("$PRIMARY_ORG")
fi
# Ensure the primary org is always present (and ORGS is never empty before the
# expansions below — bash 3.2 + set -u safety).
if ((${#ORGS[@]} == 0)); then
  ORGS=("$PRIMARY_ORG")
elif [[ " ${ORGS[*]} " != *" $PRIMARY_ORG "* ]]; then
  ORGS=("$PRIMARY_ORG" "${ORGS[@]}")
fi
info "Node org set: ${ORGS[*]}"
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
  local mappings="{}"
  if [[ -n "$REGISTRY" && -f "$REGISTRY" ]]; then
    while IFS=$'\t' read -r root team; do
      [[ -z "$root" ]] && continue
      local o p sub d
      o="$(normalize_org "$(repo_root_org "$root")")"; p="$(org_profile "$o")"
      # Default the thoughts subdir name to the repoRoot basename, ALWAYS — must be
      # set unconditionally before any branch: bash preserves a same-named `local`
      # across loop iterations, so leaving `sub` unset in the no-config branch would
      # (a) crash under `set -u` when the first repoRoot lacks a config, and
      # (b) leak the prior iteration's value to a later config-less repoRoot.
      sub="$(basename "$root")"
      # Prefer the repo's declared thoughts subdir when present — e.g. catalyst's
      # Layer-1 config maps repoRoot "catalyst" → "catalyst-workspace". The key is
      # nested under the top-level "catalyst" object: .catalyst.thoughts.directory.
      if [[ -f "$root/.catalyst/config.json" ]]; then
        d="$(jq -r '.catalyst.thoughts.directory // empty' "$root/.catalyst/config.json" 2>/dev/null)"
        [[ -n "$d" ]] && sub="$d"
      fi
      mappings="$(jq --arg path "$root" --arg repo "$sub" --arg prof "$p" \
        '. + {($path): {repo:$repo, profile:$prof}}' <<<"$mappings")"
    done < <(jq -r '(.projects // [])[] | "\(.repoRoot)\t\(.team)"' "$REGISTRY" 2>/dev/null)
  fi

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
