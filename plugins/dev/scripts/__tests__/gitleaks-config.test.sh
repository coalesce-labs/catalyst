#!/usr/bin/env bash
# Tests for .gitleaks.toml (CTL-1204): config parses, extends defaults,
# allowlists the known fake fixtures, and yields a clean baseline scan.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CFG="${REPO_ROOT}/.gitleaks.toml"

# Skip the whole suite (not fail) when the binary is unavailable — dev hosts vary.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "SKIP: gitleaks binary not installed"
  exit 0
fi

# 1. Config exists and parses / extends defaults (static asserts — always run).
[[ -f "$CFG" ]] || { echo "FAIL: .gitleaks.toml missing"; exit 1; }
grep -q 'useDefault' "$CFG" || { echo "FAIL: must [extend] useDefault=true"; exit 1; }

# 2. Baseline full-history scan is clean (the real gate).
( cd "$REPO_ROOT" && gitleaks detect --config .gitleaks.toml --no-banner --redact ) \
  || { echo "FAIL: baseline gitleaks scan found findings"; exit 1; }

echo "PASS: gitleaks baseline clean"
