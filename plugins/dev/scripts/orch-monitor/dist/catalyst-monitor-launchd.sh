#!/usr/bin/env bash
# Wrapper script for launchd (macOS). Reads CATALYST_WEBHOOK_SECRET from the
# secret file at startup so the value never needs to appear in the plist.
#
# Usage: copy this file to an absolute path on disk, edit the SCRIPT_DIR line
# if needed, then reference it from your LaunchAgent plist.
#
# See: website/src/content/docs/observability/webhooks.md — "Persistent setup"

# CTL-1612: only export a NON-EMPTY value. The previous `-f`-guarded `$(cat)` exported
# CATALYST_WEBHOOK_SECRET="" for an empty or whitespace-only file, and an empty secret
# makes webhook-config treat the GitHub route as unconfigured — silently disabling
# inbound webhook verification rather than falling back. catalyst-monitor.sh cmd_start
# now performs the same projection, so both launch paths agree.
SECRET_FILE="${HOME}/.config/catalyst/webhook-secret"
if [[ -r "$SECRET_FILE" ]]; then
  _wh_val="$(tr -d '[:space:]' <"$SECRET_FILE" 2>/dev/null)"
  [[ -n "$_wh_val" ]] && export CATALYST_WEBHOOK_SECRET="$_wh_val"
  unset _wh_val
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/../catalyst-monitor.sh" start
