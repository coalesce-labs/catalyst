#!/usr/bin/env bash
# Tests for ensure-agent-house-rules.sh — the sentinel-based "Working the Loop" auto-seeder.
# Run: bash plugins/dev/scripts/__tests__/ensure-agent-house-rules.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/ensure-agent-house-rules.sh"
TEMPLATE="${REPO_ROOT}/plugins/dev/templates/agents-house-rules.md"
BEGIN='catalyst-house-rules:begin'
END='catalyst-house-rules:end'

FAILURES=0; PASSES=0
SCRATCH="$(mktemp -d)"; trap 'chmod -R u+rwx "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [[ -n "${2:-}" ]] && echo "    $2"; }
assert_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "expected='$2' actual='$3'"; }
has() { grep -qF "$2" "$3" && pass "$1" || fail "$1" "'$2' not in $3"; }
lacks() { grep -qF "$2" "$3" && fail "$1" "'$2' unexpectedly in $3" || pass "$1"; }
count() { local c; c="$(grep -cF "$2" "$1" 2>/dev/null)"; echo "${c:-0}"; }
run() { bash "$SCRIPT" --quiet --repo "$1" "${@:2}"; }

# 0. template integrity
[[ -f "$TEMPLATE" ]] && pass "template exists" || fail "template exists"
for m in "subscribe to the event log" "reaction, not a review object" "local replica"; do
	grep -qF "$m" "$TEMPLATE" && pass "template marker: $m" || fail "template marker: $m"
done
lacks "template has no standalone begin sentinel" "<!-- catalyst-house-rules:begin -->" "$TEMPLATE"

# 1. empty repo → AGENTS.md core + @AGENTS.md bridge, sentineled block in AGENTS.md
R="$SCRATCH/empty"; mkdir -p "$R"
run "$R"; assert_eq "empty: dry-run rc=10" 10 "$?"
[[ ! -e "$R/AGENTS.md" ]] && pass "empty: dry-run wrote nothing" || fail "empty: dry-run wrote a file"
run "$R" --fix; assert_eq "empty: --fix rc=0" 0 "$?"
has "empty: sentinel begin in AGENTS.md" "$BEGIN" "$R/AGENTS.md"
has "empty: sentinel end in AGENTS.md" "$END" "$R/AGENTS.md"
assert_eq "empty: CLAUDE.md is a bridge" "@AGENTS.md" "$(head -1 "$R/CLAUDE.md")"
lacks "empty: no block in CLAUDE bridge" "$BEGIN" "$R/CLAUDE.md"

# 2. bridge (CLAUDE @AGENTS.md line 1) → AGENTS.md
R="$SCRATCH/bridge"; mkdir -p "$R"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"; printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
run "$R" --fix >/dev/null
has "bridge: block in AGENTS.md" "$BEGIN" "$R/AGENTS.md"
lacks "bridge: CLAUDE untouched" "$BEGIN" "$R/CLAUDE.md"

# 3. monolithic CLAUDE → CLAUDE.md
R="$SCRATCH/mono"; mkdir -p "$R"; printf '# CLAUDE.md — Foo\n\n## Setup\nrun\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "mono: block in CLAUDE.md" "$BEGIN" "$R/CLAUDE.md"

# 4. idempotency
run "$R"; assert_eq "mono: second dry-run current (rc=0)" 0 "$?"
run "$R" --fix >/dev/null
assert_eq "mono: one begin sentinel" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"

# 5. update a stale sentineled block; surrounding preserved
R="$SCRATCH/upd"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "<!-- catalyst-house-rules:begin -->"; echo "## Working the Loop (old)"; echo ""; echo "OLD body"; echo "<!-- catalyst-house-rules:end -->"; echo ""; echo "## Later"; echo "keep"; } >"$R/CLAUDE.md"
run "$R"; assert_eq "update: dry-run rc=10" 10 "$?"
run "$R" --fix >/dev/null
assert_eq "update: one begin sentinel" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"
lacks "update: old body gone" "OLD body" "$R/CLAUDE.md"
has "update: new wording" "freshness-gated local replica" "$R/CLAUDE.md"
has "update: Later preserved" "keep" "$R/CLAUDE.md"

# 6. legacy migration: heading-only block → sentineled, surrounding preserved
R="$SCRATCH/legacy"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo ""; echo "OLD legacy body linear_read_ticket only"; echo ""; echo "## Later"; echo "keepme"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "legacy: now sentineled" "$BEGIN" "$R/CLAUDE.md"
assert_eq "legacy: one begin sentinel" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"
lacks "legacy: old body replaced" "OLD legacy body" "$R/CLAUDE.md"
has "legacy: Later preserved" "keepme" "$R/CLAUDE.md"
run "$R"; assert_eq "legacy: idempotent after migration (rc=0)" 0 "$?"

# 7. import-aware: CLAUDE imports @AGENTS.md NOT on line 1 → AGENTS.md
R="$SCRATCH/hdrimport"; mkdir -p "$R"
printf '# CLAUDE.md\n\nSee AGENTS.md below.\n\n@AGENTS.md\n' >"$R/CLAUDE.md"; printf '# AGENTS.md\n\n## What\nz\n' >"$R/AGENTS.md"
run "$R" --fix >/dev/null
has "hdrimport: block in AGENTS.md" "$BEGIN" "$R/AGENTS.md"
lacks "hdrimport: not in CLAUDE" "$BEGIN" "$R/CLAUDE.md"

# 8. heading reworded inside a sentineled block → updated in place, no duplicate
R="$SCRATCH/reword"; mkdir -p "$R"
run "$R" --fix >/dev/null   # seed clean first (empty repo path)
# now hand-reword the heading text inside the sentinels
perl -0pi -e 's/## Working the Loop \(every agent[^\n]*/## Working the Loop (REWORDED HEADING)/' "$R/AGENTS.md"
run "$R" --fix >/dev/null
assert_eq "reword: still one begin sentinel (no fleet-dup)" 1 "$(count "$R/AGENTS.md" "$BEGIN")"
has "reword: canonical heading restored" "every agent — interactive too" "$R/AGENTS.md"

# 9. fenced code block showing the heading is NOT mistaken for a legacy block
R="$SCRATCH/fence"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo '```md'; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo '```'; echo ""; echo "## Real"; echo "real"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "fence: fenced sample preserved" '```md' "$R/CLAUDE.md"
has "fence: real block appended (sentineled)" "$BEGIN" "$R/CLAUDE.md"
has "fence: Real section preserved" "real" "$R/CLAUDE.md"

# 10. trailing prose after a sentineled block (no heading) preserved on update
R="$SCRATCH/prose"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "<!-- catalyst-house-rules:begin -->"; echo "## Working the Loop (old)"; echo "old"; echo "<!-- catalyst-house-rules:end -->"; echo ""; echo "TRAILING prose no heading"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "prose: trailing prose preserved" "TRAILING prose" "$R/CLAUDE.md"
has "prose: block updated" "freshness-gated local replica" "$R/CLAUDE.md"

# 11. setext heading after a legacy block preserved on migration
R="$SCRATCH/setext"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "oldbody"; echo ""; echo "Setext Title"; echo "==========="; echo "under setext"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "setext: setext title preserved" "Setext Title" "$R/CLAUDE.md"
has "setext: setext content preserved" "under setext" "$R/CLAUDE.md"

# 12. symlink target: symlink preserved, underlying shared file updated
R="$SCRATCH/symlink"; mkdir -p "$R" "$R/shared"
printf '# shared CLAUDE\n\n## Setup\nx\n' >"$R/shared/CLAUDE.md"
ln -s shared/CLAUDE.md "$R/CLAUDE.md"
run "$R" --fix >/dev/null
[[ -L "$R/CLAUDE.md" ]] && pass "symlink: CLAUDE.md still a symlink" || fail "symlink: replaced with regular file"
has "symlink: shared target updated" "$BEGIN" "$R/shared/CLAUDE.md"

# 13. permission preservation (mode read GNU-first then BSD — `stat -f` means
# something different on GNU/Linux and would return the wrong value)
R="$SCRATCH/perm"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"; chmod 0640 "$R/CLAUDE.md"
run "$R" --fix >/dev/null
mode="$(stat -c '%a' "$R/CLAUDE.md" 2>/dev/null || stat -f '%Lp' "$R/CLAUDE.md" 2>/dev/null)"
assert_eq "perm: mode preserved (640)" "640" "$mode"

# 14. write into a read-only DIR → nonzero exit, unchanged. (The atomic path stages
# a temp in the same dir and renames, so a read-only DIR is the real failure mode.)
# Skipped under root: DAC perms don't stop uid 0, so it can't be provoked in root CI.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
	echo "  SKIP: read-only-dir test (running as root — perms don't apply)"
else
	R="$SCRATCH/ro"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"; before="$(cat "$R/CLAUDE.md")"
	chmod 0555 "$R"; run "$R" --fix >/dev/null 2>&1; rc=$?; chmod 0755 "$R"
	[[ "$rc" -ne 0 ]] && pass "read-only dir: nonzero exit (rc=$rc)" || fail "read-only dir: exited 0"
	assert_eq "read-only dir: unchanged" "$before" "$(cat "$R/CLAUDE.md")"
fi

# 14b. legacy migration boundary honors a CommonMark-indented ATX heading
R="$SCRATCH/indent"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "oldbody"; echo ""; echo "   ## Indented Local Notes"; echo "PRECIOUS indented-heading content"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "indent: indented heading preserved" "## Indented Local Notes" "$R/CLAUDE.md"
has "indent: content after preserved" "PRECIOUS indented-heading content" "$R/CLAUDE.md"
has "indent: block migrated" "$BEGIN" "$R/CLAUDE.md"

# 15. duplicate sentinels → refuse exit 4
R="$SCRATCH/dup"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo "<!-- catalyst-house-rules:begin -->"; echo "a"; echo "<!-- catalyst-house-rules:end -->"; echo "<!-- catalyst-house-rules:begin -->"; echo "b"; echo "<!-- catalyst-house-rules:end -->"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null 2>&1; assert_eq "duplicate sentinels: refuse (rc=4)" 4 "$?"

# 16. CRLF target recognized as current (no dup)
R="$SCRATCH/crlf"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
awk 'BEGIN{ORS="\r\n"}{print}' "$R/CLAUDE.md" >"$R/c" && mv "$R/c" "$R/CLAUDE.md"
run "$R"; assert_eq "crlf target: current despite CRLF (rc=0)" 0 "$?"

# 17. CRLF template → no unbounded dup
CT="$SCRATCH/tmpl.crlf"; awk 'BEGIN{ORS="\r\n"}{print}' "$TEMPLATE" >"$CT"
R="$SCRATCH/crlft"; mkdir -p "$R"; printf '# CLAUDE.md\n\n## Setup\nx\n' >"$R/CLAUDE.md"
bash "$SCRIPT" --quiet --repo "$R" --template "$CT" --fix >/dev/null
bash "$SCRIPT" --quiet --repo "$R" --template "$CT" --fix >/dev/null
assert_eq "crlf template: one begin sentinel" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"

# 18. nested-heading template → refuse
BT="$SCRATCH/tmpl.nested"; { echo "## Working the Loop (t)"; echo ""; echo "subscribe to the event log; reaction, not a review object; local replica."; echo ""; echo "### nested"; echo "x"; } >"$BT"
R="$SCRATCH/nested"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"
bash "$SCRIPT" --quiet --repo "$R" --template "$BT" --fix >/dev/null 2>&1; assert_eq "nested-heading template: refuse (rc=3)" 3 "$?"

# 19. bad --template → exit 3, names path
R="$SCRATCH/badt"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"
out="$(bash "$SCRIPT" --repo "$R" --template /no/such/xyz.md --fix 2>&1)"; assert_eq "bad --template: exit 3" 3 "$?"
grep -qF "/no/such/xyz.md" <<<"$out" && pass "bad --template: names path" || fail "bad --template: names path" "$out"

# 20. collapse trailing blank lines on append
R="$SCRATCH/blanks"; mkdir -p "$R"; printf '# CLAUDE.md\n\n\n\n' >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
python3 - "$R/CLAUDE.md" <<'PY' && pass "blanks: exactly one blank line before block" || fail "blanks: collapse trailing blanks"
import sys
t=open(sys.argv[1]).read(); i=t.find("<!-- catalyst-house-rules:begin")
sys.exit(0 if i>=2 and t[i-2:i]=="\n\n" and t[i-3:i-2]!="\n" else 1)
PY

# 21. seeded markers present
R="$SCRATCH/markers"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"; run "$R" --fix >/dev/null
for m in "subscribe to the event log" "reaction, not a review object" "local replica"; do
	has "seeded marker: $m" "$m" "$R/CLAUDE.md"
done

# 22. the seeded block carries NO leaked maintainer comment/prose (P1 regression:
# an inline --> in the template comment must not terminate the strip early)
R="$SCRATCH/clean"; mkdir -p "$R"; printf '# CLAUDE.md\n' >"$R/CLAUDE.md"; run "$R" --fix >/dev/null
inner="$(awk '/catalyst-house-rules:begin/{g=1;next} /catalyst-house-rules:end/{g=0} g' "$R/CLAUDE.md")"
grep -qE '<!--|-->' <<<"$inner" && fail "clean: no residual HTML-comment markers in block" || pass "clean: no residual HTML-comment markers in block"
grep -qF 'the seeder and' <<<"$inner" && fail "clean: no leaked maintainer prose in block" || pass "clean: no leaked maintainer prose in block"
[[ "$(printf '%s\n' "$inner" | head -1)" == '## Working the Loop'* ]] && pass "clean: block starts with the heading" || fail "clean: block starts with the heading" "got: $(printf '%s\n' "$inner" | head -1)"

# 23. legacy duplicate headings → refuse (exit 4), don't half-migrate
R="$SCRATCH/legdup"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "a"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "b"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null 2>&1; assert_eq "legacy duplicate: refuse (rc=4)" 4 "$?"
assert_eq "legacy duplicate: untouched (no sentinel added)" 0 "$(count "$R/CLAUDE.md" "$BEGIN")"

# 24. unpaired begin sentinel → refuse (would otherwise delete to EOF on replace)
R="$SCRATCH/unpaired"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo "<!-- catalyst-house-rules:begin -->"; echo "## Working the Loop (x)"; echo "body"; echo ""; echo "## Important user section"; echo "MUST NOT be deleted"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null 2>&1; assert_eq "unpaired sentinel: refuse (rc=4)" 4 "$?"
has "unpaired sentinel: user section intact" "MUST NOT be deleted" "$R/CLAUDE.md"

# 25. a fully-sentineled block INSIDE a fenced example is not the live block
R="$SCRATCH/fencesent"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo '```md'; echo "<!-- catalyst-house-rules:begin -->"; echo "## Working the Loop (doc example)"; echo "<!-- catalyst-house-rules:end -->"; echo '```'; echo ""; echo "## Real"; echo "real"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "fenced-sentinel: example preserved" "doc example" "$R/CLAUDE.md"
assert_eq "fenced-sentinel: a real (live) block was added" 2 "$(count "$R/CLAUDE.md" "$BEGIN")"

# 26. a legacy heading inside an HTML comment is not treated as live
R="$SCRATCH/comhead"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "<!--"; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "example in a comment"; echo "-->"; echo ""; echo "## Real"; echo "real"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "comment-heading: comment example intact" "example in a comment" "$R/CLAUDE.md"
has "comment-heading: real block appended" "$BEGIN" "$R/CLAUDE.md"

# 27. 4-backtick fence containing a triple-backtick line is one fence (no mis-toggle)
R="$SCRATCH/bt4"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo '````md'; echo '```'; echo "@AGENTS.md"; echo '```'; echo '````'; echo ""; echo "## Real"; echo "r"; } >"$R/CLAUDE.md"
# the @AGENTS.md inside the 4-backtick fence must NOT be read as a live bridge import,
# so this monolithic CLAUDE.md is targeted (block lands in CLAUDE.md, no AGENTS.md made)
run "$R" --fix >/dev/null
has "bt4: block in CLAUDE.md (fenced @AGENTS.md ignored)" "$BEGIN" "$R/CLAUDE.md"
[[ ! -e "$R/AGENTS.md" ]] && pass "bt4: no AGENTS.md created (fenced import ignored)" || fail "bt4: AGENTS.md wrongly created"

# 28. large doc, legacy heading near the top, boundary present → detected + migrated
# (guards against a pipefail/SIGPIPE detection miss on a big file)
R="$SCRATCH/big"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "oldbody"; echo ""; echo "## After"; for i in $(seq 1 4000); do echo "filler line $i lorem ipsum dolor sit amet"; done; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
assert_eq "big-doc: legacy heading detected+migrated (1 sentinel, not appended)" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"
has "big-doc: content after boundary preserved" "filler line 4000" "$R/CLAUDE.md"

# 29. legacy block with NO boundary within the cap → refuse (no over-deletion)
R="$SCRATCH/nobound"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "## Working the Loop (every agent — interactive too, not just skills)"; echo "oldbody"; for i in $(seq 1 100); do echo "PRECIOUS un-headed line $i"; done; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null 2>&1; assert_eq "no-boundary: refuse migration (rc=4)" 4 "$?"
assert_eq "no-boundary: no sentinel added" 0 "$(count "$R/CLAUDE.md" "$BEGIN")"
has "no-boundary: un-headed content preserved" "PRECIOUS un-headed line 100" "$R/CLAUDE.md"

# 30. an inline (non-fenced) sentinel MENTION in prose is not a live managed block
R="$SCRATCH/inlinesent"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo 'The block is wrapped in `<!-- catalyst-house-rules:begin -->` markers.'; echo ""; echo "## Real"; echo "real"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
has "inline-mention: real (whole-line) block added" "$BEGIN" "$R/CLAUDE.md"
# exactly one whole-line begin sentinel (the live one), plus the inline mention untouched
assert_eq "inline-mention: one whole-line begin sentinel" 1 "$(grep -Fxc '<!-- catalyst-house-rules:begin -->' "$R/CLAUDE.md")"
has "inline-mention: prose mention preserved" 'wrapped in `<!-- catalyst-house-rules:begin -->`' "$R/CLAUDE.md"

# 31. an indented (≤3 space) legacy heading is migrated in place, not duplicated
R="$SCRATCH/indlegacy"; mkdir -p "$R"
{ echo "# CLAUDE.md"; echo ""; echo "  ## Working the Loop (every agent — interactive too, not just skills)"; echo "oldbody"; echo ""; echo "## After"; echo "keep"; } >"$R/CLAUDE.md"
run "$R" --fix >/dev/null
assert_eq "indented-legacy: migrated in place (one sentinel)" 1 "$(count "$R/CLAUDE.md" "$BEGIN")"
lacks "indented-legacy: old body replaced" "oldbody" "$R/CLAUDE.md"
has "indented-legacy: After preserved" "keep" "$R/CLAUDE.md"

echo ""
echo "ensure-agent-house-rules.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
