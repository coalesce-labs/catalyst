#!/usr/bin/env bash
# materialize-coord-kit.sh — CTL-2145. Bakes the committed coord kit into the DURABLE
# runtime dir ${CATALYST_DIR:-$HOME/catalyst}/comms/coord.
#
# WHY THIS EXISTS. On 2026-08-21 the fleet's account-rotation / lane-relaunch tooling ran
# out of a concierge session's `~/.claude/jobs/<id>/tmp/` dir: the launchers lived there and
# `fleet-account.current` was a SYMLINK into it. When that job record was cleaned up, both
# vanished, the watchdog kept running as a blind zombie holding deleted inodes, and when the
# active Claude account got rate-walled nothing was left to detect it or rotate. ~75 minutes
# of fleet outage, caused entirely by WHERE the files were.
#
# So: real files, never symlinks. A symlink back into this repo would reproduce the same
# class of failure — a linked worktree is deleted at teardown just as surely as a job dir.
#
# Generated (overwritten on every run):
#   lane-relaunch.sh            the watchdog
#   launch-on-<handle>.sh       one per provisioned account handle, from the template
# Seeded ONLY when absent (operator state — never clobbered):
#   lanes.manifest              from templates/lanes.manifest.example
#   fleet-account.current       the currently-selected handle
#   lane-pids/                  the watchdog's pid + relaunch-window files
#
# Idempotent. CATALYST_DIR-scoped so tests never touch a real runtime dir.
#
# Usage:
#   materialize-coord-kit.sh [--dry-run]
# Env:
#   CATALYST_DIR          runtime root                 (default $HOME/catalyst)
#   CLAUDE_ACCOUNTS_ENV   provisioned-handle source    (default ~/.config/catalyst/claude-accounts.env)

set -uo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
COORD_SRC="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
COORD_RT="${CATALYST_DIR}/comms/coord"
ACCOUNTS_ENV="${CLAUDE_ACCOUNTS_ENV:-${HOME}/.config/catalyst/claude-accounts.env}"
TEMPLATES="${COORD_SRC}/templates"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help | -h)
      echo "Usage: materialize-coord-kit.sh [--dry-run]"
      echo "  Bakes the coord kit into \${CATALYST_DIR:-\$HOME/catalyst}/comms/coord as real files."
      exit 0
      ;;
    *)
      echo "materialize-coord-kit.sh: unknown argument '$arg'" >&2
      exit 2
      ;;
  esac
done

log() { echo "materialize-coord-kit: $*"; }
warn() { echo "materialize-coord-kit: $*" >&2; }

# KIT_SCRIPTS — the executables copied verbatim into the runtime dir. An EXPLICIT list,
# not a `coord/*.sh` glob: a glob silently absorbs whatever lands in this directory
# later (including this script itself), and a missing member should be a loud error
# rather than a kit that is quietly one file short.
KIT_SCRIPTS=(
  lane-relaunch.sh
  account-rotation-watch.sh
)

# _handles — the provisioned account handles, in file order, parsed from
# claude-accounts.env's `CLAUDE_TOKEN_<handle>=` DEFINITION lines.
#
# SECRETS HYGIENE (mirrors catalyst-stack's claude-account verb): `grep -oE` emits only
# the matched KEY prefix, never the rest of the line, so no token VALUE is ever captured
# into a variable, printed, or written to a generated file. Do not relax this to a
# whole-line read.
_handles() {
  [[ -f "$ACCOUNTS_ENV" ]] || return 0
  grep -oE '^CLAUDE_TOKEN_acct[0-9]+=' "$ACCOUNTS_ENV" 2>/dev/null |
    sed -E 's/^CLAUDE_TOKEN_(acct[0-9]+)=$/\1/' |
    awk '!seen[$0]++'
}

# _active_handle — the handle named by the `_catalyst_active_token="$CLAUDE_TOKEN_acctN"`
# selector line. Prints nothing when absent — NEVER guesses (the same contract as
# catalyst-stack's _ca_current_active_handle).
_active_handle() {
  [[ -f "$ACCOUNTS_ENV" ]] || return 0
  grep -m1 -oE '_catalyst_active_token="\$CLAUDE_TOKEN_acct[0-9]+"' "$ACCOUNTS_ENV" 2>/dev/null |
    sed -E 's/.*CLAUDE_TOKEN_(acct[0-9]+)".*/\1/'
}

# _install_file SRC DEST — atomic (tmp + mv) copy as a REAL file. Any pre-existing symlink
# at DEST is removed first: `cp` would otherwise follow it and write THROUGH the link, so a
# dangling-link runtime dir would silently stay a dangling-link runtime dir.
_install_file() {
  local src="$1" dest="$2" mode="${3:-}"
  [[ -f "$src" ]] || { warn "missing kit source ${src}"; return 1; }
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would write ${dest}"
    return 0
  fi
  [[ -L "$dest" ]] && rm -f "$dest"
  local tmp="${dest}.tmp.$$"
  cp "$src" "$tmp" || { warn "could not stage ${dest}"; rm -f "$tmp"; return 1; }
  [[ -n "$mode" ]] && chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest" || { warn "could not install ${dest}"; rm -f "$tmp"; return 1; }
  return 0
}

# ─── runtime dir ─────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "would create ${COORD_RT} and ${COORD_RT}/lane-pids"
else
  mkdir -p "${COORD_RT}/lane-pids" || {
    warn "could not create ${COORD_RT} — nothing materialized"
    exit 1
  }
fi
log "runtime dir: ${COORD_RT}"

# ─── kit scripts (overwritten every run) ─────────────────────────────────────

RC=0
for s in "${KIT_SCRIPTS[@]}"; do
  if [[ ! -f "${COORD_SRC}/${s}" ]]; then
    # A kit member that has not been authored yet is a WARN, not a failure: the kit is
    # built up across phases and a partially-populated coord dir must still materialize
    # what it does have. A member that exists but cannot be installed IS a failure.
    warn "kit script ${s} is not present in ${COORD_SRC} — skipping (nothing to bake)"
    continue
  fi
  if _install_file "${COORD_SRC}/${s}" "${COORD_RT}/${s}" 755; then
    log "baked ${s}"
  else
    RC=1
  fi
done

# ─── per-account launchers ───────────────────────────────────────────────────

LAUNCHER_TEMPLATE="${TEMPLATES}/launch-on-account.sh.template"
HANDLES="$(_handles)"

if [[ ! -f "$ACCOUNTS_ENV" ]]; then
  # NON-FATAL and NAMED. This runs as a delegate of `catalyst-stack install-services`,
  # where a host with no accounts provisioned is an ordinary, expected state — but a
  # SILENT no-op here reads exactly like a successful materialize, which is how the
  # incident stayed invisible. Say which file was missing.
  warn "no claude-accounts.env at ${ACCOUNTS_ENV} — generated NO per-account launchers (not an error: this host has no accounts provisioned)"
elif [[ -z "$HANDLES" ]]; then
  warn "no CLAUDE_TOKEN_acctN definitions found in ${ACCOUNTS_ENV} — generated NO per-account launchers"
elif [[ ! -f "$LAUNCHER_TEMPLATE" ]]; then
  warn "launcher template missing at ${LAUNCHER_TEMPLATE} — generated NO per-account launchers"
  RC=1
else
  while IFS= read -r handle; do
    [[ -n "$handle" ]] || continue
    dest="${COORD_RT}/launch-on-${handle}.sh"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "would generate launch-on-${handle}.sh"
      continue
    fi
    tmp="${dest}.tmp.$$"
    # $HOME and the handle are both substituted; neither can carry a sed metacharacter
    # in any supported configuration (handles are ^acct[0-9]+$ by construction above),
    # but $HOME can contain `&` or `|`, so escape it.
    home_esc="$(printf '%s' "$HOME" | sed -e 's/[&|\\]/\\&/g')"
    if sed -e "s|REPLACE_ACCOUNT|${handle}|g" -e "s|REPLACE_HOME|${home_esc}|g" \
      "$LAUNCHER_TEMPLATE" >"$tmp"; then
      [[ -L "$dest" ]] && rm -f "$dest"
      chmod 755 "$tmp"
      mv -f "$tmp" "$dest" && log "generated launch-on-${handle}.sh" || { warn "could not install ${dest}"; RC=1; }
    else
      warn "could not render launch-on-${handle}.sh"
      rm -f "$tmp"
      RC=1
    fi
  done <<<"$HANDLES"
fi

# ─── operator state: seeded once, never clobbered ────────────────────────────

MANIFEST_RT="${COORD_RT}/lanes.manifest"
if [[ -e "$MANIFEST_RT" ]]; then
  log "lanes.manifest already present — left as-is (operator state)"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  log "would seed lanes.manifest from the example"
elif [[ -f "${TEMPLATES}/lanes.manifest.example" ]]; then
  _install_file "${TEMPLATES}/lanes.manifest.example" "$MANIFEST_RT" 644 && log "seeded lanes.manifest from the example"
else
  warn "no lanes.manifest.example to seed from"
fi

CUR_RT="${COORD_RT}/fleet-account.current"
ACTIVE="$(_active_handle)"
[[ -z "$ACTIVE" ]] && ACTIVE="$(printf '%s\n' "$HANDLES" | head -1)"
if [[ -e "$CUR_RT" && ! -L "$CUR_RT" ]]; then
  log "fleet-account.current already present ($(cat "$CUR_RT" 2>/dev/null)) — left as-is (operator state)"
elif [[ -z "$ACTIVE" ]]; then
  warn "cannot seed fleet-account.current — no active selector and no provisioned handles in ${ACCOUNTS_ENV}"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  log "would seed fleet-account.current=${ACTIVE}"
else
  # A pre-existing SYMLINK here is replaced, not written through: a link into a deleted
  # job dir is the exact artifact that broke the fleet, and preserving it as "operator
  # state" would preserve the outage.
  [[ -L "$CUR_RT" ]] && { rm -f "$CUR_RT"; warn "replaced a SYMLINK fleet-account.current with a real file (CTL-2145)"; }
  printf '%s\n' "$ACTIVE" >"$CUR_RT" && log "seeded fleet-account.current=${ACTIVE}"
fi

if [[ "$RC" -eq 0 ]]; then
  log "done"
else
  warn "completed with errors (rc=${RC})"
fi
exit "$RC"
