#!/usr/bin/env bash
# Contract test: getting-started docs match the real fresh-install flow (CTL-848).
# Run: bash plugins/dev/scripts/__tests__/getting-started-contract.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
GS="website/src/content/docs/getting-started"
FAILURES=0; PASSES=0

assert_doc_has() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$REPO_ROOT/$file"; then
    PASSES=$((PASSES+1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (missing in $file): $needle"
  fi
}
assert_doc_lacks() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$REPO_ROOT/$file"; then
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (should be gone from $file): $needle"
  else
    PASSES=$((PASSES+1)); echo "  PASS: $label"
  fi
}

echo "=== Phase 1: index.md correctness fixes ==="

# Issue 1 — snippet path
assert_doc_lacks "index: broken repo-relative snippet path removed" \
  "$GS/index.md" "cat plugins/dev/templates/CLAUDE_SNIPPET.md"
assert_doc_has "index: snippet uses installed-cache glob" \
  "$GS/index.md" ".claude/plugins/cache/catalyst/catalyst-dev/*/templates/CLAUDE_SNIPPET.md"

# Issue 2 — CLI plugin install form
assert_doc_has "index: CLI marketplace-add form documented" \
  "$GS/index.md" "claude plugin marketplace add coalesce-labs/catalyst"
assert_doc_has "index: CLI plugin-install form documented" \
  "$GS/index.md" "claude plugin install catalyst-dev@catalyst"

# Issue 7 — install-cli glob guard (a not-found guard is present near the install-cli line)
assert_doc_has "index: install-cli step has a not-found guard" \
  "$GS/index.md" "plugin not installed"

# Issue 8 — qualified skill name
assert_doc_has "index: try-it uses qualified skill name" \
  "$GS/index.md" "/catalyst-dev:research-codebase"

echo ""
echo "=== Phase 2: daemon stack naming ==="

# Issue 3/6 — the three services are named and given a one-line role for newcomers
assert_doc_has "index: names broker service" \
  "$GS/index.md" "catalyst-broker"
assert_doc_has "index: names monitor service" \
  "$GS/index.md" "catalyst-monitor"
assert_doc_has "index: names execution-core service" \
  "$GS/index.md" "catalyst-execution-core"
assert_doc_has "how-it-works: names execution-core (not just 'the executor')" \
  "$GS/how-catalyst-works.md" "execution-core"

echo ""
echo "=== Phase 3: remote and unattended hosts page ==="

# Issue 4 — gh keychain migration pattern documented
REMOTE="$GS/remote-and-unattended-hosts.md"
if [ -f "$REPO_ROOT/$REMOTE" ]; then
  PASSES=$((PASSES+1)); echo "  PASS: remote-host page exists"
else
  FAILURES=$((FAILURES+1)); echo "  FAIL: remote-host page missing: $REMOTE"
fi
assert_doc_has "remote: gh token migration pattern" \
  "$REMOTE" "gh auth token | ssh"
# Issue 5 — macOS-only-vs-headless reconciled (unattended host framed as a headless Mac)
assert_doc_has "remote: clarifies unattended host is a headless Mac" \
  "$REMOTE" "headless Mac"
assert_doc_has "remote: post-reboot start documented for unattended host" \
  "$REMOTE" "catalyst-stack start"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
