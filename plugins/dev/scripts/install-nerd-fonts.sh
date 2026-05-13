#!/usr/bin/env bash
# CTL-353: One-shot installer for a Nerd Font + fontconfig on macOS/Linux.
#
# After running, restart your terminal and (if applicable) set the terminal's
# font to the installed Nerd Font (e.g. "Hack Nerd Font Mono") so that PUA
# glyphs render. The HUD's runtime detection probes fc-list and the system
# font directories, so any installed Nerd Font works — Hack is just the
# default this script installs.

set -euo pipefail

CASK="${CATALYST_NERD_FONT_CASK:-font-hack-nerd-font}"

echo "==> catalyst nerd-font installer"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: brew is required on macOS. Install from https://brew.sh and rerun." >&2
    exit 1
  fi
  # fontconfig provides `fc-list`, which is the HUD's primary detection probe.
  if ! command -v fc-list >/dev/null 2>&1; then
    echo "==> installing fontconfig (provides fc-list)"
    brew install fontconfig
  fi
  if brew list --cask "$CASK" >/dev/null 2>&1; then
    echo "==> $CASK already installed"
  else
    echo "==> installing cask $CASK"
    brew install --cask "$CASK"
  fi
elif [[ "$(uname -s)" == "Linux" ]]; then
  # Most distros ship fc-list in fontconfig; user installs Nerd Fonts manually.
  if ! command -v fc-list >/dev/null 2>&1; then
    echo "ERROR: install fontconfig (provides fc-list), then rerun. " >&2
    echo "  apt:    sudo apt install fontconfig" >&2
    echo "  dnf:    sudo dnf install fontconfig" >&2
    echo "  pacman: sudo pacman -S fontconfig" >&2
    exit 1
  fi
  if fc-list 2>/dev/null | grep -qi "nerd font"; then
    echo "==> a Nerd Font is already installed (fc-list)"
  else
    cat <<'EOF'
==> No Nerd Font detected. Linux installation isn't automated by this script.

   Recommended: download a release ZIP from
     https://github.com/ryanoasis/nerd-fonts/releases/latest
   Then:
     mkdir -p ~/.local/share/fonts
     unzip Hack.zip -d ~/.local/share/fonts
     fc-cache -fv
EOF
    exit 1
  fi
else
  echo "ERROR: unsupported platform $(uname -s). Install a Nerd Font manually." >&2
  exit 1
fi

echo ""
echo "==> verifying detection"
if command -v fc-list >/dev/null 2>&1; then
  if fc-list 2>/dev/null | grep -qi "nerd font"; then
    echo "    fc-list confirms a Nerd Font is installed."
  else
    echo "    WARN: fc-list didn't see a Nerd Font yet — your shell may need to be restarted."
  fi
fi

echo ""
echo "Next steps:"
echo "  1. Set your terminal's font to the installed Nerd Font (e.g. 'Hack Nerd Font Mono')."
echo "  2. Restart your terminal (or open a new tab)."
echo "  3. Run 'catalyst-hud' — the startup banner will say 'nerdfont detected'."
echo ""
echo "To force-enable or disable detection at runtime:"
echo "  CATALYST_NERD_FONT=1 catalyst-hud   # force on"
echo "  CATALYST_NERD_FONT=0 catalyst-hud   # force off (use ellipsis fallback)"
