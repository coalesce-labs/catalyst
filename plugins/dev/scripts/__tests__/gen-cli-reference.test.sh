#!/usr/bin/env bash
# gen-cli-reference.test.sh — CTL-1387. Asserts the CLI-reference generator's
# in-script manifest covers EXACTLY install-cli.sh's CLI_ENTRIES, renders valid
# Starlight frontmatter + a DO-NOT-EDIT header, emits every installed tool as a
# heading, and never bare-invokes (or hangs on) the unsafe stdin/daemon tools.
#
# Run: bash plugins/dev/scripts/__tests__/gen-cli-reference.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)" # plugins/dev/scripts
GEN="${SCRIPTS}/gen-cli-reference.sh"
INSTALL_CLI="${SCRIPTS}/install-cli.sh"
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

# installed names (the part after the colon) from CLI_ENTRIES — source of truth.
installed_names() {
  sed -n '/^CLI_ENTRIES=(/,/^)/p' "$INSTALL_CLI" |
    grep -oE '"[^"]+"' | tr -d '"' | sed -E 's/.*://'
}

# names the generator's in-script manifest declares (it exposes --list-manifest).
manifest_names() {
  bash "$GEN" --list-manifest 2>/dev/null | cut -d'|' -f1
}

# (0) generator present + executable
[[ -x "$GEN" ]] && pass "generator exists and is executable" || fail "generator missing/not executable: $GEN"

# (a) manifest covers CLI_ENTRIES bidirectionally (no missing, no invented)
INST="$(installed_names | sort -u)"
MAN="$(manifest_names | sort -u)"
for n in $INST; do
  grep -qxF "$n" <<<"$MAN" && pass "manifest covers $n" || fail "manifest missing installed tool $n"
done
for n in $MAN; do
  grep -qxF "$n" <<<"$INST" && pass "manifest entry $n is a real CLI" || fail "manifest invents tool $n"
done

# Generate the page once, with a wall-clock guard proving no hang on the
# stdin-reading / daemon / TUI tools (they must NOT be bare-invoked).
START=$(date +%s)
OUT="$(bash "$GEN" 2>/dev/null)"
rc=$?
END=$(date +%s)
[[ "$rc" -eq 0 ]] && pass "generator exits 0" || fail "generator exited $rc"
[[ $((END - START)) -lt 60 ]] && pass "generator completes <60s (no hang on stdin/daemon tools)" || fail "generator took $((END - START))s (possible hang)"

# (b) Starlight frontmatter
[[ "$OUT" == ---* ]] && pass "output begins with frontmatter ---" || fail "no leading frontmatter ---"
grep -q '^title:' <<<"$OUT" && pass "has title:" || fail "missing title:"
grep -q '^description:' <<<"$OUT" && pass "has description:" || fail "missing description:"
grep -qE '^[[:space:]]+order:[[:space:]]*5$' <<<"$OUT" && pass "has sidebar order 5" || fail "missing sidebar order: 5"

# (c) DO-NOT-EDIT header naming the generator
grep -qi 'DO NOT EDIT' <<<"$OUT" && pass "DO-NOT-EDIT header present" || fail "DO-NOT-EDIT header missing"
grep -q 'gen-cli-reference.sh' <<<"$OUT" && pass "header names the generator" || fail "generator name missing from header"

# (d) every installed name renders as a '### <name>' heading (exact)
while read -r n; do
  [[ -z "$n" ]] && continue
  grep -qE "^### ${n}$" <<<"$OUT" && pass "heading for $n" || fail "no '### $n' heading"
done <<<"$INST"

# (e) a known-unsafe tool is documented from the curated manifest (proves the
#     generator emits text for it WITHOUT bare-invoking it — see no-hang guard).
grep -qE "^### catalyst-statusline$" <<<"$OUT" && pass "unsafe tool catalyst-statusline documented" || fail "catalyst-statusline missing"

echo "── ${PASSES} passed, ${FAILURES} failed ──"
[[ "$FAILURES" -eq 0 ]]
