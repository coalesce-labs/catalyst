#!/usr/bin/env bash
# install-agent-tools.test.sh — CTL-1958 Phase 4. install-agent-tools.sh symlinks the
# out-of-tree deployed copies (~/catalyst/comms/tools/{linear-reply,linear-ack}.mjs) to the
# repo copies (CTL-2026 option a), so the AC grep `grep -rl 'client_credentials'
# ~/catalyst/comms/tools/` passes and STAYS passing across updates, and doctor's
# agent-tools-write-path check reports WRAPPER/PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)"          # plugins/dev/scripts
INSTALLER="${SCRIPTS}/install-agent-tools.sh"
DOCTOR="${SCRIPTS}/execution-core/agent-tools-write-path-health.mjs"

PASS=0
FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

assert_link_to_repo() { # $1=link  $2=expected target name
  local link="$1" name="$2"
  if [[ -L "$link" ]] && [[ "$(readlink "$link")" == "${SCRIPTS}/${name}" ]]; then
    ok "${name}: symlink → repo copy (${SCRIPTS}/${name})"
  else
    bad "${name}: expected symlink → ${SCRIPTS}/${name} (got: $(readlink "$link" 2>/dev/null || echo '<not a symlink>'))"
  fi
}

CATALYST_DIR="$(mktemp -d)"
TOOLS_DIR="${CATALYST_DIR}/comms/tools"

# 1. Fresh install → both tools are symlinks to the repo copies.
if CATALYST_DIR="$CATALYST_DIR" bash "$INSTALLER" >/dev/null 2>&1; then
  ok "installer exits 0 on a fresh install"
else
  bad "installer failed on a fresh install"
fi
assert_link_to_repo "${TOOLS_DIR}/linear-reply.mjs" "linear-reply.mjs"
assert_link_to_repo "${TOOLS_DIR}/linear-ack.mjs" "linear-ack.mjs"

# 2. Idempotent: a second run exits 0 and leaves symlinks (never a nested link/dir).
if CATALYST_DIR="$CATALYST_DIR" bash "$INSTALLER" >/dev/null 2>&1; then
  ok "installer is idempotent (second run exits 0)"
else
  bad "installer second run failed"
fi
assert_link_to_repo "${TOOLS_DIR}/linear-reply.mjs" "linear-reply.mjs"

# 3. doctor's checkAgentToolsWritePath over those symlinks → WRAPPER → PASS.
DOC_JSON="$(node -e "
import('${DOCTOR}').then((m) => {
  const c = m.checkAgentToolsWritePath({ outDir: '${TOOLS_DIR}', repoDir: '${SCRIPTS}' });
  console.log(JSON.stringify({ status: c.status, detail: c.detail }));
}).catch((e) => { console.log(JSON.stringify({ status: 'error', detail: String(e && e.message) })); });
" 2>/dev/null)"
if printf '%s' "$DOC_JSON" | grep -q '"status":"pass"' && printf '%s' "$DOC_JSON" | grep -qi "symlink"; then
  ok "checkAgentToolsWritePath → WRAPPER/PASS (${DOC_JSON})"
else
  bad "checkAgentToolsWritePath not WRAPPER/PASS (${DOC_JSON})"
fi

# 4. The AC hard gate: grep -rl 'client_credentials' <deployed>/ returns nothing.
#    Positive control first (AGENTS.md): the grep MUST hit a fixture that carries the string.
CTRL="$(mktemp)"; printf 'grant_type=client_credentials\n' >"$CTRL"
if grep -rl 'client_credentials' "$CTRL" >/dev/null 2>&1; then
  ok "positive control: grep -rl matches a known-present fixture"
else
  bad "positive control FAILED — grep -rl untrustworthy"
fi
rm -f "$CTRL"
CC_HITS="$(grep -rl 'client_credentials' "$TOOLS_DIR" 2>/dev/null || true)"
if [[ -z "$CC_HITS" ]]; then
  ok "grep -rl 'client_credentials' ${TOOLS_DIR}/ → nothing (AC1)"
else
  bad "AC1 grep found client_credentials: ${CC_HITS}"
fi
# Stronger: resolve each symlink and grep the TARGET (grep -r does not follow symlinks, so
# the AC command alone could pass vacuously — verify the deployed CONTENT is mint-free too).
TARGET_HITS=""
for name in linear-reply.mjs linear-ack.mjs; do
  tgt="$(readlink "${TOOLS_DIR}/${name}")"
  grep -q 'client_credentials' "$tgt" && TARGET_HITS="${TARGET_HITS} ${name}"
done
if [[ -z "$TARGET_HITS" ]]; then
  ok "resolved symlink targets are mint-free (no client_credentials in the deployed content)"
else
  bad "symlink target(s) still contain client_credentials:${TARGET_HITS}"
fi

# 5. CTL-2204: the deployed tool is a SYMLINK, and linear-reply.mjs now imports ./lib/…
#    in addition to ./execution-core/…. Node resolves relative imports from the REALPATH
#    (no --preserve-symlinks), so this should work — but nothing executed the deployed copy
#    before, so the property was unguarded. `node --check` does NOT resolve imports; running
#    the tool does, because top-level imports run before the usage gate.
DEPLOY_RC=0
DEPLOY_OUT="$(node "${TOOLS_DIR}/linear-reply.mjs" 2>&1)" || DEPLOY_RC=$?
if [[ "$DEPLOY_RC" -eq 2 ]] && printf '%s' "$DEPLOY_OUT" | grep -q "usage:"; then
  ok "deployed symlink executes: imports resolve, reaches the usage gate (exit 2)"
elif printf '%s' "$DEPLOY_OUT" | grep -qi "ERR_MODULE_NOT_FOUND\|Cannot find module"; then
  bad "deployed symlink cannot resolve an import: ${DEPLOY_OUT}"
else
  bad "deployed symlink unexpected result (rc=${DEPLOY_RC}, out=${DEPLOY_OUT})"
fi

rm -rf "$CATALYST_DIR"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
