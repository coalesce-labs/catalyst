#!/usr/bin/env bash
# CTL-2045 — cross-stack parity for the host write-credential classifier.
#
# Two engines classify the credential that decides whether a host can take a fence:
# lib/host-write-credential.mjs (JS — `catalyst doctor`) and
# lib/catalyst-host-write-credential.sh (bash — `setup-catalyst.sh`, which runs before
# node is guaranteed present). They must not drift.
#
# ⛔ EACH ENGINE IS CHECKED AGAINST THE TABLE'S EXPECTED VERDICT, NOT AGAINST THE OTHER.
# A bare bash-vs-JS comparison passes when both are wrong the same way, which is the
# likeliest drift (someone "fixes" one and mirrors the fix). The table is the third party.
# Row-count equality is asserted too, so a silently-skipped row cannot read as a pass:
# a loop over an empty input set prints an all-clear on the strength of zero iterations.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../lib" && pwd)"
CASES="${SCRIPT_DIR}/fixtures/host-write-credential-cases.txt"

PASS=0
FAIL=0
ok() {
	PASS=$((PASS + 1))
	echo "  ok   — $1"
}
bad() {
	FAIL=$((FAIL + 1))
	echo "  FAIL — $1"
}

[[ -r $CASES ]] || {
	echo "FAIL: fixture table not readable at $CASES"
	exit 1
}
# shellcheck source=../lib/catalyst-host-write-credential.sh disable=SC1091
source "${LIB_DIR}/catalyst-host-write-credential.sh"

NODE_BIN="$(command -v node || command -v bun || true)"
[[ -n $NODE_BIN ]] || {
	echo "FAIL: neither node nor bun on PATH — cannot drive the JS engine"
	exit 1
}

echo "CTL-2045 — host write-credential classifier parity"

# ── The JS engine, driven ONCE over the whole table ───────────────────────────────────
# One process for the whole table rather than one per row: 9 node boots is ~2s of pure
# startup, and this suite runs in every gate.
JS_OUT="$(mktemp)"
trap 'rm -f "$JS_OUT"' EXIT
# One process for the whole table rather than one per row: 9 node boots is ~2s of pure
# startup, and this suite runs in every gate. The module path arrives via the environment
# (a dynamic import) because a static `import … from <expr>` is not valid syntax.
CRED_MOD="file://${LIB_DIR}/host-write-credential.mjs" CRED_CASES="$CASES" \
	"$NODE_BIN" --input-type=module -e '
import { readFileSync } from "node:fs";
const { classifyHostWriteCredential } = await import(process.env.CRED_MOD);
const rows = readFileSync(process.env.CRED_CASES, "utf8").split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"));
for (const line of rows) {
  const rest = line.slice(line.indexOf("\t") + 1);
  process.stdout.write(classifyHostWriteCredential(rest === "<EMPTY>" ? "" : rest).verdict + "\n");
}
' >"$JS_OUT" || {
	echo "FAIL: the JS engine could not be driven over the table"
	exit 1
}

# ── Walk the table: bash-vs-expected, JS-vs-expected, row alignment ───────────────────
row=0
while IFS= read -r line; do
	[[ -z ${line// /} ]] && continue
	[[ $line == \#* ]] && continue
	row=$((row + 1))
	expected="${line%%$'\t'*}"
	token="${line#*$'\t'}"
	[[ $token == "<EMPTY>" ]] && token=""

	# bash engine — called DIRECTLY, never in $(…): the verdict rides globals, and a
	# command substitution would run it in a subshell and discard every one of them.
	CATALYST_CREDENTIAL_VERDICT=""
	CATALYST_CREDENTIAL_SHAPE=""
	catalyst_classify_host_write_credential "$token"
	sh_rc=$?
	sh_verdict="$CATALYST_CREDENTIAL_VERDICT"

	js_verdict="$(sed -n "${row}p" "$JS_OUT")"

	label="row ${row} (expected ${expected})"
	if [[ $sh_verdict == "$expected" ]]; then ok "bash  ${label}"; else bad "bash  ${label} — got '${sh_verdict}'"; fi
	if [[ $js_verdict == "$expected" ]]; then ok "js    ${label}"; else bad "js    ${label} — got '${js_verdict}'"; fi

	# The RETURN CODE is the thing setup-catalyst.sh actually branches on, so assert it
	# independently of the verdict string. A mirror that names the class correctly and
	# returns 0 for it anyway would let the install proceed on an admin bearer.
	if [[ $expected == "org-key" ]]; then
		if [[ $sh_rc -eq 0 ]]; then ok "bash  ${label} returns 0"; else bad "bash  ${label} returned ${sh_rc}, expected 0"; fi
	else
		if [[ $sh_rc -ne 0 ]]; then ok "bash  ${label} returns non-zero"; else bad "bash  ${label} returned 0 — a non-org-key MUST refuse"; fi
	fi

	# ⛔ The shape must never carry the secret. Asserted on every row, not just the ones
	# whose message an operator is likely to see: the redaction lives in the classifier
	# precisely so no caller can leak it, and a row that leaks proves the opposite.
	if [[ -n $token && $CATALYST_CREDENTIAL_SHAPE == *"$token"* ]]; then
		bad "bash  ${label} — SHAPE LEAKS THE TOKEN VALUE"
	else
		ok "bash  ${label} shape carries no secret body"
	fi
done <"$CASES"

# ── Row alignment + a non-empty denominator ──────────────────────────────────────────
js_rows=$(grep -c . "$JS_OUT" 2>/dev/null || echo 0)
if [[ $row -eq 0 ]]; then
	bad "the fixture table yielded ZERO rows — every assertion above is vacuous"
elif [[ $js_rows -eq $row ]]; then
	ok "both engines classified all ${row} rows (no silently skipped row)"
else
	bad "row misalignment: bash walked ${row}, js emitted ${js_rows} — verdicts above were compared off-by-one"
fi

# ── Mutation control ─────────────────────────────────────────────────────────────────
# ⭐ Proves this suite can actually fail. The table contains a row whose token differs
# from an accepted one ONLY by the prefix; if the bash engine matched on a substring
# rather than the start, "Bearer ctc_acct_…" would classify as org-key and the install
# would accept a mangled credential. A GREEN control is the "easy fixture" trap.
CATALYST_CREDENTIAL_VERDICT=""
catalyst_classify_host_write_credential "Bearer ctc_acct_x"
if [[ $CATALYST_CREDENTIAL_VERDICT == "unrecognized" ]]; then
	ok "control — the prefix must match at the START, not anywhere in the string"
else
	bad "control — a leading-garbage token classified as '${CATALYST_CREDENTIAL_VERDICT}', not 'unrecognized'"
fi

echo ""
echo "  PASS=${PASS} FAIL=${FAIL}"
[[ $FAIL -eq 0 ]] || exit 1
