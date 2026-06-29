#!/usr/bin/env bash
# cli-reference-drift.test.sh — CTL-1387. Asserts the committed catalyst CLI
# reference page (reference/catalyst-cli.md) documents EXACTLY the tool list in
# install-cli.sh's CLI_ENTRIES, and that the page, the generator's manifest, and
# CLI_ENTRIES cannot silently diverge. Modeled on
# execution-core/quota-field-doc-drift.test.sh. This is the "cannot drift" guard:
# adding a CLI to CLI_ENTRIES without documenting it fails CI.
#
# Run: bash plugins/dev/scripts/__tests__/cli-reference-drift.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)" # plugins/dev/scripts
REPO_ROOT="$(cd "${SCRIPTS}/../../.." && pwd)"
INSTALL_CLI="${SCRIPTS}/install-cli.sh"
GEN="${SCRIPTS}/gen-cli-reference.sh"
DOC="${REPO_ROOT}/website/src/content/docs/reference/catalyst-cli.md"
PASSES=0
FAILURES=0
pass() {
  echo "  PASS: $1"
  PASSES=$((PASSES + 1))
}
fail() {
  echo "  FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

# Installed names (after the colon) from CLI_ENTRIES — the source of truth.
installed_names() {
  sed -n '/^CLI_ENTRIES=(/,/^)/p' "$INSTALL_CLI" |
    grep -oE '"[^"]+"' | tr -d '"' | sed -E 's/.*://'
}

INST="$(installed_names | sort -u)"

# (a) page exists
[[ -f "$DOC" ]] && pass "reference page exists" || fail "reference page missing: $DOC"

# (b) forward drift — every installed CLI appears verbatim as a '### <name>'
#     heading in the committed page.
for n in $INST; do
  grep -qE "^### ${n}$" "$DOC" && pass "doc documents tool $n" || fail "doc missing tool $n"
done

# (c) reverse drift — every '### <name>' heading in the page is backed by a real
#     CLI_ENTRIES name (the page invents no tool).
DOC_HEADINGS="$(grep -oE '^### [A-Za-z0-9_-]+' "$DOC" | sed -E 's/^### //' | sort -u)"
for d in $DOC_HEADINGS; do
  grep -qxF "$d" <<<"$INST" && pass "doc heading $d backed by CLI_ENTRIES" || fail "doc invents tool $d"
done

# (d) defense-in-depth — the generator's manifest and CLI_ENTRIES are the same set.
MAN="$(bash "$GEN" --list-manifest 2>/dev/null | cut -d'|' -f1 | sort -u)"
for n in $INST; do
  grep -qxF "$n" <<<"$MAN" && pass "manifest covers $n" || fail "manifest missing $n"
done
for m in $MAN; do
  grep -qxF "$m" <<<"$INST" && pass "manifest entry $m is real" || fail "manifest invents $m"
done

# (e) DO-NOT-EDIT header present (discourages hand-edits that defeat the generator).
grep -qi "DO NOT EDIT" "$DOC" && pass "DO-NOT-EDIT header present" || fail "DO-NOT-EDIT header missing"
grep -qF "gen-cli-reference.sh" "$DOC" && pass "header names the generator" || fail "generator name missing from header"

echo "── ${PASSES} passed, ${FAILURES} failed ──"
[[ "$FAILURES" -eq 0 ]]
