#!/usr/bin/env bash
# install-comms-drain.sh — COORD-108/118/121. Install the LaunchAgent that pulls remote owners'
# queued channel turns onto the channel host.
#
# ⛔ WHY THIS EXISTS. The transport (post-turn.sh / drain-remote-turns.sh) is only half a delivery
# path: a mini can queue a turn, but nothing on the laptop was pulling. A relaunched remote owner
# would post correctly and its turns would sit in the outbox unread — the transport would LOOK
# installed and deliver nothing, which is the class this whole night was about.
#
# Runs on the CHANNEL HOST (the laptop), not on the owners. The laptop does not accept ssh
# (measured 2026-08-18: refused from both minis), so pull is the only direction available — and it
# is the one that survives the laptop sleeping, since turns simply queue until it wakes.
#
#   install-comms-drain.sh [--channel <name>] [--hosts a,b]
#   install-comms-drain.sh --uninstall
#   install-comms-drain.sh --print-only

set -euo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

LABEL="ai.coalesce.catalyst-comms-drain"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="${SCRIPT_DIR}/agent/${LABEL}.plist"
DRAIN="${SCRIPT_DIR}/drain-remote-turns.sh"
CHANNEL="${CATALYST_USAGE_CHANNEL:-ctl-ctc-tenant-model-onboarding}"
HOSTS="mini,mini-2"
MODE="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
  --channel) CHANNEL="${2-}"; shift 2 ;;
  --hosts) HOSTS="${2-}"; shift 2 ;;
  --uninstall) MODE="uninstall"; shift ;;
  --print-only) MODE="print"; shift ;;
  -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "install-comms-drain: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [[ "$MODE" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-comms-drain: uninstalled ${LABEL}"
  exit 0
fi

[[ -n "$CHANNEL" ]] || { echo "install-comms-drain: --channel must not be empty" >&2; exit 2; }
[[ -n "$HOSTS" ]] || { echo "install-comms-drain: --hosts must not be empty" >&2; exit 2; }
[[ -f "$TEMPLATE" ]] || { echo "install-comms-drain: template missing at $TEMPLATE" >&2; exit 1; }
[[ -f "$DRAIN" ]] || { echo "install-comms-drain: drain script missing at $DRAIN" >&2; exit 1; }

RENDERED="$(sed -e "s|__HOME__|${HOME}|g" -e "s|__SCRIPT__|${DRAIN}|g" \
  -e "s|__CHANNEL__|${CHANNEL}|g" -e "s|__HOSTS__|${HOSTS}|g" "$TEMPLATE")"

# ⛔ An unsubstituted token yields a plist launchd accepts and an agent that drains nothing —
# installed-looking and inert.
if grep -q "__[A-Z_]*__" <<<"$RENDERED"; then
  echo "install-comms-drain: REFUSING — unsubstituted token(s) remain:" >&2
  grep -o "__[A-Z_]*__" <<<"$RENDERED" | sort -u >&2
  exit 1
fi

if [[ "$MODE" == "print" ]]; then printf '%s\n' "$RENDERED"; exit 0; fi

mkdir -p "$(dirname "$DEST")"
printf '%s\n' "$RENDERED" >"$DEST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$DEST" >/dev/null || { echo "install-comms-drain: rendered plist is malformed" >&2; exit 1; }
fi

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-comms-drain: installed ${LABEL} — channel=${CHANNEL} hosts=${HOSTS}, every 120s"
