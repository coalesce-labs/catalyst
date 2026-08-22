#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="${ROOT}/skills/phase-pr/SKILL.md"

count="$(grep -c 'PUSH_VERIFY_RC" -eq 5' "$SKILL" || true)"
reasons="$(grep -c -- '--reason "push_denied_no_permission"' "$SKILL" || true)"

[[ "$count" -eq 2 ]] || { echo "FAIL: expected rc=5 in both phase-pr paths, got $count"; exit 1; }
[[ "$reasons" -eq 2 ]] || { echo "FAIL: expected permission reason in both paths, got $reasons"; exit 1; }
echo "PASS: phase-pr maps rc=5 to push_denied_no_permission on both paths"
