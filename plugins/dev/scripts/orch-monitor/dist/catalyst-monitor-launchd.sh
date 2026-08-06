#!/usr/bin/env bash
# Wrapper script for launchd (macOS). A thin exec into catalyst-monitor.sh, which
# projects the cluster-synced secrets itself — no secret value ever appears in the plist.
#
# Usage: copy this file to an absolute path on disk, edit the SCRIPT_DIR line
# if needed, then reference it from your LaunchAgent plist.
#
# See: website/src/content/docs/observability/webhooks.md — "Persistent setup"

# CTL-1612: the secret projection was REMOVED from this wrapper deliberately.
# catalyst-monitor.sh cmd_start now performs it via lib/catalyst-secret-env.sh, honoring
# CATALYST_WEBHOOK_SECRET_FILE / CATALYST_CONFIG_DIR / CATALYST_LAYER2_CONFIG_FILE. This
# wrapper always preloaded the HOME/XDG default and ignored those overrides, so a
# LaunchAgent pointing at a custom path still got the default value — and the wrapper's
# `$(cat ...)` also exported an empty string for an empty file, which makes
# webhook-config treat the GitHub route as unconfigured and silently disables it.
# One projection, one chain, both launch paths.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/../catalyst-monitor.sh" start
