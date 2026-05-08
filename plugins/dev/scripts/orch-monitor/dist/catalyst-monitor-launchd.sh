#!/usr/bin/env bash
# Wrapper script for launchd (macOS). Reads CATALYST_WEBHOOK_SECRET from the
# secret file at startup so the value never needs to appear in the plist.
#
# Usage: copy this file to an absolute path on disk, edit the SCRIPT_DIR line
# if needed, then reference it from your LaunchAgent plist.
#
# See: website/src/content/docs/observability/webhooks.md — "Persistent setup"

SECRET_FILE="${HOME}/.config/catalyst/webhook-secret"
if [[ -f "$SECRET_FILE" ]]; then
  export CATALYST_WEBHOOK_SECRET
  CATALYST_WEBHOOK_SECRET="$(cat "$SECRET_FILE")"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/../catalyst-monitor.sh" start
