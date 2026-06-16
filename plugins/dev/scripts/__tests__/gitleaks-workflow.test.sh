#!/usr/bin/env bash
# Tests for .github/workflows/gitleaks.yml (CTL-1204): triggers, action ref,
# fetch-depth, config + license wiring.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WF="${REPO_ROOT}/.github/workflows/gitleaks.yml"
fail=0
chk() { grep -Eq "$2" "$WF" || { echo "FAIL: $1"; fail=1; }; }

[[ -f "$WF" ]] || { echo "FAIL: workflow missing"; exit 1; }
chk "uses gitleaks-action@v3"       'gitleaks/gitleaks-action@v3'
chk "pull_request trigger"          '^\s*pull_request:'
chk "push to main trigger"          'branches:\s*\[.*main.*\]|- main'
chk "fetch-depth 0"                 'fetch-depth:\s*0'
chk "GITLEAKS_CONFIG points at toml" 'GITLEAKS_CONFIG:\s*\.gitleaks\.toml'
chk "GITLEAKS_LICENSE wired"        'GITLEAKS_LICENSE'
[[ $fail -eq 0 ]] && echo "PASS: gitleaks workflow well-formed" || exit 1
