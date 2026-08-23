#!/usr/bin/env bash
# claude-json-single-owner.test.sh — Phase 3 production-writer routing tests
# Verifies that trust-workspace.sh and create-worktree.sh route their claude.json
# mutations through lib/claude-json-mutate.sh (CTL-1890).
#
# Discovered automatically by run-tests.sh's __tests__/*.test.sh glob.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUST_WS="${SCRIPTS_DIR}/trust-workspace.sh"
CREATE_WT="${SCRIPTS_DIR}/create-worktree.sh"
SEAM="${SCRIPTS_DIR}/lib/claude-json-mutate.sh"

PASS=0; FAIL=0; TMPFILES=()
_cleanup() { rm -rf "${TMPFILES[@]}" 2>/dev/null || true; }
trap _cleanup EXIT INT TERM

newdir() { local d; d="$(mktemp -d)"; TMPFILES+=("$d"); echo "$d"; }
fail() { echo "  FAIL — $*" >&2; FAIL=$((FAIL + 1)); }
ok() { echo "  ok — $*"; PASS=$((PASS + 1)); }

# ── Static source checks ──────────────────────────────────────────────────────

# Case J: trust-workspace.sh contains no flock or mktemp calls.
# The old implementation used `flock -w 5 200` and `mktemp "$CLAUDE_CONFIG.XXXXXX"`.
# Routing through the seam eliminates both.
FLOCK_COUNT="$(grep -c 'flock' "$TRUST_WS" 2>/dev/null || true)"
MKTEMP_COUNT="$(grep -c 'mktemp' "$TRUST_WS" 2>/dev/null || true)"
if [[ "$FLOCK_COUNT" -eq 0 && "$MKTEMP_COUNT" -eq 0 ]]; then
  ok "Case J — trust-workspace.sh: 0 flock references, 0 mktemp references"
else
  fail "Case J — trust-workspace.sh still has direct lock/mktemp (flock=${FLOCK_COUNT}, mktemp=${MKTEMP_COUNT})"
fi

# Case K: create-worktree.sh's claude.json block contains no mktemp call for
# the pre-trust section. The block now delegates to the seam; no TMPFILE.
# Search for mktemp within a small window around the "pre-trust" comment.
# We look for 'mktemp' alongside 'hasTrustDialogAccepted' (old inline jq pattern).
INLINE_JQ="$(grep -c 'hasTrustDialogAccepted' "$CREATE_WT" 2>/dev/null || true)"
if [[ "$INLINE_JQ" -eq 0 ]]; then
  ok "Case K — create-worktree.sh: no inline hasTrustDialogAccepted jq (routed through seam)"
else
  fail "Case K — create-worktree.sh still has inline hasTrustDialogAccepted jq (count=${INLINE_JQ})"
fi

# Case L: trust-workspace.sh invokes the seam via exec.
# Must reference claude-json-mutate.sh in the exec line.
SEAM_REF="$(grep -c 'claude-json-mutate.sh' "$TRUST_WS" 2>/dev/null || echo 0)"
if [[ "$SEAM_REF" -ge 1 ]]; then
  ok "Case L — trust-workspace.sh references claude-json-mutate.sh"
else
  fail "Case L — trust-workspace.sh does not reference claude-json-mutate.sh"
fi

# Case M: create-worktree.sh invokes the seam via bash.
CWT_SEAM_REF="$(grep -c 'claude-json-mutate.sh' "$CREATE_WT" 2>/dev/null || echo 0)"
if [[ "$CWT_SEAM_REF" -ge 1 ]]; then
  ok "Case M — create-worktree.sh references claude-json-mutate.sh"
else
  fail "Case M — create-worktree.sh does not reference claude-json-mutate.sh"
fi

# ── Functional: trust-workspace.sh behaves correctly via seam ─────────────────

make_trust_fixture() {
  local dir="$1" path="$2"
  mkdir -p "$path"
  cat > "${dir}/claude.json" <<'EOF'
{
  "projects": {
    "/pre-existing": {
      "hasTrustDialogAccepted": false,
      "allowedTools": []
    }
  },
  "mcpServers": {
    "existing": {"command": "ex"}
  }
}
EOF
}

# Case N: trust-workspace.sh against a new path → creates entry with trust=true.
DIR_N="$(newdir)"
NEW_PATH="${DIR_N}/new-workspace"
mkdir -p "$NEW_PATH"
make_trust_fixture "$DIR_N" "$NEW_PATH"
CLAUDE_JSON="${DIR_N}/claude.json" bash "$TRUST_WS" "$NEW_PATH" >/dev/null
TRUST_VAL="$(jq -r --arg p "$NEW_PATH" '.projects[$p].hasTrustDialogAccepted' "${DIR_N}/claude.json")"
PRE_VAL="$(jq -r '.projects["/pre-existing"].hasTrustDialogAccepted' "${DIR_N}/claude.json")"
MCP_COUNT="$(jq '.mcpServers | length' "${DIR_N}/claude.json")"
VALID="$(jq -e . "${DIR_N}/claude.json" > /dev/null 2>&1 && echo ok || echo invalid)"
if [[ "$TRUST_VAL" == "true" && "$PRE_VAL" == "false" && "$MCP_COUNT" -eq 1 && "$VALID" == "ok" ]]; then
  ok "Case N — trust-workspace.sh: new entry trusted, pre-existing untouched, mcpServers intact, valid JSON"
else
  fail "Case N — trust-workspace.sh: trust=${TRUST_VAL} (want true), pre-existing=${PRE_VAL} (want false), mcp=${MCP_COUNT} (want 1), valid=${VALID}"
fi

# Case O: trust-workspace.sh against a pre-existing path → flips trust, no marker.
DIR_O="$(newdir)"
PRE_PATH="${DIR_O}/pre-workspace"
mkdir -p "$PRE_PATH"
cat > "${DIR_O}/claude.json" <<EOF
{
  "projects": {
    "${PRE_PATH}": {
      "hasTrustDialogAccepted": false,
      "customField": "keep-me"
    }
  }
}
EOF
CLAUDE_JSON="${DIR_O}/claude.json" bash "$TRUST_WS" "$PRE_PATH" >/dev/null
TRUST_O="$(jq -r --arg p "$PRE_PATH" '.projects[$p].hasTrustDialogAccepted' "${DIR_O}/claude.json")"
CUSTOM_O="$(jq -r --arg p "$PRE_PATH" '.projects[$p].customField' "${DIR_O}/claude.json")"
MARKER_O="$(jq -r --arg p "$PRE_PATH" '.projects[$p]._catalystManaged // "absent"' "${DIR_O}/claude.json")"
if [[ "$TRUST_O" == "true" && "$CUSTOM_O" == "keep-me" && "$MARKER_O" == "absent" ]]; then
  ok "Case O — trust-workspace.sh pre-existing: trust flipped, customField kept, no marker added"
else
  fail "Case O — trust=${TRUST_O} (want true), custom=${CUSTOM_O} (want keep-me), marker=${MARKER_O} (want absent)"
fi

# Case P: concurrent trust-workspace.sh + seam direct call → both entries land,
# mcpServers intact (regression guard for the two-writer race the seam fixes).
DIR_P="$(newdir)"
PATH_P1="${DIR_P}/ws1"; PATH_P2="${DIR_P}/ws2"
mkdir -p "$PATH_P1" "$PATH_P2"
cat > "${DIR_P}/claude.json" <<'EOF'
{
  "projects": {},
  "mcpServers": {"serena": {"command": "serena"}}
}
EOF
# Run both writers concurrently: trust-workspace.sh for ws1, seam directly for ws2.
CLAUDE_JSON="${DIR_P}/claude.json" bash "$TRUST_WS" "$PATH_P1" >/dev/null &
WS_PID=$!
CLAUDE_JSON="${DIR_P}/claude.json" bash "$SEAM" trust-project "$PATH_P2" >/dev/null &
SEAM_PID=$!
wait "$WS_PID" "$SEAM_PID"
VALID_P="$(jq -e . "${DIR_P}/claude.json" > /dev/null 2>&1 && echo ok || echo invalid)"
TRUST_P1="$(jq -r --arg p "$PATH_P1" '.projects[$p].hasTrustDialogAccepted' "${DIR_P}/claude.json")"
TRUST_P2="$(jq -r --arg p "$PATH_P2" '.projects[$p].hasTrustDialogAccepted' "${DIR_P}/claude.json")"
MCP_P="$(jq '.mcpServers | length' "${DIR_P}/claude.json")"
if [[ "$VALID_P" == "ok" && "$TRUST_P1" == "true" && "$TRUST_P2" == "true" && "$MCP_P" -eq 1 ]]; then
  ok "Case P — concurrent trust-workspace.sh + seam: both entries present, mcpServers intact, valid JSON"
else
  fail "Case P — valid=${VALID_P}, ws1_trust=${TRUST_P1}, ws2_trust=${TRUST_P2}, mcp=${MCP_P}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
  echo "PASS: claude-json-single-owner (CTL-1890, Phase 3 Cases J-P) — ${PASS}/${TOTAL}"
else
  echo "FAIL: ${FAIL}/${TOTAL} cases failed" >&2
  exit 1
fi
