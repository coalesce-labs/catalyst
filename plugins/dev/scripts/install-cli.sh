#!/usr/bin/env bash
# install-cli.sh — install ~/.catalyst/bin/ symlinks for every catalyst-* CLI.
#
# Usage:
#   install-cli.sh              # install/update symlinks (idempotent)
#   install-cli.sh --uninstall  # remove catalyst-* symlinks, rmdir if empty
#   install-cli.sh --help
#
# Env overrides (primarily for tests):
#   CATALYST_CLI_SOURCE    default: auto-detected (CLAUDE_PLUGIN_ROOT/scripts or this script's dir)
#   CATALYST_CLI_BIN_DIR   default: $HOME/.catalyst/bin

set -uo pipefail

# Explicit allowlist. Source name → installed command name (.sh suffix stripped).
# Keep this in sync with check-setup.sh's "Catalyst CLI Install" section.
CLI_ENTRIES=(
  "catalyst-comms:catalyst-comms"
  "catalyst-session.sh:catalyst-session"
  "catalyst-state.sh:catalyst-state"
  "catalyst-db.sh:catalyst-db"
  "catalyst-monitor.sh:catalyst-monitor"
  "catalyst-thoughts.sh:catalyst-thoughts"
  "catalyst-claude.sh:catalyst-claude"
)

usage() {
  cat <<'EOF'
Usage: install-cli.sh [--uninstall|--help]

Installs symlinks at ~/.catalyst/bin/ for every catalyst-* CLI so they can
be invoked by name from any shell.

Options:
  --uninstall   Remove previously-installed catalyst-* symlinks
  --help, -h    Show this help

Environment overrides (for testing):
  CATALYST_CLI_SOURCE    Source directory containing catalyst-* scripts
  CATALYST_CLI_BIN_DIR   Target directory for symlinks (default: $HOME/.catalyst/bin)
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

mode="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) mode="uninstall"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

BIN_DIR="${CATALYST_CLI_BIN_DIR:-$HOME/.catalyst/bin}"

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

# PATH hint — only if BIN_DIR is not already on PATH
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    cat <<EOF

  $BIN_DIR is not on your PATH. Add it to your shell rc:
      # zsh
      echo 'export PATH="\$HOME/.catalyst/bin:\$PATH"' >> ~/.zshrc
      # bash
      echo 'export PATH="\$HOME/.catalyst/bin:\$PATH"' >> ~/.bashrc
  Then open a new terminal (or run: source ~/.zshrc).
EOF
    ;;
esac
