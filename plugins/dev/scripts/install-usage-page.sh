#!/usr/bin/env bash
# install-usage-page.sh — CTL-1908. Idempotently install the account-usage pager LaunchAgent.
#
# ⛔ CODIFIED, NOT TYPED. The incident this closes is a fix that existed on one host and nowhere
# else for nine hours. A pager installed by hand on the laptop would be the same defect wearing a
# different hat, so it ships as a script the fleet can run on every node.
#
#   install-usage-page.sh              install / reinstall
#   install-usage-page.sh --uninstall  unload and remove
#   install-usage-page.sh --print-only emit the substituted plist to stdout

set -euo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

LABEL="ai.coalesce.catalyst-usage-page"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="${SCRIPT_DIR}/usage-page/${LABEL}.plist"
PAGER="${SCRIPT_DIR}/catalyst-account-usage-page.sh"

MODE="install"
case "${1:-}" in
--uninstall) MODE="uninstall" ;;
--print-only) MODE="print" ;;
-h | --help)
  sed -n '2,12p' "$0"
  exit 0
  ;;
"") ;;
*)
  echo "install-usage-page: unknown argument '$1'" >&2
  exit 2
  ;;
esac

if [[ "$MODE" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-usage-page: uninstalled ${LABEL}"
  exit 0
fi

[[ -f "$TEMPLATE" ]] || {
  echo "install-usage-page: template missing at $TEMPLATE" >&2
  exit 1
}
[[ -f "$PAGER" ]] || {
  echo "install-usage-page: pager missing at $PAGER" >&2
  exit 1
}

RENDERED="$(sed -e "s|__HOME__|${HOME}|g" -e "s|__SCRIPT__|${PAGER}|g" "$TEMPLATE")"

# ⛔ A template token left unsubstituted produces a plist launchd accepts and an agent that never
# does anything useful — installed-looking and inert.
if grep -q "__[A-Z_]*__" <<<"$RENDERED"; then
  echo "install-usage-page: REFUSING — unsubstituted token(s) remain in the rendered plist:" >&2
  grep -o "__[A-Z_]*__" <<<"$RENDERED" | sort -u >&2
  exit 1
fi

if [[ "$MODE" == "print" ]]; then
  printf '%s\n' "$RENDERED"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
printf '%s\n' "$RENDERED" >"$DEST"
plutil -lint "$DEST" >/dev/null || {
  echo "install-usage-page: rendered plist is malformed" >&2
  exit 1
}

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-usage-page: installed and loaded ${LABEL} (every 600s, threshold 80%)"
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E "state|program" | head -3 || true
