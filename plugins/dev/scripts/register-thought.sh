#!/usr/bin/env bash
# PostToolUse Write hook: auto-registers any thoughts/shared/ write to workflow-context.
# Receives PostToolUse tool call data as JSON on stdin.
# Runs after every Write tool call; exits 0 (no-op) if not a thoughts/shared/ write.
#
# Installed to ~/.catalyst/bin/register-thought by install-cli.sh.
# Referenced from ~/.claude/settings.json PostToolUse > Write hook.

set -euo pipefail

# CTL-390: --version handling (must run before the stdin read below).
case "${1:-}" in
  --version|-V)
    _CV_SRC="${BASH_SOURCE[0]}"
    while [[ -L "$_CV_SRC" ]]; do
      _CV_D="$(cd -P "$(dirname "$_CV_SRC")" && pwd)" && _CV_SRC="$(readlink "$_CV_SRC")"
      [[ "$_CV_SRC" != /* ]] && _CV_SRC="$_CV_D/$_CV_SRC"
    done
    _CV_DIR="$(cd -P "$(dirname "$_CV_SRC")" && pwd)"
    [[ -f "${_CV_DIR}/lib/catalyst-version.sh" ]] && . "${_CV_DIR}/lib/catalyst-version.sh" \
      && catalyst_print_version "register-thought" "${BASH_SOURCE[0]}" && exit 0
    echo "error: catalyst-version helper missing at ${_CV_DIR}/lib/catalyst-version.sh" >&2
    exit 1
    ;;
esac

INPUT=$(cat 2>/dev/null || true)
[[ -z "$INPUT" ]] && exit 0

FILE_PATH=$(echo "$INPUT" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" \
  2>/dev/null || true)

[[ "$FILE_PATH" != *"thoughts/shared/"* ]] && exit 0

# Derive type from subdirectory: thoughts/shared/<type>/...
TYPE=$(echo "$FILE_PATH" | sed 's|.*thoughts/shared/\([^/]*\)/.*|\1|')
[[ -z "$TYPE" || "$TYPE" == "$FILE_PATH" ]] && exit 0

# Extract ticket ID from path (first PROJ-123 pattern found)
TICKET=$(echo "$FILE_PATH" | grep -oE '[A-Z]+-[0-9]+' | head -1 || true)

# Find workflow-context.sh: installed bin dir first, then plugin cache fallback
WC_SCRIPT=""
for candidate in \
  "$HOME/.catalyst/bin/workflow-context" \
  "$HOME/.catalyst/bin/workflow-context.sh" \
  "${CLAUDE_PLUGIN_ROOT:-__missing__}/scripts/workflow-context.sh" \
; do
  [[ -x "$candidate" ]] && WC_SCRIPT="$candidate" && break
done

# CTL-1628 Phase A2 bug fix: the final fallback used to be
# `find "$HOME/.claude/plugins" -name workflow-context.sh -maxdepth 8 | head -1`
# — UNORDERED, so with more than one cached/marketplace copy installed it
# could silently pick an arbitrary (possibly stale) one. Resolve via
# lib/catalyst-runtime-root.sh's catalyst_dev_scripts instead — the same
# ordered probe (env override -> source-checkout sibling -> repo-root cwd ->
# newest marketplace clone -> newest versioned cache) every other
# catalyst-dev consumer uses. This script is itself always a sibling of
# lib/catalyst-runtime-root.sh (both live in plugins/dev/scripts/), so its
# own real (symlink-resolved) location — it is installed to
# ~/.catalyst/bin/register-thought as a symlink — reliably bootstraps
# sourcing the lib with no ambiguity.
if [[ -z "$WC_SCRIPT" ]]; then
  _RT_SRC="${BASH_SOURCE[0]}"
  while [[ -L "$_RT_SRC" ]]; do
    _RT_D="$(cd -P "$(dirname "$_RT_SRC")" && pwd)" && _RT_SRC="$(readlink "$_RT_SRC")"
    [[ "$_RT_SRC" != /* ]] && _RT_SRC="$_RT_D/$_RT_SRC"
  done
  _RT_DIR="$(cd -P "$(dirname "$_RT_SRC")" && pwd)"
  if [[ -f "${_RT_DIR}/lib/catalyst-runtime-root.sh" ]]; then
    # shellcheck disable=SC1091
    . "${_RT_DIR}/lib/catalyst-runtime-root.sh"
    catalyst_dev_scripts >/dev/null 2>&1 || true
    if [[ -n "${CATALYST_DEV_SCRIPTS:-}" && -x "${CATALYST_DEV_SCRIPTS}/workflow-context.sh" ]]; then
      WC_SCRIPT="${CATALYST_DEV_SCRIPTS}/workflow-context.sh"
    fi
  fi
  unset _RT_SRC _RT_D _RT_DIR
fi

[[ -z "$WC_SCRIPT" ]] && exit 0

"$WC_SCRIPT" add "$TYPE" "$FILE_PATH" "${TICKET:-}" 2>/dev/null || true
