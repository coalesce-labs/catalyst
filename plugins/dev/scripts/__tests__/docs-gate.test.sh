#!/usr/bin/env bash
# Tests for scripts/ci/docs-paths-changed.sh — the docs-relevance decision
# helper behind the docs-gate required check (CTL-670).
# Run: bash plugins/dev/scripts/__tests__/docs-gate.test.sh
#
# Contract under test: the helper reads newline-delimited changed paths on
# stdin, prints "docs" + exits 0 if ANY path is docs-relevant (would change
# what the Cloudflare Pages docs build deploys), else prints "nodocs" + exits 1.
# Docs-relevant = anything under website/, or any plugins/<name>/CHANGELOG.md
# (the docs build renders changelog pages from ../plugins/*/CHANGELOG.md — see
# website/astro.config.mjs).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/ci/docs-paths-changed.sh"

FAILURES=0
PASSES=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

# run_case LABEL EXPECTED_OUTPUT EXPECTED_RC <<< "paths"
# Feeds the heredoc/stdin to the helper and asserts both its stdout and exit code.
run_case() {
  local label="$1" exp_out="$2" exp_rc="$3" input="$4"
  local out rc
  out="$(printf '%s' "$input" | bash "$SCRIPT" 2>/dev/null)"
  rc=$?
  assert_eq "${label} (output)" "$exp_out" "$out"
  assert_eq "${label} (exit code)" "$exp_rc" "$rc"
}

echo "docs-gate: docs-paths-changed.sh"

# 1. A single website/ file → docs, 0
run_case "single website/ file" "docs" "0" $'website/src/content/docs/index.mdx\n'

# 2. A nested website/ file (config) → docs, 0
run_case "nested website/ file" "docs" "0" $'website/astro.config.mjs\n'

# 3. A plugin changelog → docs, 0 (the astro.config.mjs changelog dependency)
run_case "dev changelog" "docs" "0" $'plugins/dev/CHANGELOG.md\n'

# 4. Another plugin's changelog → docs, 0
run_case "pm changelog" "docs" "0" $'plugins/pm/CHANGELOG.md\n'

# 5. A pure non-docs change → nodocs, 1
run_case "non-docs scheduler" "nodocs" "1" $'plugins/dev/scripts/scheduler.mjs\n'

# 6. Root files that are not deployed → nodocs, 1
run_case "root non-docs files" "nodocs" "1" $'README.md\npackage.json\n'

# 7. Mixed: any docs-relevant path wins → docs, 0
run_case "mixed wins docs" "docs" "0" $'plugins/dev/scripts/x.mjs\nwebsite/src/x.md\n'

# 8. A non-CHANGELOG file under plugins/ → nodocs, 1 (guard against over-broad plugins/ match)
run_case "plugins non-changelog" "nodocs" "1" $'plugins/dev/scripts/y.ts\n'

# 9. Empty stdin (no changed files) → nodocs, 1
run_case "empty stdin" "nodocs" "1" ""

echo
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
exit 0
