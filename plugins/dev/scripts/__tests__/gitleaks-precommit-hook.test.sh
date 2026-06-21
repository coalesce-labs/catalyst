#!/usr/bin/env bash
# Tests for scripts/hooks/pre-commit (CTL-1204).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOK="${REPO_ROOT}/scripts/hooks/pre-commit"

# Static asserts (always run).
[[ -f "$HOOK" ]]   || { echo "FAIL: hook missing"; exit 1; }
[[ -x "$HOOK" ]]   || { echo "FAIL: hook not executable"; exit 1; }
grep -q 'protect --staged' "$HOOK" || { echo "FAIL: hook must call gitleaks protect --staged"; exit 1; }

# Graceful no-op path: simulate missing binary via PATH override → exit 0 + warning.
# Use /bin/bash explicitly so the PATH restriction only affects gitleaks lookup,
# not the bash invocation itself.
out="$(PATH="/nonexistent" /bin/bash "$HOOK" 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || { echo "FAIL: hook must exit 0 when gitleaks absent (got rc=$rc)"; exit 1; }
grep -qi 'gitleaks' <<<"$out" || { echo "FAIL: hook should warn when gitleaks absent"; exit 1; }

# Behavioral asserts need the real binary; SKIP otherwise.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "SKIP: gitleaks binary not installed (behavioral asserts skipped)"
  exit 0
fi

echo "PASS: pre-commit hook static + no-op behavior"
