#!/usr/bin/env bash
# Contract test: active website entry points use only the supported skills repositories.
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
    local grep_status=$?
    if [[ $grep_status -eq 1 ]]; then
      PASSES=$((PASSES+1)); echo "  PASS: $label"
    else
      FAILURES=$((FAILURES+1)); echo "  FAIL: $label (grep exited with $grep_status for $file)"
    fi
  fi
}
assert_doc_lacks_ere() {
  local label="$1" file="$2" pattern="$3"
  if grep -Eq -- "$pattern" "$REPO_ROOT/$file"; then
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (should be gone from $file): $pattern"
  else
    local grep_status=$?
    if [[ $grep_status -eq 1 ]]; then
      PASSES=$((PASSES+1)); echo "  PASS: $label"
    else
      FAILURES=$((FAILURES+1)); echo "  FAIL: $label (grep exited with $grep_status for $file)"
    fi
  fi
}

missing_doc="$GS/.contract-missing-control-$$"
if (
  FAILURES=0; PASSES=0
  assert_doc_lacks "missing-file negative control" "$missing_doc" "needle" >/dev/null 2>&1
  [[ $FAILURES -eq 1 && $PASSES -eq 0 ]]
); then
  PASSES=$((PASSES+1)); echo "  PASS: a grep read error fails the negative assertion"
else
  FAILURES=$((FAILURES+1)); echo "  FAIL: a grep read error must fail the negative assertion"
fi

echo "=== Supported workstation skill sources ==="
INDEX="$GS/index.md"
assert_doc_has "index: dev pack uses its own repository" \
  "$INDEX" "npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g"
assert_doc_has "index: Cloud pack uses its own repository" \
  "$INDEX" "npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g"
assert_doc_has "index: Cloud CLI is a tool dependency" \
  "$INDEX" "@catalyst-cloud/catalyst-skills"
assert_doc_has "index: legacy plugin is explicitly rejected" \
  "$INDEX" "Do not install \`catalyst-dev@catalyst\`"
assert_doc_has "index: historical setup points to tracked README content" \
  "$INDEX" "blob/73bc0645252ce8be38f8c87be6b67b950b3f0b56/README.md"

for page in \
  "$INDEX" \
  "$GS/install-claude.md" \
  "$GS/install-codex.md" \
  "$GS/install-portable.md" \
  "$GS/remote-and-unattended-hosts.md" \
  website/src/content/docs/reference/plugins.md; do
  assert_doc_lacks "$page has no old setup script command" "$page" \
    "https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh"
  assert_doc_lacks_ere "$page has no old marketplace recommendation" "$page" \
    'marketplace add coalesce-labs/catalyst([[:space:]]|$)'
done

echo ""
echo "=== Remote setup uses the same approved repositories ==="
REMOTE="$GS/remote-and-unattended-hosts.md"
assert_doc_has "remote: dev pack source" "$REMOTE" "coalesce-labs/catalyst-dev-skills"
assert_doc_has "remote: Cloud pack source" "$REMOTE" "coalesce-labs/catalyst-cloud-skills"
assert_doc_has "remote: warns against personal credentials in shared hosts" "$REMOTE" \
  "Do not put a person's Cloud login in a shared host or image."
assert_doc_has "remote: historical notes point to tracked README content" "$REMOTE" \
  "blob/73bc0645252ce8be38f8c87be6b67b950b3f0b56/README.md"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
