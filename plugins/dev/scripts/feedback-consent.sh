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

# CTL-1214: the merged-Layer-2 leaf. catalyst.feedback.* had NO Layer-2 reader,
# so once the committed config is slimmed a granted consent reads back as
# "unset" — silently, because an absent key and a withheld consent are the same
# empty string here.
_FC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -r "${_FC_SCRIPT_DIR}/lib/catalyst-layer2-read.sh" ]; then
  # shellcheck disable=SC1090
  . "${_FC_SCRIPT_DIR}/lib/catalyst-layer2-read.sh"
fi

read_auto_file() {
  _fc_val=""
  if [ -f "$CONFIG_PATH" ]; then
    _fc_val="$(jq -r '.catalyst.feedback.autoFile // empty' "$CONFIG_PATH" 2>/dev/null)"
  fi
  # Layer-1 wins when present; Layer-2 answers only when Layer-1 is silent.
  # ⚠️ catalyst.feedback is a STRING in the live Layer-2 config
  # ("https://github.com/coalesce-labs/catalyst.git"), so a bare jq walk of
  # .catalyst.feedback.autoFile would die with "Cannot index string with
  # autoFile". catalyst_layer2_json wraps the walk in try/catch and yields empty.
  if [ -z "$_fc_val" ] && command -v catalyst_layer2_json >/dev/null 2>&1; then
    _fc_val="$(catalyst_layer2_json '.catalyst.feedback.autoFile')"
  fi
  echo "$_fc_val"
  return 0
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
    # CTL-1214: consent is NODE-scoped, so it is recorded in the machine-local
    # node.json — never patched back into the committed .catalyst/config.json,
    # which would re-leak the stanza the Phase-4 slimming removes. Reads stay
    # Layer-1-then-Layer-2 (see read_auto_file above), so an operator who granted
    # consent BEFORE this change is unaffected: their Layer-1 value still wins.
    _FC_L2="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
    _FC_NODE="$(dirname "$_FC_L2")/node.json"
    mkdir -p "$(dirname "$_FC_NODE")"
    if [ ! -f "$_FC_NODE" ]; then
      printf '{}\n' > "$_FC_NODE"
      chmod 600 "$_FC_NODE"
    fi
    TMP="${_FC_NODE}.tmp.$$"
    if jq '.catalyst = (.catalyst // {})
           | .catalyst.feedback = (if (.catalyst.feedback | type) == "object" then .catalyst.feedback else {} end)
           | .catalyst.feedback.autoFile = true
           | .catalyst.feedback.githubRepo = (.catalyst.feedback.githubRepo // "coalesce-labs/catalyst")
           | .catalyst.feedback.labels = (.catalyst.feedback.labels // ["auto-submitted"])' \
         "$_FC_NODE" > "$TMP"; then
      chmod 600 "$TMP"
      mv "$TMP" "$_FC_NODE"
      echo "granted"
    else
      rm -f "$TMP"
      echo "ERROR: failed to update ${_FC_NODE}" >&2
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
