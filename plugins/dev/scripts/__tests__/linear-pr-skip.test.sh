#!/usr/bin/env bash
# CTL-623: unit tests for the linear-pr-skip sibling-guard helper.
# The helper emits Linear `skip <ID>` guard lines for every foreign ticket
# token found in the supplied text (branch name, PR body, …), so Linear's
# GitHub integration does not auto-link sibling tickets and drag their status.
# Run: bash plugins/dev/scripts/__tests__/linear-pr-skip.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/linear-pr-skip.sh"

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

if [[ ! -f "$HELPER" ]]; then
	fail "helper exists at lib/linear-pr-skip.sh"
	echo ""
	echo "PASSES=$PASSES FAILURES=$FAILURES"
	exit 1
fi
# shellcheck source=/dev/null
source "$HELPER"

# ─── Case A: multi-ticket phase-agents/legacy branch → siblings, own excluded ──
echo "▶ Case A: multi-ticket branch emits siblings, excludes own"
out=$(linear_sibling_skip_block "ADV-1155" "o-adv-1155-1156-1157-ADV-1155")
if grep -q "skip ADV-1156" <<<"$out" && grep -q "skip ADV-1157" <<<"$out" &&
	! grep -q "skip ADV-1155" <<<"$out"; then
	pass "A: siblings ADV-1156/ADV-1157 present, own ADV-1155 excluded"
else
	fail "A: siblings present and own excluded" "got: $out"
fi

# ─── Case B: single-ticket branch (own only) → empty output (no-op) ────────────
echo "▶ Case B: single-ticket branch is a no-op"
out=$(linear_sibling_skip_block "CTL-623" "CTL-623")
if [[ -z "$out" ]]; then
	pass "B: empty output for own-ticket-only branch"
else
	fail "B: empty output for own-ticket-only branch" "got: $out"
fi

# ─── Case C: dedup — same sibling repeated in branch + body emits once ─────────
echo "▶ Case C: dedup repeated sibling across args"
out=$(linear_sibling_skip_block "ADV-1155" "o-adv-1155-1156-ADV-1155" "builds on ADV-1156")
count=$(grep -c "skip ADV-1156" <<<"$out")
if [[ "$count" -eq 1 ]]; then
	pass "C: ADV-1156 emitted exactly once"
else
	fail "C: ADV-1156 emitted exactly once" "count=$count out: $out"
fi

# ─── Case D: case normalization — lowercase branch tokens → canonical UPPER ────
echo "▶ Case D: lowercase tokens normalize to uppercase"
out=$(linear_sibling_skip_block "ADV-1155" "o-adv-1155-1156-1157-ADV-1155")
if grep -q "skip ADV-1156" <<<"$out" && ! grep -q "skip adv-1156" <<<"$out"; then
	pass "D: lowercase adv-1156 normalized to ADV-1156"
else
	fail "D: lowercase adv-1156 normalized to ADV-1156" "got: $out"
fi

# ─── Case E: mixed-team slug → both foreign teams captured ─────────────────────
echo "▶ Case E: mixed-team slug captures foreign team"
out=$(linear_sibling_skip_block "ADV-1155" "o-adv-1155-ctl-200-ADV-1155")
if grep -q "skip CTL-200" <<<"$out" && ! grep -q "skip ADV-1155" <<<"$out"; then
	pass "E: foreign CTL-200 captured, own ADV-1155 excluded"
else
	fail "E: foreign CTL-200 captured, own ADV-1155 excluded" "got: $out"
fi

# ─── Case F: guard block carries the HTML comment marker ───────────────────────
echo "▶ Case F: output begins with the HTML comment guard marker"
out=$(linear_sibling_skip_block "ADV-1155" "o-adv-1155-1156-1157-ADV-1155")
first_line=$(head -1 <<<"$out")
if [[ "$first_line" == "<!-- Linear automation guard"* ]]; then
	pass "F: output begins with '<!-- Linear automation guard'"
else
	fail "F: output begins with '<!-- Linear automation guard'" "first line: $first_line"
fi

# ─── Case G: GitHub PR-number prose (#NNN) must NOT fabricate skip tokens ───────
# The plan's Phase-2 contract references siblings by GitHub PR number (#NNN),
# never bare Linear tokens. Bare numbers separated from words by whitespace/'#'
# must not be reattributed to a fake team prefix.
echo "▶ Case G: '#NNN' PR-number prose produces no skip lines"
out=$(linear_sibling_skip_block "CTL-623" "CTL-623" "see PR #890 and #892")
if [[ -z "$out" ]]; then
	pass "G: '#890 / #892' prose is a no-op"
else
	fail "G: '#890 / #892' prose is a no-op" "got: $out"
fi

# ─── Case H: explicit foreign TEAM-NNN token in body prose is still captured ───
echo "▶ Case H: explicit foreign token in prose is captured"
out=$(linear_sibling_skip_block "CTL-623" "CTL-623" "relates to ENG-50")
if grep -q "skip ENG-50" <<<"$out"; then
	pass "H: explicit ENG-50 captured from prose"
else
	fail "H: explicit ENG-50 captured from prose" "got: $out"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# CTL-633: scope-split adversarial cases (I–T). Tests the new
# linear_foreign_tokens_from_branch / _from_body and their wrapper
# linear_sibling_skip_block_from_branch / _from_body APIs. Cases A–H above
# remain unchanged — they exercise the back-compat default-branch-mode shim.
# ═══════════════════════════════════════════════════════════════════════════════

# Sandbox helper: every body-mode case that touches the allowlist needs its
# own XDG_CONFIG_HOME so the real ~/.config/catalyst/linear-team-keys.json
# (which may exist on a real workstation) cannot poison results.
TK_SANDBOX="$(mktemp -d)"
mkdir -p "$TK_SANDBOX/catalyst"
export XDG_CONFIG_HOME="$TK_SANDBOX"
trap 'chmod -R u+rw "$TK_SANDBOX" 2>/dev/null; rm -rf "$TK_SANDBOX"' EXIT

# ─── Case I: descriptive branch slug → only canonical token, no fabrication ───
echo "▶ Case I: descriptive branch slug does not fabricate"
out=$(linear_foreign_tokens_from_branch "CTL-623-migrate-oauth2-and-utf8-support")
if [[ "$out" == "CTL-623" ]]; then
	pass "I: only CTL-623 emitted (no OAUTH-2, no UTF-8)"
else
	fail "I: only CTL-623 emitted" "got: $out"
fi

# ─── Case N: single-digit real ticket in branch slug preserved ───────────────
echo "▶ Case N: single-digit real ticket preserved"
out=$(linear_foreign_tokens_from_branch "CTL-7-fix")
if [[ "$out" == "CTL-7" ]]; then
	pass "N: CTL-7 preserved (no [0-9]{2,} digit-floor regression)"
else
	fail "N: CTL-7 preserved" "got: $out"
fi

# ─── Case O: canonical orch slug → siblings via wrapper ──────────────────────
echo "▶ Case O: orch slug emits siblings via _from_branch wrapper"
out=$(linear_sibling_skip_block_from_branch "ADV-1155" "o-adv-1155-1156-1157-ADV-1155")
if grep -q '^skip ADV-1156$' <<<"$out" && grep -q '^skip ADV-1157$' <<<"$out" \
		&& ! grep -q '^skip ADV-1155$' <<<"$out"; then
	pass "O: siblings ADV-1156/1157, own excluded"
else
	fail "O: siblings + own excluded" "got: $out"
fi

# ─── Case J: prose alpha+num collisions → blocked by allowlist ───────────────
echo "▶ Case J: UTF-8/HTTP-2 in prose blocked when not in allowlist"
printf '{"keys":["CTL","ADV"]}\n' > "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_body "this implements UTF-8 and HTTP-2 encoding")
if [[ -z "$out" ]]; then
	pass "J: UTF/HTTP filtered out of canonical-shaped body tokens"
else
	fail "J: UTF/HTTP filtered" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

# ─── Case K: date in prose → no fabrication (canonical regex never matches) ──
echo "▶ Case K: dashed date prose does not fabricate"
out=$(linear_foreign_tokens_from_body "Released 2026-05-25")
if [[ -z "$out" ]]; then
	pass "K: no RELEASED-25 fabrication from prose"
else
	fail "K: no RELEASED-25 fabrication" "got: $out"
fi

# ─── Case L: pseudo-tokens abc123 / def456 → no fabrication ──────────────────
echo "▶ Case L: abc123 / def456 pseudo-tokens do not fabricate"
out=$(linear_foreign_tokens_from_body "abc123 def456 cleanup")
if [[ -z "$out" ]]; then
	pass "L: pseudo-tokens not captured"
else
	fail "L: pseudo-tokens not captured" "got: $out"
fi

# ─── Case M: API-v2 collision worst-case → no V-2 emission ───────────────────
echo "▶ Case M: API-v2 prose does not emit V-2"
out=$(linear_foreign_tokens_from_body "fixes API-v2 regression")
if [[ -z "$out" ]]; then
	pass "M: lowercase v2 breaks the canonical shape"
else
	fail "M: V-2 not fabricated" "got: $out"
fi

# ─── Case P: explicit canonical TEAM-NNN captured iff team in allowlist ──────
echo "▶ Case P: explicit canonical body token allowlisted → captured"
printf '{"keys":["ENG","CTL"]}\n' > "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_body "see also ENG-50 for context")
if [[ "$out" == "ENG-50" ]]; then
	pass "P: ENG-50 captured from prose when ENG is allowlisted"
else
	fail "P: ENG-50 captured (allowlisted)" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

# ─── Case P2: no cache → fail-open passthrough (backward-compat with Case H) ─
echo "▶ Case P2: no cache → fail-open canonical capture preserved"
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_body "see also ENG-50 for context")
if [[ "$out" == "ENG-50" ]]; then
	pass "P2: ENG-50 still captured with no cache (fail-open)"
else
	fail "P2: ENG-50 captured with no cache" "got: $out"
fi

# ─── Case Q: OAUTH-2 canonical-shape prose filtered when not allowlisted ─────
echo "▶ Case Q: OAUTH-2 in prose filtered when OAUTH not allowlisted"
printf '{"keys":["CTL"]}\n' > "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_body "OAUTH-2 isn't a real ticket")
if [[ -z "$out" ]]; then
	pass "Q: OAUTH-2 dropped by allowlist"
else
	fail "Q: OAUTH-2 dropped" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

# ─── Case R: date with trailing word in prose → no fabrication ───────────────
echo "▶ Case R: 'shipped 2026-05-25-final' produces no tokens"
out=$(linear_foreign_tokens_from_body "shipped 2026-05-25-final")
if [[ -z "$out" ]]; then
	pass "R: no fabrication from date+trailing-word"
else
	fail "R: no fabrication" "got: $out"
fi

# ─── Case S: malformed cache fails open silently ─────────────────────────────
echo "▶ Case S: malformed cache fails open"
printf 'not json\n' > "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_body "see also ENG-50")
if [[ "$out" == "ENG-50" ]]; then
	pass "S: malformed cache → fail open (ENG-50 captured)"
else
	fail "S: malformed cache fails open" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

# ─── Case T: branch-mode also filtered through allowlist (defense in depth) ──
echo "▶ Case T: branch-mode allowlist filters non-team segments"
printf '{"keys":["CTL"]}\n' > "$TK_SANDBOX/catalyst/linear-team-keys.json"
out=$(linear_foreign_tokens_from_branch "o-utf-8-9-CTL-200")
if ! grep -q '^UTF-' <<<"$out" && grep -q '^CTL-200$' <<<"$out"; then
	pass "T: branch-mode UTF-* dropped, CTL-200 retained"
else
	fail "T: branch-mode allowlist filter" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]]
