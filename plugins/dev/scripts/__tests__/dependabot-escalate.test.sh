#!/usr/bin/env bash
# Unit tests for dependabot-escalate.sh's linearis app-actor wiring: the sweep should
# authenticate its linearis calls as the dedicated linear-linearis-actor
# identity, sourced/minted at script start, before the first linearis call in
# the file -- and a failed mint (e.g. the identity not yet propagated to a
# host) must not abort the sweep (fail-open, matching every other
# linear_app_actor_auth caller in this codebase).
#
# Run: bash plugins/dev/scripts/__tests__/dependabot-escalate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/../dependabot-escalate.sh"
SCRATCH="$(mktemp -d -t dependabot-escalate-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -f "$TARGET" ]]; then
  echo "FATAL: $TARGET not found" >&2
  exit 1
fi

# ─── Structural check: sources the lib and mints the linearis identity BEFORE
# the first linearis call in the file. Static, not an execution test -- proves
# ordering/wiring without needing to run the whole sweep.
echo "structural: sources lib/linear-app-actor.sh and mints linear-linearis-actor before the first linearis call"
# Comment lines (optionally indented, leading #) are excluded throughout --
# this file's own prose mentions "linearis" and "linear_app_actor_auth" many
# times, which would otherwise false-positive as call sites.
SOURCE_LINE="$(grep -n 'source.*lib/linear-app-actor\.sh' "$TARGET" | grep -v '^[0-9]*:[[:space:]]*#' | head -1 | cut -d: -f1)"
MINT_LINE="$(grep -n 'linear_app_actor_auth.*linear-linearis-actor' "$TARGET" | grep -v '^[0-9]*:[[:space:]]*#' | head -1 | cut -d: -f1)"
FIRST_LINEARIS_CALL_LINE="$(grep -n '\blinearis \|\blinearis$' "$TARGET" | grep -v '^[0-9]*:[[:space:]]*#' | grep -v 'lib/linear-app-actor\.sh\|linear_app_actor_auth' | head -1 | cut -d: -f1)"

if [[ -n "$SOURCE_LINE" ]]; then
  pass "structural: sources lib/linear-app-actor.sh"
else
  fail "structural: does not source lib/linear-app-actor.sh"
fi
if [[ -n "$MINT_LINE" ]]; then
  pass "structural: calls linear_app_actor_auth with linear-linearis-actor"
else
  fail "structural: does not call linear_app_actor_auth with linear-linearis-actor"
fi
if [[ -n "$MINT_LINE" && -n "$FIRST_LINEARIS_CALL_LINE" && "$MINT_LINE" -lt "$FIRST_LINEARIS_CALL_LINE" ]]; then
  pass "structural: mint call precedes the first real linearis invocation"
else
  fail "structural: mint call does NOT precede the first real linearis invocation (mint=$MINT_LINE, first-call=$FIRST_LINEARIS_CALL_LINE)"
fi

# ─── End-to-end fail-open: mint is impossible (no orchestrator/linearis app
# configured -- CATALYST_LAYER2_CONFIG_FILE points at an absent file, same
# convention as linear-app-actor.test.sh), gh returns empty results (no
# escalation triggers found), and the sweep must still exit 0 rather than
# aborting because the credential wasn't available.
echo ""
echo "end-to-end: mint impossible + nothing to escalate -> sweep still exits 0 (fail-open, matches every other linear_app_actor_auth caller)"

REPO_CONFIG="${SCRATCH}/repos.json"
cat > "$REPO_CONFIG" <<'EOF'
{"fake-org/fake-repo": "FAKE"}
EOF

STUB_BIN="${SCRATCH}/bin"
mkdir -p "$STUB_BIN"
cat > "${STUB_BIN}/gh" <<'GHSTUB'
#!/usr/bin/env bash
# Minimal stub: both `gh run list` and `gh pr list` return an empty JSON
# array, so the sweep finds nothing to escalate and exits cleanly without
# ever needing real GitHub access.
echo '[]'
GHSTUB
chmod +x "${STUB_BIN}/gh"

ABSENT_LAYER2="${SCRATCH}/absent-layer2-config.json"

OUT="$(env -i HOME="$SCRATCH" PATH="${STUB_BIN}:${PATH}" \
  DEPENDABOT_ESCALATE_CONFIG="$REPO_CONFIG" \
  CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
  bash "$TARGET" --dry-run 2>&1)"
RC=$?

if [[ $RC -eq 0 ]]; then
  pass "end-to-end: sweep exits 0 even though the linearis mint is impossible"
else
  fail "end-to-end: sweep exited ${RC} (expected 0); output: $OUT"
fi

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
