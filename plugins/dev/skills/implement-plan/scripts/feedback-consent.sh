#!/usr/bin/env bash
# feedback-consent - Manage the user's opt-in for automatic ticket filing by
# catalyst skills. Reads and writes the `catalyst.feedback` block of
# `.catalyst/config.json`. The consent model is deliberately asymmetric: "yes"
# persists, "no" never persists — skills re-prompt on the next run. CTL-183.
#
# Usage:
#   feedback-consent.sh check [--config <path>]
#     → prints "granted" if catalyst.feedback.autoFile is true, else "unset"
#
#   feedback-consent.sh grant [--config <path>]
#     → writes catalyst.feedback.autoFile = true (creates the block if needed)
#     → prints "granted"
#
#   feedback-consent.sh status [--config <path>] [--json]
#     → prints the full feedback block (human-readable by default, JSON with --json)
#
# Exit codes:
#   0  success
#   1  usage error or missing jq

set -uo pipefail

CONFIG=""
JSON_OUT=0
SUBCOMMAND=""

usage() {
  sed -n '2,21p' "$0" >&2
  exit "${1:-1}"
}

[ $# -lt 1 ] && usage
SUBCOMMAND="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --json)   JSON_OUT=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

resolve_config() {
  if [ -n "$CONFIG" ]; then
    echo "$CONFIG"; return 0
  fi
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/.catalyst/config.json" ]; then
      echo "${dir}/.catalyst/config.json"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  # No config found; default to .catalyst/config.json relative to CWD so
  # `grant` can create it.
  echo "$(pwd)/.catalyst/config.json"
}

CONFIG_PATH="$(resolve_config)"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for feedback-consent operations" >&2
  exit 1
fi

read_auto_file() {
  if [ ! -f "$CONFIG_PATH" ]; then
    echo ""
    return 0
  fi
  jq -r '.catalyst.feedback.autoFile // empty' "$CONFIG_PATH" 2>/dev/null
}

case "$SUBCOMMAND" in
  check)
    VAL="$(read_auto_file)"
    if [ "$VAL" = "true" ]; then
      echo "granted"
    else
      echo "unset"
    fi
    ;;

  grant)
    mkdir -p "$(dirname "$CONFIG_PATH")"
    if [ ! -f "$CONFIG_PATH" ]; then
      echo '{}' > "$CONFIG_PATH"
    fi
    TMP="${CONFIG_PATH}.tmp.$$"
    if jq '.catalyst = (.catalyst // {})
           | .catalyst.feedback = (.catalyst.feedback // {})
           | .catalyst.feedback.autoFile = true
           | .catalyst.feedback.githubRepo = (.catalyst.feedback.githubRepo // "coalesce-labs/catalyst")
           | .catalyst.feedback.labels = (.catalyst.feedback.labels // ["auto-submitted"])' \
         "$CONFIG_PATH" > "$TMP"; then
      mv "$TMP" "$CONFIG_PATH"
      echo "granted"
    else
      rm -f "$TMP"
      echo "ERROR: failed to update config" >&2
      exit 1
    fi
    ;;

  status)
    if [ ! -f "$CONFIG_PATH" ]; then
      if [ "$JSON_OUT" -eq 1 ]; then
        echo '{}'
      else
        echo "config not found: $CONFIG_PATH"
        echo "autoFile: unset"
      fi
      exit 0
    fi
    BLOCK=$(jq -c '.catalyst.feedback // {}' "$CONFIG_PATH" 2>/dev/null)
    if [ "$JSON_OUT" -eq 1 ]; then
      echo "$BLOCK"
    else
      echo "config: $CONFIG_PATH"
      AUTO=$(echo "$BLOCK" | jq -r '.autoFile // "unset"')
      REPO=$(echo "$BLOCK" | jq -r '.githubRepo // "coalesce-labs/catalyst (default)"')
      LABELS=$(echo "$BLOCK" | jq -r '.labels // ["auto-submitted"] | join(",")')
      echo "autoFile:   $AUTO"
      echo "githubRepo: $REPO"
      echo "labels:     $LABELS"
    fi
    ;;

  *)
    echo "unknown subcommand: $SUBCOMMAND" >&2
    usage
    ;;
esac
