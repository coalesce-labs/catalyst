#!/usr/bin/env bash
# install-cli.sh — install symlinks for every catalyst-* CLI.
#
# Usage:
#   install-cli.sh                    # install/update symlinks (idempotent)
#   install-cli.sh --bin-dir <path>   # install into <path> instead of the default
#   install-cli.sh --force            # install even if bin dir is not on PATH
#   install-cli.sh --uninstall        # remove catalyst-* symlinks, rmdir if empty
#   install-cli.sh --help
#
# Default bin dir resolution (highest precedence first):
#   1. --bin-dir <path>
#   2. CATALYST_CLI_BIN_DIR env var
#   3. $HOME/.local/bin if it exists (the de-facto Python/pyenv/pipx convention,
#      almost always on PATH)
#   4. $HOME/.catalyst/bin (fallback — works but rarely on PATH out of the box)
#
# Env overrides (primarily for tests):
#   CATALYST_CLI_SOURCE    default: auto-detected (CLAUDE_PLUGIN_ROOT/scripts or this script's dir)
#   CATALYST_CLI_BIN_DIR   default: see resolution above

set -uo pipefail

# Explicit allowlist. Source name → installed command name (.sh suffix stripped).
# Keep this in sync with check-setup.sh's "Catalyst CLI Install" section.
CLI_ENTRIES=(
  "catalyst-comms:catalyst-comms"
  "catalyst-events:catalyst-events"
  "catalyst-filter:catalyst-filter"
  "catalyst-session.sh:catalyst-session"
  "catalyst-state.sh:catalyst-state"
  "catalyst-db.sh:catalyst-db"
  "catalyst-monitor.sh:catalyst-monitor"
  "catalyst-thoughts.sh:catalyst-thoughts"
  "catalyst-claude.sh:catalyst-claude"
)

usage() {
  cat <<'EOF'
Usage: install-cli.sh [--bin-dir <path>] [--force] [--uninstall] [--help]

Installs symlinks for every catalyst-* CLI so they can be invoked by name
from any shell.

Default bin dir: $HOME/.local/bin if it exists, else $HOME/.catalyst/bin.

Options:
  --bin-dir <path>   Install symlinks into <path> instead of the default
  --force            Install even when the bin dir is not on PATH
                     (without --force, the script exits non-zero with a hint
                      so missing PATH setup is hard to miss)
  --uninstall        Remove previously-installed catalyst-* symlinks
  --help, -h         Show this help

Environment overrides (for testing):
  CATALYST_CLI_SOURCE    Source directory containing catalyst-* scripts
  CATALYST_CLI_BIN_DIR   Target directory for symlinks (overrides default resolution)
EOF
}

resolve_source() {
  if [[ -n "${CATALYST_CLI_SOURCE:-}" ]]; then
    echo "$CATALYST_CLI_SOURCE"
    return
  fi
  if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -d "${CLAUDE_PLUGIN_ROOT}/scripts" ]]; then
    echo "${CLAUDE_PLUGIN_ROOT}/scripts"
    return
  fi
  # Fall back to the directory of this running script
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "$self_dir"
}

# Resolve bin dir in precedence order: --bin-dir override > env var >
# $HOME/.local/bin (if exists) > $HOME/.catalyst/bin.
# Prefer .local/bin only when the directory ALREADY exists — we don't auto-create
# it, since users without it almost always have $HOME/.catalyst/bin already in
# muscle memory from older docs.
resolve_bin_dir() {
  if [[ -n "${BIN_DIR_OVERRIDE:-}" ]]; then
    echo "$BIN_DIR_OVERRIDE"
    return
  fi
  if [[ -n "${CATALYST_CLI_BIN_DIR:-}" ]]; then
    echo "$CATALYST_CLI_BIN_DIR"
    return
  fi
  if [[ -d "$HOME/.local/bin" ]]; then
    echo "$HOME/.local/bin"
    return
  fi
  echo "$HOME/.catalyst/bin"
}

mode="install"
BIN_DIR_OVERRIDE=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) mode="uninstall"; shift ;;
    --bin-dir)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "error: --bin-dir requires a path argument" >&2
        usage >&2
        exit 2
      fi
      BIN_DIR_OVERRIDE="$2"
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

BIN_DIR="$(resolve_bin_dir)"

if [[ "$mode" = "uninstall" ]]; then
  if [[ -d "$BIN_DIR" ]]; then
    for entry in "${CLI_ENTRIES[@]}"; do
      dest_name="${entry##*:}"
      link="$BIN_DIR/$dest_name"
      if [[ -L "$link" || -e "$link" ]]; then
        rm -f "$link"
      fi
    done
    # rmdir quietly — fails if dir has other entries, which is fine
    rmdir "$BIN_DIR" 2>/dev/null || true
    echo "Removed catalyst CLI symlinks from $BIN_DIR"
  else
    echo "$BIN_DIR does not exist — nothing to uninstall"
  fi
  exit 0
fi

# install mode
SOURCE_DIR="$(resolve_source)"
if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "error: source directory not found: $SOURCE_DIR" >&2
  echo "hint: set CATALYST_CLI_SOURCE or CLAUDE_PLUGIN_ROOT" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

installed=0
missing=0
for entry in "${CLI_ENTRIES[@]}"; do
  src_name="${entry%%:*}"
  dest_name="${entry##*:}"
  src="$SOURCE_DIR/$src_name"
  link="$BIN_DIR/$dest_name"

  if [[ ! -f "$src" ]]; then
    echo "  skip: $src_name (not in source)" >&2
    missing=$((missing + 1))
    continue
  fi

  # Replace any existing link/file so re-point works
  rm -f "$link"
  ln -s "$src" "$link"
  installed=$((installed + 1))
done

echo "Installed $installed catalyst CLI symlink(s) in $BIN_DIR"
if [[ $missing -gt 0 ]]; then
  echo "  ($missing expected scripts were missing from $SOURCE_DIR)"
fi

# Stale-alias detection — warns (never fails) about user-defined aliases that
# point at a local catalyst clone. These shadow the marketplace install in
# interactive shells; users should remove them so there's a single source of
# truth.
detect_stale_aliases() {
  local rc_files=("$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.bash_profile")
  local pattern='^[[:space:]]*alias[[:space:]]+catalyst-[a-z]+=.*plugins/dev/scripts/'
  local found=0
  for rc in "${rc_files[@]}"; do
    [[ -f "$rc" ]] || continue
    if grep -qE "$pattern" "$rc" 2>/dev/null; then
      if [[ "$found" -eq 0 ]]; then
        echo "" >&2
        echo "  ⚠️  Stale catalyst-* aliases detected (shadow installed CLIs):" >&2
        found=1
      fi
      grep -nE "$pattern" "$rc" 2>/dev/null \
        | sed "s|^|      $(basename "$rc"):|" >&2
    fi
  done
  if [[ "$found" -eq 1 ]]; then
    cat <<'EOF' >&2

  Remove these aliases so the marketplace install becomes the single source of truth.

EOF
  fi
}

detect_stale_aliases

# PATH check — if BIN_DIR is not on PATH, print an actionable hint and exit
# non-zero so the user can't miss it. --force overrides the exit but still prints
# the hint so automation (e.g. a future post-install hook) can install the
# symlinks unconditionally and rely on the user fixing PATH separately.
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    cat <<EOF >&2

  ⚠️  $BIN_DIR is not on your PATH.

  Add it to your shell rc:
      # zsh
      echo 'export PATH="$BIN_DIR:\$PATH"' >> ~/.zshrc
      # bash
      echo 'export PATH="$BIN_DIR:\$PATH"' >> ~/.bashrc
  Then open a new terminal (or run: source ~/.zshrc).

EOF
    if [[ "$FORCE" -eq 1 ]]; then
      echo "  (continuing because --force was given)" >&2
    else
      echo "  Re-run with --force to install symlinks anyway." >&2
      exit 3
    fi
    ;;
esac
