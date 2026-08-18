#!/usr/bin/env bash
# install.sh — CTL-1994. Idempotently install the launchd LaunchAgent for ONE
# supervised coordination role.
#
# Re-running is safe: an already-loaded label is booted out before being
# re-bootstrapped, so the latest plist always wins.
#
#   bash install.sh --role steward-p13 --scope "P13 · Coordination SOP" \
#                   --skill catalyst-dev:steward --cwd ~/code-repos/github/coalesce-labs/catalyst
#   bash install.sh --role steward-p13 --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROLE="" SCOPE="" SKILL="catalyst-dev:steward" CWD="" BRIEF="" UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
  --role) ROLE="${2:?--role needs a name}"; shift ;;
  --scope) SCOPE="${2:?--scope needs a value}"; shift ;;
  --skill) SKILL="${2:?--skill needs a value}"; shift ;;
  --cwd) CWD="${2:?--cwd needs a dir}"; shift ;;
  --brief) BRIEF="${2:?--brief needs a file}"; shift ;;
  --uninstall) UNINSTALL=1 ;;
  -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
  *) echo "role-supervisor/install.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$ROLE" ]] || { echo "role-supervisor/install.sh: --role is required" >&2; exit 2; }

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain — a scratch HOME does
# NOT sandbox it. Refuse rather than re-bind a real label to a temporary path.
[[ -f "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh" ]] || {
  echo "role-supervisor/install.sh: missing ../lib/launchd-domain-guard.sh" >&2; exit 1; }
# shellcheck source=../lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh"
if ! launchd_guard_ok "the role-supervisor LaunchAgent"; then
  launchd_guard_message "the role-supervisor LaunchAgent" >&2
  echo "role-supervisor/install.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
fi

LABEL="com.catalyst.role.${ROLE}"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ $UNINSTALL -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "role-supervisor: uninstalled ${LABEL}"
  exit 0
fi

CATALYST_DIR_VAL="${CATALYST_DIR:-${HOME}/catalyst}"
ROLE_DIR="${CATALYST_DIR_VAL}/roles/${ROLE}"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "role-supervisor/install.sh: node not found on PATH" >&2; exit 1; }
CWD="${CWD:-$(cd "${SCRIPT_DIR}/../../../.." && pwd)}"
LOG="${ROLE_DIR}/supervisor.log"

mkdir -p "$ROLE_DIR"

# The manifest is what the role IS. Written here so that installing a role and
# describing a role are one step — a plist pointing at a role with no manifest
# would KeepAlive-loop on a startup error.
if [[ ! -f "${ROLE_DIR}/manifest.json" ]]; then
  cat > "${ROLE_DIR}/manifest.json" <<JSON
{
  "role": "${ROLE}",
  "scope": "${SCOPE}",
  "skill": "${SKILL}",
  "cwd": "${CWD}",
  "brief_path": "${BRIEF}",
  "handoff_path": null,
  "status_doc_updated_at": null,
  "scope_active": true,
  "activity": {}
}
JSON
  echo "role-supervisor: wrote ${ROLE_DIR}/manifest.json"
else
  echo "role-supervisor: kept existing ${ROLE_DIR}/manifest.json"
fi

PATH_VAL="${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

TMP="$(mktemp)"
sed \
  -e "s|REPLACE_WITH_LABEL|${LABEL}|g" \
  -e "s|REPLACE_WITH_NODE|${NODE_BIN}|g" \
  -e "s|REPLACE_WITH_CLI|${SCRIPT_DIR}/cli.mjs|g" \
  -e "s|REPLACE_WITH_ROLE|${ROLE}|g" \
  -e "s|REPLACE_WITH_PATH|${PATH_VAL}|g" \
  -e "s|REPLACE_WITH_CATALYST_DIR|${CATALYST_DIR_VAL}|g" \
  -e "s|REPLACE_WITH_CWD|${CWD}|g" \
  -e "s|REPLACE_WITH_LOG|${LOG}|g" \
  "${SCRIPT_DIR}/com.catalyst.role.plist" > "$TMP"

mkdir -p "${HOME}/Library/LaunchAgents"
mv "$TMP" "$DEST"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "role-supervisor: installed ${LABEL}"
echo "  plist:    ${DEST}"
echo "  manifest: ${ROLE_DIR}/manifest.json"
echo "  log:      ${LOG}"
echo "  verify:   launchctl print gui/$(id -u)/${LABEL} | grep -E 'state|path'"
echo "            node ${SCRIPT_DIR}/cli.mjs doctor"
