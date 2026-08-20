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
#
# CTL-2000 fleet-wide singleton units (one per fleet, NOT per role):
#   bash install.sh --quiet-fleet          # concierge alarm for quiet roles
#   bash install.sh --holding-sentinel      # out-of-fleet holding-reply sentinel
#   bash install.sh --dead-man              # out-of-fleet dead-man alarm
#   bash install.sh --quiet-fleet --uninstall
#   ... any of the above with --dry-run to print the plist without loading it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROLE="" SCOPE="" SKILL="catalyst-dev:steward" CWD="" BRIEF="" UNINSTALL=0 DRY_RUN=0 FLEET_UNIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --role) ROLE="${2:?--role needs a name}"; shift ;;
  --scope) SCOPE="${2:?--scope needs a value}"; shift ;;
  --skill) SKILL="${2:?--skill needs a value}"; shift ;;
  --cwd) CWD="${2:?--cwd needs a dir}"; shift ;;
  --brief) BRIEF="${2:?--brief needs a file}"; shift ;;
  --uninstall) UNINSTALL=1 ;;
  --dry-run) DRY_RUN=1 ;;
  --quiet-fleet) FLEET_UNIT="quiet-fleet" ;;
  --holding-sentinel) FLEET_UNIT="holding-sentinel" ;;
  --dead-man) FLEET_UNIT="dead-man" ;;
  -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "role-supervisor/install.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
  shift
done

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain — a scratch HOME does
# NOT sandbox it. Refuse rather than re-bind a real label to a temporary path.
# (A --dry-run never touches launchd, so it skips the guard.)
[[ -f "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh" ]] || {
  echo "role-supervisor/install.sh: missing ../lib/launchd-domain-guard.sh" >&2; exit 1; }
# shellcheck source=../lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh"
if [[ $DRY_RUN -eq 0 ]] && ! launchd_guard_ok "the role-supervisor LaunchAgent"; then
  launchd_guard_message "the role-supervisor LaunchAgent" >&2
  echo "role-supervisor/install.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
fi

CATALYST_DIR_VAL="${CATALYST_DIR:-${HOME}/catalyst}"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "role-supervisor/install.sh: node not found on PATH" >&2; exit 1; }
CWD_DEFAULT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
PATH_VAL="${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── CTL-2000: fleet-wide singleton units ────────────────────────────────────
# One instrument for the whole fleet (quiet-fleet alarm, holding-reply sentinel,
# dead-man alarm), NOT one per role. Each renders its own plist template and
# loads under a fixed label. The dead-man + holding-sentinel are deliberately
# SEPARATE launchd units from the per-role supervisors: a 529 wave that takes
# the fleet down must not take its backstops with it.
if [[ -n "$FLEET_UNIT" ]]; then
  UNIT_LABEL="com.catalyst.${FLEET_UNIT}"
  UNIT_DEST="${HOME}/Library/LaunchAgents/${UNIT_LABEL}.plist"
  UNIT_PLIST="${SCRIPT_DIR}/com.catalyst.${FLEET_UNIT}.plist"
  UNIT_LOG="${CATALYST_DIR_VAL}/roles/.${FLEET_UNIT}.log"
  UNIT_CWD="${CWD:-$CWD_DEFAULT}"

  if [[ $UNINSTALL -eq 1 ]]; then
    # --dry-run must only PRINT — it must not bootout or remove the plist (the
    # advertised guarantee), and dry-run also skips the launchd-domain guard.
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "role-supervisor: [dry-run] would uninstall ${UNIT_LABEL}"
      echo "  would: launchctl bootout gui/$(id -u)/${UNIT_LABEL}"
      echo "  would: rm -f ${UNIT_DEST}"
      exit 0
    fi
    launchctl bootout "gui/$(id -u)/${UNIT_LABEL}" 2>/dev/null || true
    rm -f "$UNIT_DEST"
    echo "role-supervisor: uninstalled ${UNIT_LABEL}"
    exit 0
  fi

  [[ -f "$UNIT_PLIST" ]] || { echo "role-supervisor/install.sh: missing plist template ${UNIT_PLIST}" >&2; exit 1; }

  UNIT_TMP="$(mktemp)"
  sed \
    -e "s|REPLACE_WITH_LABEL|${UNIT_LABEL}|g" \
    -e "s|REPLACE_WITH_NODE|${NODE_BIN}|g" \
    -e "s|REPLACE_WITH_CLI|${SCRIPT_DIR}/cli.mjs|g" \
    -e "s|REPLACE_WITH_PATH|${PATH_VAL}|g" \
    -e "s|REPLACE_WITH_CATALYST_DIR|${CATALYST_DIR_VAL}|g" \
    -e "s|REPLACE_WITH_CWD|${UNIT_CWD}|g" \
    -e "s|REPLACE_WITH_LOG|${UNIT_LOG}|g" \
    "$UNIT_PLIST" > "$UNIT_TMP"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "role-supervisor: [dry-run] would install ${UNIT_LABEL} → ${UNIT_DEST}"
    cat "$UNIT_TMP"
    rm -f "$UNIT_TMP"
    exit 0
  fi

  mkdir -p "${HOME}/Library/LaunchAgents" "${CATALYST_DIR_VAL}/roles"
  mv "$UNIT_TMP" "$UNIT_DEST"
  launchctl bootout "gui/$(id -u)/${UNIT_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$UNIT_DEST"
  echo "role-supervisor: installed ${UNIT_LABEL}"
  echo "  plist: ${UNIT_DEST}"
  echo "  log:   ${UNIT_LOG}"
  exit 0
fi

[[ -n "$ROLE" ]] || { echo "role-supervisor/install.sh: --role is required (or a fleet-unit flag: --quiet-fleet|--holding-sentinel|--dead-man)" >&2; exit 2; }

LABEL="com.catalyst.role.${ROLE}"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ $UNINSTALL -eq 1 ]]; then
  # --dry-run must only PRINT — same non-destructive guarantee as the fleet-unit
  # path above (and dry-run skips the launchd-domain guard).
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "role-supervisor: [dry-run] would uninstall ${LABEL}"
    echo "  would: launchctl bootout gui/$(id -u)/${LABEL}"
    echo "  would: rm -f ${DEST}"
    exit 0
  fi
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

# CTL-2095: dry-run for the regular role install path. Print what would happen
# and exit 0 without touching launchd, the manifest, or the LaunchAgents dir.
if [[ $DRY_RUN -eq 1 ]]; then
  _DRY_PATH_VAL="${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [[ -f "${ROLE_DIR}/manifest.json" ]]; then
    echo "role-supervisor: [dry-run] would keep existing ${ROLE_DIR}/manifest.json"
  else
    echo "role-supervisor: [dry-run] would write ${ROLE_DIR}/manifest.json"
    printf '  role=%s scope="%s" skill=%s cwd=%s\n' "${ROLE}" "${SCOPE:-}" "${SKILL}" "${CWD}"
  fi
  _DRY_TMP="$(mktemp)"
  sed \
    -e "s|REPLACE_WITH_LABEL|${LABEL}|g" \
    -e "s|REPLACE_WITH_NODE|${NODE_BIN}|g" \
    -e "s|REPLACE_WITH_CLI|${SCRIPT_DIR}/cli.mjs|g" \
    -e "s|REPLACE_WITH_ROLE|${ROLE}|g" \
    -e "s|REPLACE_WITH_PATH|${_DRY_PATH_VAL}|g" \
    -e "s|REPLACE_WITH_CATALYST_DIR|${CATALYST_DIR_VAL}|g" \
    -e "s|REPLACE_WITH_CWD|${CWD}|g" \
    -e "s|REPLACE_WITH_LOG|${LOG}|g" \
    "${SCRIPT_DIR}/com.catalyst.role.plist" > "$_DRY_TMP"
  echo "role-supervisor: [dry-run] would install ${LABEL} → ${DEST}"
  cat "$_DRY_TMP"
  rm -f "$_DRY_TMP"
  exit 0
fi

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
