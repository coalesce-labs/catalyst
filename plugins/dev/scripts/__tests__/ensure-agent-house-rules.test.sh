#!/usr/bin/env bash
# Tests for ensure-agent-house-rules.sh — the "Working the Loop" auto-seeder.
# Run: bash plugins/dev/scripts/__tests__/ensure-agent-house-rules.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/ensure-agent-house-rules.sh"
TEMPLATE="${REPO_ROOT}/plugins/dev/templates/agents-house-rules.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[[ -n "${2:-}" ]] && echo "    $2"
}
assert_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "expected='$2' actual='$3'"; }
assert_file_has() { grep -qF "$2" "$3" && pass "$1" || fail "$1" "'$2' not in $3"; }
assert_file_lacks() { grep -qF "$2" "$3" && fail "$1" "'$2' unexpectedly in $3" || pass "$1"; }
count_headings() { grep -c '^## Working the Loop' "$1" 2>/dev/null || echo 0; }

run() { bash "$SCRIPT" --quiet --repo "$1" "${@:2}"; }

# ---- 0. template integrity: markers survive comment-strip ----------------------
[[ -f "$TEMPLATE" ]] && pass "template exists" || fail "template exists"
for m in "subscribe to the event log" "👍" "local replica"; do
	grep -qF "$m" "$TEMPLATE" && pass "template has marker: $m" || fail "template marker: $m"
done

# ---- 1. empty repo → creates AGENTS.md + @AGENTS.md bridge ----------------------
R="$SCRATCH/empty"; mkdir -p "$R"
run "$R"; assert_eq "empty: dry-run signals change (rc=10)" 10 "$?"
[[ ! -f "$R/AGENTS.md" ]] && pass "empty: dry-run wrote nothing" || fail "empty: dry-run wrote a file"
run "$R" --fix; assert_eq "empty: --fix rc=0" 0 "$?"
assert_file_has "empty: AGENTS.md seeded" "Working the Loop" "$R/AGENTS.md"
assert_eq "empty: CLAUDE.md is a bridge" "@AGENTS.md" "$(head -1 "$R/CLAUDE.md")"
assert_file_lacks "empty: block not duplicated into CLAUDE.md" "Working the Loop" "$R/CLAUDE.md"

# ---- 2. bridged repo → seeds into AGENTS.md, leaves CLAUDE.md alone -------------
R="$SCRATCH/bridge"; mkdir -p "$R"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
run "$R" --fix >/dev/null
assert_file_has "bridge: seeded into AGENTS.md" "Working the Loop" "$R/AGENTS.md"
assert_file_lacks "bridge: CLAUDE.md untouched" "Working the Loop" "$R/CLAUDE.md"

# ---- 3. monolithic CLAUDE.md → seeds into CLAUDE.md ----------------------------
R="$SCRATCH/mono"; mkdir -p "$R"
printf '# CLAUDE.md — Foo\n\n## Setup\nrun\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
assert_file_has "mono: seeded into CLAUDE.md" "Working the Loop" "$R/CLAUDE.md"

# ---- 4. idempotency: re-run makes no change, no duplicate heading --------------
run "$R"; assert_eq "mono: second dry-run is current (rc=0)" 0 "$?"
run "$R" --fix >/dev/null
assert_eq "mono: exactly one block heading after re-run" 1 "$(count_headings "$R/CLAUDE.md")"

# ---- 5. stale block updated in place; surrounding content preserved ------------
R="$SCRATCH/stale"; mkdir -p "$R"
cat >"$R/CLAUDE.md" <<'EOF'
# CLAUDE.md

## Working the Loop (every agent — interactive too, not just skills)

OLD BODY — should be replaced.

- **Reading one Linear ticket → the local replica.** Use `linear_read_ticket <ID>` (old).

## Later Section

keep me
EOF
run "$R"; assert_eq "stale: dry-run signals update (rc=10)" 10 "$?"
run "$R" --fix >/dev/null
assert_eq "stale: one heading after update" 1 "$(count_headings "$R/CLAUDE.md")"
assert_file_lacks "stale: old body replaced" "OLD BODY" "$R/CLAUDE.md"
assert_file_has "stale: new wording present" "freshness-gated local replica" "$R/CLAUDE.md"
assert_file_has "stale: trailing section preserved" "keep me" "$R/CLAUDE.md"

# ---- 5b. existing block is followed, not the line-1 heuristic (catalyst-cloud case)
# CLAUDE.md imports AGENTS.md but NOT on line 1 (header + @import later); the block
# already lives in AGENTS.md. The seeder must UPDATE AGENTS.md, not append to CLAUDE.md.
R="$SCRATCH/hdrimport"; mkdir -p "$R"
printf '# CLAUDE.md\n\nSee AGENTS.md, imported below.\n\n@AGENTS.md\n' >"$R/CLAUDE.md"
cat >"$R/AGENTS.md" <<'EOF'
# AGENTS.md

## Working the Loop (every agent — interactive too, not just skills)

OLD stale body with `linear_read_ticket` only.

## Other
z
EOF
run "$R" --fix >/dev/null
assert_file_has "hdrimport: AGENTS.md block updated in place" "freshness-gated local replica" "$R/AGENTS.md"
assert_file_lacks "hdrimport: CLAUDE.md NOT given a block" "Working the Loop" "$R/CLAUDE.md"
assert_eq "hdrimport: exactly one heading in AGENTS.md" 1 "$(count_headings "$R/AGENTS.md")"
assert_file_has "hdrimport: trailing '## Other' preserved" "z" "$R/AGENTS.md"

# ---- 5c. P1 regression: block followed by a NON-H2 heading must not delete it ---
for hd in "# Top Level Heading" "### Deep Subsection" "#### Deeper"; do
	R="$SCRATCH/nonh2-$(echo "$hd" | tr -dc 'a-zA-Z')"; mkdir -p "$R"
	{
		echo "# CLAUDE.md"
		echo ""
		echo "## Working the Loop (every agent — interactive too, not just skills)"
		echo ""
		echo "OLD body."
		echo ""
		echo "$hd"
		echo ""
		echo "PRECIOUS user content under a non-H2 heading."
	} >"$R/CLAUDE.md"
	run "$R" --fix >/dev/null
	assert_file_has "non-H2 ($hd): heading preserved" "$hd" "$R/CLAUDE.md"
	assert_file_has "non-H2 ($hd): content after preserved" "PRECIOUS user content" "$R/CLAUDE.md"
	assert_file_has "non-H2 ($hd): block updated" "freshness-gated local replica" "$R/CLAUDE.md"
	assert_eq "non-H2 ($hd): one WtL heading" 1 "$(count_headings "$R/CLAUDE.md")"
	# blank line separator between block end and the following heading
	if grep -Pzoq "linearis\`\.\n\n\Q$hd\E" "$R/CLAUDE.md" 2>/dev/null; then pass "non-H2 ($hd): blank-line separator"; else
		# grep -P may be unavailable (BSD grep); fall back to a python check
		python3 - "$R/CLAUDE.md" "$hd" <<'PY' && pass "non-H2 ($hd): blank-line separator" || fail "non-H2 ($hd): blank-line separator"
import sys
t=open(sys.argv[1]).read(); h=sys.argv[2]
i=t.find(h)
sys.exit(0 if i>=2 and t[i-2:i]=="\n\n" else 1)
PY
	fi
done

# ---- 5d. P2: duplicate '## Working the Loop' headings → refuse loudly (exit 4) --
R="$SCRATCH/dup"; mkdir -p "$R"
{
	echo "# CLAUDE.md"; echo ""
	echo "## Working the Loop (every agent — interactive too, not just skills)"; echo ""; echo "one"; echo ""
	echo "## Working the Loop (every agent — interactive too, not just skills)"; echo ""; echo "two"
} >"$R/CLAUDE.md"
run "$R" --fix >/dev/null 2>&1; assert_eq "duplicate: --fix refuses (rc=4)" 4 "$?"
assert_eq "duplicate: still 2 headings (untouched)" 2 "$(count_headings "$R/CLAUDE.md")"

# ---- 5e. P3: append to a file WITHOUT a trailing newline gets a blank separator -
R="$SCRATCH/nonl"; mkdir -p "$R"
printf '# CLAUDE.md\n\nlast line no newline' >"$R/CLAUDE.md"   # no trailing \n
run "$R" --fix >/dev/null
python3 - "$R/CLAUDE.md" <<'PY' && pass "no-trailing-newline: blank separator before block" || fail "no-trailing-newline: blank separator"
import sys
t=open(sys.argv[1]).read(); i=t.find("## Working the Loop")
sys.exit(0 if i>=2 and t[i-2:i]=="\n\n" else 1)
PY

# ---- 5f. explicit --template missing → error names the supplied path -----------
R="$SCRATCH/tmpl"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"
out="$(bash "$SCRIPT" --repo "$R" --template /no/such/template-xyz.md --fix 2>&1)"; rc=$?
assert_eq "bad --template: exit 3" 3 "$rc"
grep -qF "/no/such/template-xyz.md" <<<"$out" && pass "bad --template: names supplied path" || fail "bad --template: names supplied path" "got: $out"

# ---- 5g. exact-heading: a "## Working the Loop Diagram" section is NOT the block -
R="$SCRATCH/prefix"; mkdir -p "$R"
{
	echo "# CLAUDE.md"; echo ""
	echo "## Working the Loop Diagram"; echo ""; echo "PRECIOUS hand-written diagram section."
} >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
assert_file_has "prefix: unrelated 'Diagram' section preserved" "PRECIOUS hand-written diagram" "$R/CLAUDE.md"
assert_file_has "prefix: real block appended" "freshness-gated local replica" "$R/CLAUDE.md"
assert_file_has "prefix: Diagram heading still there" "## Working the Loop Diagram" "$R/CLAUDE.md"

# ---- 5h. exact-heading: a sibling "Notes" heading doesn't cause false duplicate --
R="$SCRATCH/sibling"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null   # seed the real block
printf '\n## Working the Loop Notes\n\nmy notes\n' >>"$R/CLAUDE.md"   # add a sibling
run "$R"; assert_eq "sibling: not a false duplicate refusal (rc=0 current)" 0 "$?"
assert_file_has "sibling: notes section intact" "my notes" "$R/CLAUDE.md"

# ---- 5i. success-on-failure: unwritable target dir → nonzero exit, file unchanged
# (mv/rename needs write on the DIRECTORY, not the file — so a read-only dir is the
# real failure mode; a read-only file alone would still be replaced by rename.)
R="$SCRATCH/ro"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
before="$(cat "$R/CLAUDE.md")"
chmod 0555 "$R"
run "$R" --fix >/dev/null 2>&1; rc=$?
chmod 0755 "$R"
[[ "$rc" -ne 0 ]] && pass "read-only dir: nonzero exit on failed write (rc=$rc)" || fail "read-only dir: exited 0 despite failed write"
assert_eq "read-only dir: file left unchanged" "$before" "$(cat "$R/CLAUDE.md")"

# ---- 5j. bridge w/ missing AGENTS.md → create AGENTS.md core, seed there --------
R="$SCRATCH/bridge-noag"; mkdir -p "$R"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"   # bridge, no AGENTS.md
run "$R" --fix >/dev/null
[[ -f "$R/AGENTS.md" ]] && pass "bridge-noag: AGENTS.md core created" || fail "bridge-noag: AGENTS.md not created"
assert_file_has "bridge-noag: block seeded into AGENTS.md" "Working the Loop" "$R/AGENTS.md"
assert_file_lacks "bridge-noag: block NOT put in thin bridge" "Working the Loop" "$R/CLAUDE.md"

# ---- 5k. CRLF file already carrying the block is detected as current, not churned
R="$SCRATCH/crlf"; mkdir -p "$R"
run "$R/lf-src" --fix >/dev/null 2>&1 || true   # (unused; just ensure seeder available)
printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null                        # seed as LF
# convert to CRLF and confirm it's still recognized as current (no spurious update)
awk 'BEGIN{ORS="\r\n"}{print}' "$R/CLAUDE.md" >"$R/CLAUDE.crlf" && mv "$R/CLAUDE.crlf" "$R/CLAUDE.md"
run "$R"; assert_eq "crlf: block recognized as current despite CRLF (rc=0)" 0 "$?"

# ---- 5l. CRLF *template* must not cause unbounded duplication -------------------
CRLF_TMPL="$SCRATCH/template.crlf.md"
awk 'BEGIN{ORS="\r\n"}{print}' "$TEMPLATE" >"$CRLF_TMPL"
R="$SCRATCH/crlftmpl"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
bash "$SCRIPT" --quiet --repo "$R" --template "$CRLF_TMPL" --fix >/dev/null
bash "$SCRIPT" --quiet --repo "$R" --template "$CRLF_TMPL" --fix >/dev/null   # run twice
assert_eq "crlf-template: exactly one block heading (no unbounded dup)" 1 "$(count_headings "$R/CLAUDE.md")"

# ---- 5m. template with a nested heading in the body → refuse (exit 3) -----------
BAD_TMPL="$SCRATCH/template.nested.md"
{
	echo "## Working the Loop (every agent — interactive too, not just skills)"; echo ""
	echo "intro — subscribe to the event log; 👍; local replica."; echo ""
	echo "### Nested heading that breaks the boundary"; echo ""; echo "body"
} >"$BAD_TMPL"
R="$SCRATCH/nestedtmpl"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"
bash "$SCRIPT" --quiet --repo "$R" --template "$BAD_TMPL" --fix >/dev/null 2>&1
assert_eq "nested-heading template: refused (exit 3)" 3 "$?"

# ---- 6. all three reflex markers land in the seeded doc ------------------------
for m in "subscribe to the event log" "👍" "local replica"; do
	assert_file_has "seeded markers: $m" "$m" "$SCRATCH/mono/CLAUDE.md"
done

echo ""
echo "ensure-agent-house-rules.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
