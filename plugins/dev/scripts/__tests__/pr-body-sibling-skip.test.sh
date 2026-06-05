#!/usr/bin/env bash
# CTL-623: contract + integration tests for wiring the linear-pr-skip guard into
# the three PR-body producers (create-pr, describe-pr, ci-describe-pr).
#
#   1. Prose-contract tests (grep-based, mirroring
#      phase-skill-no-linear-prose.test.sh): each SKILL.md must reference the
#      helper and carry the sibling-format rule (reference siblings by GitHub PR
#      number #NNN, never bare Linear tokens). describe-pr must keep the own
#      Fixes URL.
#   2. Assembled-body integration tests: source the helper, simulate the
#      create-pr body assembly against a multi-ticket branch (guard block + own
#      Refs present) and a single-ticket branch (no skip line).
#
# Run: bash plugins/dev/scripts/__tests__/pr-body-sibling-skip.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"
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

# ─── 1. Prose-contract tests ───────────────────────────────────────────────────
echo "Test: all three PR-body producers reference the helper + carry the format rule"
for skill in create-pr describe-pr ci-describe-pr; do
	f="${SKILLS_DIR}/${skill}/SKILL.md"
	if [[ ! -f "$f" ]]; then
		fail "${skill}/SKILL.md exists"
		continue
	fi

	# (a) references the helper script
	if grep -q 'linear-pr-skip\.sh' "$f"; then
		pass "${skill}: references linear-pr-skip.sh"
	else
		fail "${skill}: references linear-pr-skip.sh"
	fi

	# (b) carries the sibling-format rule: mentions skip/ignore AND references the
	#     #NNN PR-number convention / "do not ... bare" instruction.
	if grep -qiE 'skip|ignore' "$f" &&
		grep -qiE 'PR number|#NNN|do not.*bare|never.*bare' "$f"; then
		pass "${skill}: carries the sibling-format rule (#NNN, no bare tokens)"
	else
		fail "${skill}: carries the sibling-format rule (#NNN, no bare tokens)"
	fi
done

# (c) describe-pr keeps the own-ticket Fixes URL
echo "Test: describe-pr keeps the own-ticket Fixes URL"
DP="${SKILLS_DIR}/describe-pr/SKILL.md"
if grep -q 'Fixes https://linear.app' "$DP"; then
	pass "describe-pr keeps 'Fixes https://linear.app' (own-ticket link intended)"
else
	fail "describe-pr keeps 'Fixes https://linear.app' (own-ticket link intended)"
fi

# ─── 2. Assembled-body integration tests ───────────────────────────────────────
if [[ ! -f "$HELPER" ]]; then
	fail "helper exists for integration tests"
	echo ""
	echo "PASSES=$PASSES FAILURES=$FAILURES"
	exit 1
fi
# shellcheck source=/dev/null
source "$HELPER"

# Mirror the create-pr transient-body assembly (Refs + guard block).
assemble_body() {
	local ticket="$1" branch="$2"
	local body="## Changes

abc123 some commit

Refs: $ticket"
	local skip_block
	skip_block="$(linear_sibling_skip_block "$ticket" "$branch")"
	[[ -n "$skip_block" ]] && body="$body

$skip_block"
	printf '%s' "$body"
}

echo "Test: multi-ticket branch body carries guard block + own Refs"
body="$(assemble_body "ADV-1155" "o-adv-1155-1156-1157-ADV-1155")"
if grep -q '^Refs: ADV-1155$' <<<"$body" &&
	grep -q '<!-- Linear automation guard' <<<"$body" &&
	grep -q '^skip ADV-1156$' <<<"$body" &&
	grep -q '^skip ADV-1157$' <<<"$body" &&
	! grep -q '^skip ADV-1155$' <<<"$body"; then
	pass "multi-ticket: Refs + guard block (skip ADV-1156/1157, own excluded)"
else
	fail "multi-ticket: Refs + guard block present" "body: $body"
fi

echo "Test: single-ticket branch body has NO skip line (no-op preserved)"
body="$(assemble_body "CTL-623" "CTL-623-add-helper")"
if grep -q '^Refs: CTL-623$' <<<"$body" && ! grep -q 'skip ' <<<"$body" &&
	! grep -q 'Linear automation guard' <<<"$body"; then
	pass "single-ticket: Refs present, no skip line, no guard block"
else
	fail "single-ticket: no skip line" "body: $body"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# CTL-633: scope-split integration tests. Producers must call the mode-aware
# wrappers (branch ⇒ awk segmenter, body ⇒ canonical-only regex) so adversarial
# body prose can never fabricate `skip TEAM-NNN` lines.
# ═══════════════════════════════════════════════════════════════════════════════

# Sandbox the team-key cache for these cases — without a clean XDG_CONFIG_HOME
# a real workstation's allowlist would skew results.
TK_SANDBOX_INT="$(mktemp -d)"
mkdir -p "$TK_SANDBOX_INT/catalyst"
export XDG_CONFIG_HOME="$TK_SANDBOX_INT"
trap 'chmod -R u+rw "$TK_SANDBOX_INT" 2>/dev/null; rm -rf "$TK_SANDBOX_INT"' EXIT

# ─── Case I-int: describe-pr-shaped branch+body invocation ────────────────────
# Allowlist contains only ADV so canonical-shape UTF-8 / OAUTH-2 from body
# prose are filtered out by Layer 2 (team-key allowlist).
echo "Test: describe-pr-shaped branch+body invocation (no body fabrication)"
printf '{"keys":["ADV","CTL"]}\n' > "$TK_SANDBOX_INT/catalyst/linear-team-keys.json"
branch="o-adv-1155-1156-1157-ADV-1155"
body=$'## Summary\n\nFixes UTF-8 handling and the OAUTH-2 flow.\n\nSee ENG-50 for context.'
out=$( {
	linear_sibling_skip_block_from_branch "ADV-1155" "$branch"
	linear_sibling_skip_block_from_body   "ADV-1155" "$body"
} )
if grep -q '^skip ADV-1156$' <<<"$out" \
		&& grep -q '^skip ADV-1157$' <<<"$out" \
		&& ! grep -q '^skip UTF-' <<<"$out" \
		&& ! grep -q '^skip OAUTH-' <<<"$out"; then
	pass "I-int: real siblings emitted, body-prose fabrication blocked"
else
	fail "I-int: branch siblings + no body fabrication" "got: $out"
fi
rm -f "$TK_SANDBOX_INT/catalyst/linear-team-keys.json"

# ─── Case II-int: create-pr-shaped branch-only invocation ─────────────────────
echo "Test: create-pr-shaped branch-only descriptive slug emits no skip lines"
out=$(linear_sibling_skip_block_from_branch "CTL-633" "CTL-633-migrate-oauth2-and-utf8-support")
if [[ -z "$out" ]]; then
	pass "II-int: descriptive own-ticket slug → empty skip block"
else
	fail "II-int: empty skip block for descriptive own slug" "got: $out"
fi

# ─── Case III-int: producer SKILL.md files reference the new API ──────────────
echo "Test: describe-pr and ci-describe-pr call both _from_branch and _from_body"
for skill in describe-pr ci-describe-pr; do
	f="${SKILLS_DIR}/${skill}/SKILL.md"
	if grep -q 'linear_sibling_skip_block_from_branch' "$f" \
			&& grep -q 'linear_sibling_skip_block_from_body' "$f"; then
		pass "${skill}: invokes both _from_branch and _from_body"
	else
		fail "${skill}: invokes both _from_branch and _from_body"
	fi
done

echo "Test: create-pr calls only _from_branch (transient initial body has no PR body to scan)"
CP="${SKILLS_DIR}/create-pr/SKILL.md"
if grep -q 'linear_sibling_skip_block_from_branch' "$CP" \
		&& ! grep -q 'linear_sibling_skip_block_from_body' "$CP"; then
	pass "create-pr: branch-only invocation (body mode intentionally absent)"
else
	fail "create-pr: branch-only invocation" \
		"$(grep -n 'linear_sibling_skip_block' "$CP" | head -3)"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]]
