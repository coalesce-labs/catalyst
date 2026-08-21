#!/bin/bash
# Test that scripts can be found with and without CLAUDE_PLUGIN_ROOT

echo "=== Testing Script Resolution ==="

# Test 1: With CLAUDE_PLUGIN_ROOT set
export CLAUDE_PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Test 1: CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"

if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  echo "✅ Found check-prerequisites.sh with CLAUDE_PLUGIN_ROOT"
else
  echo "❌ FAILED: check-prerequisites.sh not found"
  exit 1
fi

if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  echo "✅ Found workflow-context.sh with CLAUDE_PLUGIN_ROOT"
else
  echo "❌ FAILED: workflow-context.sh not found"
  exit 1
fi

# Test 2: Without CLAUDE_PLUGIN_ROOT set
unset CLAUDE_PLUGIN_ROOT
echo "Test 2: CLAUDE_PLUGIN_ROOT unset"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "${SCRIPT_DIR}/check-prerequisites.sh" ]]; then
  echo "✅ Found check-prerequisites.sh with fallback"
else
  echo "❌ FAILED: check-prerequisites.sh not found with fallback"
  exit 1
fi

if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  echo "✅ Found workflow-context.sh with fallback"
else
  echo "❌ FAILED: workflow-context.sh not found with fallback"
  exit 1
fi

echo ""
echo "✅ All script resolution tests passed!"
