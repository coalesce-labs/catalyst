#!/usr/bin/env bash
# no-plugin-hooks.test.sh — CTL-2306 Phase 1: catalyst-dev ships no hooks.
#
# WHY: Claude Code hooks are pack-scoped, and scripts/packaging/core/safety-gate.mjs
# vetoes EVERY skill of a pack that carries a hooks file from the Codex and
# .agents/skills targets. A single hook here silently removes the whole dev
# plugin from every non-Claude harness. Ryan dropped all three dev hooks
# (2026-09-13): the plan-mode pair, update-workflow-context, and
# detect-bare-linear-read. A future cross-harness hook is emitted by rulesync
# OUTSIDE plugins/ (CTL-2306 Phase 5), never re-added here.
#
# The workflow-context layer those hooks fed goes with them: a skill must never
# depend on state persisted between runs, so there is no registrar left to call.
#
# Run: bash plugins/dev/skills/__tests__/no-plugin-hooks.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

# hook_layer_present <plugin-dir> → prints every hook-layer path that exists.
# One instrument, used for the control AND the real assertion.
HOOK_LAYER_PATHS="hooks.toml hooks hooks/hooks.json HOOKS.md WORKFLOW_CONTEXT.md scripts/workflow-context.sh scripts/test-workflow-context.sh scripts/register-thought.sh scripts/__tests__/detect-bare-linear-read.test.sh"
hook_layer_present() {
  local dir="$1" p
  for p in $HOOK_LAYER_PATHS; do
    [ -e "${dir}/${p}" ] && printf '%s\n' "$p"
  done
  return 0
}

echo "catalyst-dev ships no hooks (CTL-2306)"
[ -f "${PLUGIN_DIR}/.claude-plugin/plugin.json" ] || { echo "FATAL: not a plugin dir: ${PLUGIN_DIR}" >&2; exit 1; }

# ── Positive control: the instrument sees a hook layer that IS there ─────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
printf '[[hooks]]\nname = "control"\n' > "${SCRATCH}/hooks.toml"
mkdir -p "${SCRATCH}/scripts"
: > "${SCRATCH}/scripts/workflow-context.sh"
control="$(hook_layer_present "$SCRATCH")"
if printf '%s\n' "$control" | grep -qx 'hooks.toml' && printf '%s\n' "$control" | grep -qx 'scripts/workflow-context.sh'; then
  ok "control: the probe reports a hook layer planted in a scratch plugin"
else
  fail "control: the probe reports a hook layer planted in a scratch plugin" "got: ${control:-<nothing>}"
fi

# ── The real plugin ──────────────────────────────────────────────────────────
present="$(hook_layer_present "$PLUGIN_DIR")"
if [ -z "$present" ]; then
  ok "plugins/dev carries no hook layer"
else
  fail "plugins/dev carries no hook layer" "still present: $(printf '%s' "$present" | tr '\n' ' ')"
fi

if grep -q '"hooks"' "${PLUGIN_DIR}/.claude-plugin/plugin.json" "${PLUGIN_DIR}/.codex-plugin/plugin.json"; then
  fail "no plugin manifest declares hooks" "a plugin.json names a \"hooks\" key"
else
  ok "no plugin manifest declares hooks"
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
