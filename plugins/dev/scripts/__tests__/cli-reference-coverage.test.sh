#!/usr/bin/env bash
# Coverage test: every CLI_ENTRIES command appears in the CLI reference page (CTL-1386).
# Run: bash plugins/dev/scripts/__tests__/cli-reference-coverage.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_CLI="$REPO_ROOT/plugins/dev/scripts/install-cli.sh"
DOC="$REPO_ROOT/website/src/content/docs/reference/cli.md"

FAILURES=0; PASSES=0

# Derive the canonical installed command names (right-hand side of each
# "source:command" pair in the CLI_ENTRIES array literal). A while-read loop
# (not `mapfile`) keeps this portable to the bash 3.2 that ships on macOS,
# where the aggregate run-tests.sh runner also executes this test.
COMMANDS=()
while IFS= read -r cmd; do
  [ -n "$cmd" ] && COMMANDS+=("$cmd")
done < <(
  awk '/^CLI_ENTRIES=\(/{f=1; next} f&&/^\)/{exit} f{
    gsub(/[" \t]/,""); n=split($0,a,":"); if(n>=2) print a[2]
  }' "$INSTALL_CLI"
)

[ "${#COMMANDS[@]}" -ge 20 ] || { echo "FAIL: parsed only ${#COMMANDS[@]} commands from install-cli.sh"; exit 1; }
[ -f "$DOC" ] || { echo "FAIL: $DOC missing"; exit 1; }

for cmd in "${COMMANDS[@]}"; do
  if grep -qF -- "$cmd" "$DOC"; then
    PASSES=$((PASSES+1)); echo "  PASS: cli.md documents $cmd"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: cli.md missing $cmd"
  fi
done

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
