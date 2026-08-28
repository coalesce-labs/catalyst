#!/usr/bin/env bash
# md-reflow.test.sh — CTL-2253's scanner/joiner, one fixture per axis.
#
# Structural-preservation + hazard-quarantine + discrimination + contract cases. Join-shaped
# expectations are built from the SAME bash variables used to construct the fixture (via printf),
# never hand-retyped, so there is no transcription drift between input and expected output.
# Passthrough-shaped expectations (hazards, fences, frontmatter) are simply "output == input",
# asserted with diff — trivially correct by construction, no separate expected string needed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$SCRIPT_DIR/../md-reflow.mjs"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

# A single space + 91 'z's — appended to any line that must clear the 70-char wrap floor,
# regardless of its natural wording. Removes manual character-counting from every fixture below.
PAD=" zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"

reflow_file() { node "$MODULE" "$1"; }
check_file() { node "$MODULE" --check "$1"; }

assert_files_equal() {
	local desc="$1" expected="$2" actual="$3"
	if diff -q "$expected" "$actual" >/dev/null 2>&1; then
		pass "$desc"
	else
		fail "$desc" "$(diff "$expected" "$actual" 2>&1)"
	fi
}

assert_unchanged() {
	local desc="$1" original="$2" after_run="$3"
	assert_files_equal "$desc" "$original" "$after_run"
}

echo "=== case 1: plain 3-line wrapped paragraph joins to one line with single spaces ==="
L1="This is the first line of a plain wrapped paragraph.$PAD"
L2="This is the second line continuing the same paragraph.$PAD"
L3="Final short line."
IN="$SCRATCH/case1.md"
EXP="$SCRATCH/case1.expected.md"
printf '%s\n%s\n%s\n' "$L1" "$L2" "$L3" >"$IN"
printf '%s %s %s\n' "$L1" "$L2" "$L3" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "3-line paragraph joins with single spaces" "$EXP" "$IN"

echo ""
echo "=== case 2: indented list-item continuation joins, keeping its original indentation ==="
INDENT="  "
L1="This is a continuation paragraph indented to match its parent list item.$PAD"
L2="It keeps wrapping across another indented physical line here.$PAD"
L3="Final indented line."
IN="$SCRATCH/case2.md"
EXP="$SCRATCH/case2.expected.md"
printf '%s%s\n%s%s\n%s%s\n' "$INDENT" "$L1" "$INDENT" "$L2" "$INDENT" "$L3" >"$IN"
printf '%s%s %s %s\n' "$INDENT" "$L1" "$L2" "$L3" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "indented continuation joins with original indentation preserved" "$EXP" "$IN"
if grep -qxF "${INDENT}${L1} ${L2} ${L3}" "$IN"; then
	pass "joined line's leading whitespace is pinned exactly to two spaces"
else
	fail "joined line's leading whitespace is pinned exactly to two spaces" "$(cat "$IN")"
fi

echo ""
echo "=== case 3: YAML frontmatter with a wrapped description folded scalar is byte-identical ==="
IN="$SCRATCH/case3.md"
cat >"$IN" <<'MDEOF'
---
name: example
description: >
  This wraps across
  multiple lines but must not be touched even though it looks like a wrap candidate okay yes
---
Body paragraph text here that stands alone as a single line without any wrap issues at all.
MDEOF
cp "$IN" "$SCRATCH/case3.orig.md"
reflow_file "$IN" >/dev/null
assert_unchanged "frontmatter (incl. wrapped description scalar) is byte-identical" "$SCRATCH/case3.orig.md" "$IN"

echo ""
echo "=== case 4: fenced code untouched — 3-backtick / 4-backtick nesting / ~~~ ==="
IN="$SCRATCH/case4.md"
cat >"$IN" <<'MDEOF'
Some intro paragraph line that stands alone before the fenced examples begin right here.

```text
first line inside a three backtick fence that is definitely over seventy chars long yes
second line inside the same fence also fairly long to mimic wrap-like content potentially
```

````text
outer four-backtick fence start
```
nested three-backtick example line that is long enough to look wrap-like but must not join
```
outer four-backtick fence continues after the nested example above finishes right here okay
````

~~~text
tilde fenced content line that is intentionally long enough to mimic wrap-like prose yes
second tilde-fenced line also fairly long to further mimic a wrap candidate scenario okay
~~~

Trailing paragraph line that also stands alone after all the fenced examples above end.
MDEOF
cp "$IN" "$SCRATCH/case4.orig.md"
reflow_file "$IN" >/dev/null
assert_unchanged "fenced code (3-tick, nested 4-tick, ~~~) is byte-identical" "$SCRATCH/case4.orig.md" "$IN"

echo ""
echo "=== case 5: table / blockquote / heading / thematic break flush the run and pass through ==="
P1A="Intro paragraph line one that is long enough to look like a wrap candidate.$PAD"
P1B="Intro paragraph line two continuing on to complete the two line block.$PAD"
P2A="Closing paragraph line one that is long enough to look wrap-like too.$PAD"
P2B="Closing paragraph line two finishing off the block after the thematic break.$PAD"
IN="$SCRATCH/case5.md"
EXP="$SCRATCH/case5.expected.md"
{
	printf '%s\n%s\n' "$P1A" "$P1B"
	printf '| Column A | Column B |\n| --- | --- |\n'
	printf '> Blockquote line that also happens to be fairly long.%s\n' "$PAD"
	printf '# A Heading That Is Also Somewhat Long For Testing Purposes\n'
	printf -- '---\n'
	printf '%s\n%s\n' "$P2A" "$P2B"
} >"$IN"
{
	printf '%s %s\n' "$P1A" "$P1B"
	printf '| Column A | Column B |\n| --- | --- |\n'
	printf '> Blockquote line that also happens to be fairly long.%s\n' "$PAD"
	printf '# A Heading That Is Also Somewhat Long For Testing Purposes\n'
	printf -- '---\n'
	printf '%s %s\n' "$P2A" "$P2B"
} >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "table/blockquote/heading/thematic-break bound joins correctly and pass through untouched" "$EXP" "$IN"

echo ""
echo "=== case 6: a continuation line beginning with '1. ' is NOT joined (list opener wins) ==="
IN="$SCRATCH/case6.md"
cat >"$SCRATCH/case6.orig.md" <<EOF
Paragraph line one that is long enough to qualify as a wrap candidate for sure.$PAD
1. This looks like it could continue the paragraph above but it opens a list instead
EOF
cp "$SCRATCH/case6.orig.md" "$IN"
reflow_file "$IN" >/dev/null
assert_unchanged "ordered-list opener is never absorbed into the preceding paragraph" "$SCRATCH/case6.orig.md" "$IN"

echo ""
echo "=== case 7: a code span split across a wrap boundary joins with exactly one space ==="
L1="Use the flag like \`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx$PAD"
L2="yy\` when configuring the tool for this particular use case."
IN="$SCRATCH/case7.md"
EXP="$SCRATCH/case7.expected.md"
printf '%s\n%s\n' "$L1" "$L2" >"$IN"
printf '%s %s\n' "$L1" "$L2" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "code span split across the wrap boundary joins with exactly one space" "$EXP" "$IN"

echo ""
echo "=== case 8: kv-metadata hazard — bare Trigger:/Target: lines are quarantined ==="
IN="$SCRATCH/case8.md"
cat >"$SCRATCH/case8.orig.md" <<EOF
# Some Heading
Trigger: something happens here that is fairly descriptive and lengthy.$PAD
Target: the destination or object affected by the trigger above.
EOF
cp "$SCRATCH/case8.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "kv-metadata block is left unchanged" "$SCRATCH/case8.orig.md" "$IN"
if grep -q "hazard=kv-metadata" <<<"$OUT"; then
	pass "kv-metadata hazard reported by name"
else
	fail "kv-metadata hazard reported by name" "$OUT"
fi

echo ""
echo "=== case 9: adjacent-bold-lead hazard — two adjacent '**' lines are quarantined ==="
IN="$SCRATCH/case9.md"
cat >"$SCRATCH/case9.orig.md" <<EOF
**Use something when:** this condition holds and continues on for a while.$PAD
**Use another mode when:** this other condition holds and also continues on.$PAD
EOF
cp "$SCRATCH/case9.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "adjacent-bold-lead block is left unchanged" "$SCRATCH/case9.orig.md" "$IN"
if grep -q "hazard=adjacent-bold-lead" <<<"$OUT"; then
	pass "adjacent-bold-lead hazard reported by name"
else
	fail "adjacent-bold-lead hazard reported by name" "$OUT"
fi

echo ""
echo "=== case 10: html-comment hazard — a multi-line <!-- --> block is quarantined ==="
IN="$SCRATCH/case10.md"
cat >"$SCRATCH/case10.orig.md" <<EOF
<!-- This is a comment that continues on for a while past the wrap threshold.$PAD
     and continues here on a second indented line before closing the comment -->
EOF
cp "$SCRATCH/case10.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "html-comment block is left unchanged" "$SCRATCH/case10.orig.md" "$IN"
if grep -q "hazard=html-comment" <<<"$OUT"; then
	pass "html-comment hazard reported by name (beats mixed-indent precedence)"
else
	fail "html-comment hazard reported by name (beats mixed-indent precedence)" "$OUT"
fi

echo ""
echo "=== case 11: mixed-indent hazard — a block whose lines disagree on indentation ==="
IN="$SCRATCH/case11.md"
cat >"$SCRATCH/case11.orig.md" <<EOF
Some paragraph starting flush left that continues on for quite a while.$PAD
    then a line that for some reason is indented further than the first line was
EOF
cp "$SCRATCH/case11.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "mixed-indent block is left unchanged" "$SCRATCH/case11.orig.md" "$IN"
if grep -q "hazard=mixed-indent" <<<"$OUT"; then
	pass "mixed-indent hazard reported by name"
else
	fail "mixed-indent hazard reported by name" "$OUT"
fi

echo ""
echo "=== case 12: discrimination — bold-lead OPENER whose followers aren't bold IS joined ==="
L1="**Stay in the wait.** This is additional explanatory prose that keeps going.$PAD"
L2="It closes here without any of the following lines opening with bold markers."
IN="$SCRATCH/case12.md"
EXP="$SCRATCH/case12.expected.md"
printf '%s\n%s\n' "$L1" "$L2" >"$IN"
printf '%s %s\n' "$L1" "$L2" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "bold-lead opener with non-bold followers joins normally (not over-quarantined)" "$EXP" "$IN"

echo ""
echo "=== case 13: discrimination — a trailing standalone '**bold**' line IS joined ==="
L1="This is a lead-in sentence that continues across the wrap boundary for a while.$PAD"
L2="**Stay in the wait.**"
IN="$SCRATCH/case13.md"
EXP="$SCRATCH/case13.expected.md"
printf '%s\n%s\n' "$L1" "$L2" >"$IN"
printf '%s %s\n' "$L1" "$L2" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "trailing standalone bold line joins normally (not over-quarantined)" "$EXP" "$IN"

echo ""
echo "=== case 14: reflowFile on already-reflowed text is a no-op (idempotence) ==="
IN="$SCRATCH/case14.md"
cp "$SCRATCH/case1.expected.md" "$IN"
cp "$IN" "$SCRATCH/case14.orig.md"
OUT="$(check_file "$IN")"
RC=$?
assert_unchanged "already-joined text is unchanged by a second pass" "$SCRATCH/case14.orig.md" "$IN"
if [[ $RC -eq 0 ]]; then
	pass "--check exits 0 on an already-reflowed file"
else
	fail "--check exits 0 on an already-reflowed file" "rc=$RC" "$OUT"
fi
if grep -q "^0/1 files, 0 blocks, 0 hazards$" <<<"$OUT"; then
	pass "already-reflowed file reports zero blocks"
else
	fail "already-reflowed file reports zero blocks" "$OUT"
fi

echo ""
echo "=== case 15: refusal on content drift — the identity guard actually fires ==="
POS_OUT="$(node -e "
import('$MODULE').then((m) => {
  try {
    m.assertContentIdentical('foo bar baz', 'foo   bar\tbaz');
    console.log('NO_THROW');
  } catch (e) {
    console.log('THREW');
  }
});
")"
if [[ "$POS_OUT" == "NO_THROW" ]]; then
	pass "assertContentIdentical does not throw on whitespace-only differences (positive control)"
else
	fail "assertContentIdentical does not throw on whitespace-only differences (positive control)" "$POS_OUT"
fi

NEG_OUT="$(node -e "
import('$MODULE').then((m) => {
  try {
    m.assertContentIdentical('foo bar baz', 'foo bar quux');
    console.log('NO_THROW');
  } catch (e) {
    console.log('THREW');
  }
});
")"
if [[ "$NEG_OUT" == "THREW" ]]; then
	pass "assertContentIdentical throws on a genuine content mismatch (the refusal guard fires)"
else
	fail "assertContentIdentical throws on a genuine content mismatch (the refusal guard fires)" "$NEG_OUT"
fi

echo ""
echo "=== case 16: corpus census — the real plugins/dev candidate files report exactly the expected hazards ==="
# CTL-2253 Phase 3: after the six hazard blocks were resolved by hand (five joined/reformatted,
# one — concierge/references/scaffold.md's Trigger:/Target: pair — deliberately left as
# line-oriented metadata), only that one block should still report as a hazard anywhere in the
# 178-file candidate corpus. This pins the census so a future edit that reintroduces a hazard
# (or silently "fixes" the scanner into missing one) fails loudly here instead of being
# auto-joined on the next sweep.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
mapfile -t CANDIDATES < <(
	cd "$REPO_ROOT" && {
		find plugins/dev/skills -iname "SKILL.md"
		find plugins/dev/skills -path "*/references/*.md"
		find plugins/dev/references -maxdepth 1 -name "*.md"
		find plugins/dev/templates -maxdepth 1 -name "*.md"
		find plugins/dev/agents -maxdepth 1 -name "*.md"
	} | sort -u
)
CORPUS_OUT="$(cd "$REPO_ROOT" && node "$MODULE" --check "${CANDIDATES[@]}" 2>&1)"
HAZARD_LINES="$(grep -c '^plugins/.*: hazard=' <<<"$CORPUS_OUT" || true)"
if [[ "$HAZARD_LINES" -eq 1 ]]; then
	pass "corpus reports exactly one remaining hazard"
else
	fail "corpus reports exactly one remaining hazard" "found $HAZARD_LINES" "$(grep '^plugins/.*: hazard=' <<<"$CORPUS_OUT")"
fi
if grep -qxF "plugins/dev/skills/concierge/references/scaffold.md: hazard=kv-metadata" <<<"$CORPUS_OUT"; then
	pass "the one remaining hazard is scaffold.md's kv-metadata (deliberately retained)"
else
	fail "the one remaining hazard is scaffold.md's kv-metadata (deliberately retained)" "$CORPUS_OUT"
fi
# The other four files hand-resolved in Phase 3 (phase-plan/phase-research/phase-review/
# phase-verify SKILL.md) were removed wholesale by CTL-2239 (#4071) — asserting "no hazard" on a
# path that no longer exists would pass vacuously, so only the still-live file is checked here.
if [[ ! -e "$REPO_ROOT/plugins/dev/skills/phase-plan/SKILL.md" ]]; then
	pass "the four retired phase-*/SKILL.md hand-resolutions were removed by CTL-2239, not silently revived"
else
	fail "the four retired phase-*/SKILL.md hand-resolutions were removed by CTL-2239, not silently revived" "plugins/dev/skills/phase-plan/SKILL.md still exists"
fi
f="plugins/dev/skills/create-plan/SKILL.md"
if grep -q "^$f: hazard=" <<<"$CORPUS_OUT"; then
	fail "$f carries no hazard (resolved by hand in Phase 3)" "$(grep "^$f:" <<<"$CORPUS_OUT")"
else
	pass "$f carries no hazard (resolved by hand in Phase 3)"
fi

echo ""
echo "=== case 17: hard-break hazard — a trailing two-space marker is quarantined ==="
IN="$SCRATCH/case17.md"
L1="This is a paragraph line that ends in an explicit hard break marker right here.$PAD  "
L2="This second line must stay on its own physical line, not get folded into the first."
printf '%s\n%s\n' "$L1" "$L2" >"$SCRATCH/case17.orig.md"
cp "$SCRATCH/case17.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "hard-break (two trailing spaces) block is left unchanged" "$SCRATCH/case17.orig.md" "$IN"
if grep -q "hazard=hard-break" <<<"$OUT"; then
	pass "hard-break hazard reported by name (two-space marker)"
else
	fail "hard-break hazard reported by name (two-space marker)" "$OUT"
fi

echo ""
echo "=== case 18: hard-break hazard — a trailing backslash marker is quarantined ==="
IN="$SCRATCH/case18.md"
cat >"$SCRATCH/case18.orig.md" <<EOF
This is a paragraph line that ends in a backslash hard break marker right here.$PAD\\
This second line must stay on its own physical line, not get folded into the first.
EOF
cp "$SCRATCH/case18.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "hard-break (trailing backslash) block is left unchanged" "$SCRATCH/case18.orig.md" "$IN"
if grep -q "hazard=hard-break" <<<"$OUT"; then
	pass "hard-break hazard reported by name (backslash marker)"
else
	fail "hard-break hazard reported by name (backslash marker)" "$OUT"
fi

echo ""
echo "=== case 19: discrimination — a single trailing space is NOT a hard break and still joins ==="
L1="This paragraph line ends in exactly one trailing space which is not a break marker.$PAD "
L2="This second line completes the ordinary wrapped paragraph without any break intent."
IN="$SCRATCH/case19.md"
EXP="$SCRATCH/case19.expected.md"
printf '%s\n%s\n' "$L1" "$L2" >"$IN"
printf '%s %s\n' "${L1% }" "$L2" >"$EXP"
reflow_file "$IN" >/dev/null
assert_files_equal "a single trailing space is not treated as a hard break (not over-quarantined)" "$EXP" "$IN"

echo ""
echo "=== case 20: indented-code hazard — a uniformly >=4-column indented run is quarantined ==="
IN="$SCRATCH/case20.md"
cat >"$SCRATCH/case20.orig.md" <<EOF
    this is a long command line inside an indented code block well past seventy chars wide.$PAD
    a second long line inside the same indented code block, also past the wrap threshold.$PAD
EOF
cp "$SCRATCH/case20.orig.md" "$IN"
OUT="$(check_file "$IN")"
reflow_file "$IN" >/dev/null
assert_unchanged "indented-code block is left unchanged" "$SCRATCH/case20.orig.md" "$IN"
if grep -q "hazard=indented-code" <<<"$OUT"; then
	pass "indented-code hazard reported by name"
else
	fail "indented-code hazard reported by name" "$OUT"
fi

echo ""
echo "=== case 21: structural — a pipe-less table delimiter row is never joined with its header ==="
IN="$SCRATCH/case21.md"
cat >"$SCRATCH/case21.orig.md" <<EOF
Column A very long header name that goes past seventy characters total width here padding | Column B
--- | ---

Body text after the table.
EOF
cp "$SCRATCH/case21.orig.md" "$IN"
OUT="$(check_file "$IN")"
RC=$?
assert_unchanged "pipe-less table header/delimiter is left unchanged" "$SCRATCH/case21.orig.md" "$IN"
if [[ $RC -eq 0 ]]; then
	pass "pipe-less table header/delimiter forms no joinable block"
else
	fail "pipe-less table header/delimiter forms no joinable block" "rc=$RC" "$OUT"
fi

echo ""
echo "=== case 22: structural — a setext H1 '=' underline is never joined with its title ==="
IN="$SCRATCH/case22.md"
cat >"$SCRATCH/case22.orig.md" <<EOF
This Is A Setext Style Heading That Is Long Enough To Qualify For The Reflow Join Threshold
===

Body text.
EOF
cp "$SCRATCH/case22.orig.md" "$IN"
OUT="$(check_file "$IN")"
RC=$?
assert_unchanged "setext H1 title/underline is left unchanged" "$SCRATCH/case22.orig.md" "$IN"
if [[ $RC -eq 0 ]]; then
	pass "setext H1 title/underline forms no joinable block"
else
	fail "setext H1 title/underline forms no joinable block" "rc=$RC" "$OUT"
fi

echo ""
echo "=== case 23: structural — adjacent link-reference definitions are never joined ==="
IN="$SCRATCH/case23.md"
cat >"$SCRATCH/case23.orig.md" <<EOF
[label-one]: https://example.com/some/very/long/path/that/pushes/well/past/seventy/chars
[label-two]: https://example.com/other

Body text after the reference definitions.
EOF
cp "$SCRATCH/case23.orig.md" "$IN"
OUT="$(check_file "$IN")"
RC=$?
assert_unchanged "adjacent link-reference definitions are left unchanged" "$SCRATCH/case23.orig.md" "$IN"
if [[ $RC -eq 0 ]]; then
	pass "adjacent link-reference definitions form no joinable block"
else
	fail "adjacent link-reference definitions form no joinable block" "rc=$RC" "$OUT"
fi

echo ""
echo "=== summary ==="
echo "Passed: $PASSES"
echo "Failed: $FAILURES"

if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
