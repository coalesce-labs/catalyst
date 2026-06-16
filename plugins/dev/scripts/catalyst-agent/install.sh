#!/usr/bin/env bash
# install.sh — CTL-812. Idempotently install the catalyst-agent launchd
# LaunchAgent on macOS: substitute the template tokens, copy the plist into
# ~/Library/LaunchAgents/, then (re)load it via launchctl.
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

sed \
  -e "s|REPLACE_WITH_NODE|${NODE_BIN}|g" \
  -e "s|REPLACE_WITH_AGENT|${AGENT}|g" \
  -e "s|REPLACE_WITH_HOME|${HOME}|g" \
  -e "s|REPLACE_WITH_PATH|${INSTALL_PATH}|g" \
  -e "s|REPLACE_WITH_METRICS_ENDPOINT|${METRICS_ENDPOINT}|g" \
  "${TEMPLATE}" > "${TMP}"
mv "${TMP}" "${DEST}"
echo "install.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
DOMAIN="gui/$(id -u)"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${DEST}"
echo "install.sh: loaded ${LABEL} into ${DOMAIN}"
echo "install.sh: verify with 'launchctl list | grep ${LABEL}'"
