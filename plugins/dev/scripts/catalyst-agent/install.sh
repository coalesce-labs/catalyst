#!/usr/bin/env bash
# install.sh — CTL-812. Idempotently install the catalyst-agent launchd
# LaunchAgent on macOS: substitute the template tokens, copy the plist into
# ~/Library/LaunchAgents/, then (re)load it via launchctl.
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain — a scratch HOME does not
# sandbox it. Refuse rather than re-bind the REAL label to a temporary path.
[[ -f "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh" ]] || {
  echo "catalyst-agent/install.sh: missing ../lib/launchd-domain-guard.sh" >&2; exit 1; }
# shellcheck source=../lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/../lib/launchd-domain-guard.sh"
launchd_agent_guard() {
  launchd_guard_ok "the catalyst-agent LaunchAgent" && return 0
  launchd_guard_message "the catalyst-agent LaunchAgent" >&2
  echo "catalyst-agent/install.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
}
TEMPLATE="${SCRIPT_DIR}/com.catalyst.agent.plist"
AGENT="${SCRIPT_DIR}/catalyst-agent.mjs"
LABEL="com.catalyst.agent"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "install.sh: node not found on PATH — install node>=18 first" >&2
  exit 1
fi
if [ ! -f "${TEMPLATE}" ]; then
  echo "install.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

# Substitute the template tokens into the destination plist. Using a temp file
# then mv keeps the install atomic.
TMP="$(mktemp)"
# Capture the current PATH so the launchd agent can find `claude`, `node`, etc.
# that live outside /usr/bin:/bin:/usr/sbin:/sbin (the launchd default).
INSTALL_PATH="${PATH}"

# CTL-1227: resolve the OTLP METRICS endpoint (HTTP /v1/metrics). Priority:
#   1. explicit CATALYST_AGENT_METRICS_ENDPOINT env
#   2. derived from the stack's OTLP forwarder endpoint in Layer-2 config
#      (catalyst.observability.forwarders.otlp.endpoint, e.g. http://host:4317
#      gRPC) — re-pointed to the collector's HTTP receiver on :4318.
# Empty ⇒ metric emission stays off (graceful; events still flow via the forwarder).
METRICS_ENDPOINT="${CATALYST_AGENT_METRICS_ENDPOINT:-}"
if [ -z "${METRICS_ENDPOINT}" ] && command -v jq >/dev/null 2>&1; then
  for cfg in "${HOME}/.config/catalyst/"config-*.json "${HOME}/.config/catalyst/config.json"; do
    [ -f "${cfg}" ] || continue
    OTLP_EP="$(jq -r '.catalyst.observability.forwarders.otlp.endpoint // empty' "${cfg}" 2>/dev/null)"
    if [ -n "${OTLP_EP}" ]; then
      host="$(printf '%s' "${OTLP_EP}" | sed -E 's|^[a-z]+://||; s|:[0-9]+$||; s|/.*$||')"
      [ -n "${host}" ] && METRICS_ENDPOINT="http://${host}:4318"
      break
    fi
  done
fi
[ -n "${METRICS_ENDPOINT}" ] && echo "install.sh: metrics endpoint → ${METRICS_ENDPOINT}" \
  || echo "install.sh: no metrics endpoint resolved — metric emission disabled"

# CTL-1518: persist the install-time CATALYST_DIR into the plist so the agent
# resolves its heartbeat breadcrumb under the same dir the health-responder
# (installed with the same override) probes. Defaults to ${HOME}/catalyst, which
# is what catalystDir() already resolves when unset — so default nodes are unchanged.
CATALYST_DIR_VALUE="${CATALYST_DIR:-${HOME}/catalyst}"
echo "install.sh: CATALYST_DIR → ${CATALYST_DIR_VALUE}"

# CTL-1518: each substituted value lands inside a plist <string>…</string>, so it
# must be BOTH XML-escaped (so `&`/`<`/`>` don't produce invalid XML — e.g.
# "/Volumes/Catalyst & Data") AND sed-replacement-escaped (so `&`/`|`/`\` don't
# expand into the sed match). XML-escape FIRST, then sed-escape the result (Codex P2).
_xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
_sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
_esc() { _sed_escape "$(_xml_escape "$1")"; }
NODE_BIN_E="$(_esc "${NODE_BIN}")"
AGENT_E="$(_esc "${AGENT}")"
HOME_E="$(_esc "${HOME}")"
INSTALL_PATH_E="$(_esc "${INSTALL_PATH}")"
METRICS_ENDPOINT_E="$(_esc "${METRICS_ENDPOINT}")"
CATALYST_DIR_VALUE_E="$(_esc "${CATALYST_DIR_VALUE}")"

sed \
  -e "s|REPLACE_WITH_NODE|${NODE_BIN_E}|g" \
  -e "s|REPLACE_WITH_AGENT|${AGENT_E}|g" \
  -e "s|REPLACE_WITH_HOME|${HOME_E}|g" \
  -e "s|REPLACE_WITH_PATH|${INSTALL_PATH_E}|g" \
  -e "s|REPLACE_WITH_METRICS_ENDPOINT|${METRICS_ENDPOINT_E}|g" \
  -e "s|REPLACE_WITH_CATALYST_DIR|${CATALYST_DIR_VALUE_E}|g" \
  "${TEMPLATE}" > "${TMP}"
mv "${TMP}" "${DEST}"
echo "install.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
DOMAIN="gui/$(id -u)"
launchd_agent_guard
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${DEST}"
echo "install.sh: loaded ${LABEL} into ${DOMAIN}"
echo "install.sh: verify with 'launchctl list | grep ${LABEL}'"
