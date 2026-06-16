#!/usr/bin/env bash
# config-mirror-xref.test.sh — CTL-1187. Asserts discoverability + §8 correction.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RESEARCH="${REPO_ROOT}/thoughts/shared/research/2026-06-15-multi-node-cluster-setup.md"
REMOTE="${REPO_ROOT}/website/src/content/docs/getting-started/remote-and-unattended-hosts.md"
PASSES=0; FAILURES=0
pass(){ echo "  PASS: $1"; (( PASSES++ )) || true; }
fail(){ echo "  FAIL: $1"; (( FAILURES++ )) || true; }

# (a) §8 of prior research carries a correction pointing readers at the canonical page
grep -qiE "CTL-1187|cluster-config-mirror|correction" "$RESEARCH" \
  && pass "research §8 correction note present" || fail "research §8 correction missing"
grep -qiE "bot.*OAuth.*(SHARED|machine-global)" "$RESEARCH" \
  && pass "research notes bot OAuth is SHARED/machine-global" || fail "bot OAuth correction text missing"

# (b) remote-hosts getting-started page links to the canonical reference
grep -qF "cluster-config-mirror" "$REMOTE" \
  && pass "remote-hosts page links to canonical reference" || fail "remote-hosts link missing"

echo "── ${PASSES} passed, ${FAILURES} failed ──"
[[ "$FAILURES" -eq 0 ]]
