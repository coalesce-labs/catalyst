#!/usr/bin/env bash
# Tests for the legacy orchestrator's "Surface workers that stalled themselves or
# asked for attention" scan (CTC-2981). A oneshot-legacy worker that stalls
# itself writes status="stalled" + stallReason to its signal file; one that hits
# a blocker but keeps working records attentionRequest (request_attention). The
# catalyst-comms attention post that used to carry both was removed, so the
# orchestrator must raise them from the signal. This extracts the scan's bash block from
# plugins/legacy/skills/orchestrate/SKILL.md and runs it against fake signals
# with a stub STATE_SCRIPT that records its arguments.
#
# Run: bash plugins/dev/scripts/__tests__/legacy-stalled-surface.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/legacy/skills/orchestrate/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

echo "legacy orchestrate: surface self-stalled workers"

# The first ```bash block after the section heading.
awk '
  /^\*\*Surface workers that stalled themselves/ { found = 1; next }
  found && /^```bash$/ { inblock = 1; next }
  inblock && /^```$/ { exit }
  inblock { print }
' "$SKILL" > "$SCRATCH/scan.sh"

if [[ -s "$SCRATCH/scan.sh" ]]; then
  pass "the scan block exists in the orchestrate skill"
else
  fail "the scan block exists in the orchestrate skill"
  echo "Results: ${PASSES} passed, ${FAILURES} failed"
  exit 1
fi

ORCH_DIR="$SCRATCH/orch"
mkdir -p "$ORCH_DIR/workers"
cat > "$SCRATCH/state-stub.sh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SCRATCH/state-calls.log"
STUB
chmod +x "$SCRATCH/state-stub.sh"

# 1. worker-stalled with a reason → raised
printf '%s' '{"ticket":"CTL-1","status":"stalled","stallReason":"Merge conflicts (DIRTY) — cannot auto-resolve"}' > "$ORCH_DIR/workers/CTL-1.json"
# 2. stalled by the orchestrator's own scripts (already carries attentionReason) → skipped
printf '%s' '{"ticket":"CTL-2","status":"stalled","attentionReason":"revive-budget-exhausted"}' > "$ORCH_DIR/workers/CTL-2.json"
# 3. still working → skipped
printf '%s' '{"ticket":"CTL-3","status":"implementing"}' > "$ORCH_DIR/workers/CTL-3.json"
# 4. stalled with no reason recorded (an older worker) → raised with a fallback
printf '%s' '{"ticket":"CTL-4","status":"stalled"}' > "$ORCH_DIR/workers/CTL-4.json"
# 5. attention-only blocker: still working, one unraised request → raised once
printf '%s' '{"ticket":"CTL-5","status":"implementing","attentionRequest":"missing access: no write token for the staging bucket","attentionRequestSeq":1}' > "$ORCH_DIR/workers/CTL-5.json"

run_scan() {
  ORCH_DIR="$ORCH_DIR" ORCH_NAME="orch-test" STATE_SCRIPT="$SCRATCH/state-stub.sh" \
    bash -c "$(cat "$SCRATCH/scan.sh")"
}

run_scan
CALLS="$(cat "$SCRATCH/state-calls.log" 2>/dev/null || true)"

if [[ "$(printf '%s\n' "$CALLS" | grep -c .)" == "3" ]]; then
  pass "exactly three attention items raised (CTL-1, CTL-4, CTL-5)"
else
  fail "exactly three attention items raised — got: ${CALLS}"
fi
if printf '%s\n' "$CALLS" | grep -qF 'attention orch-test worker-attention CTL-5 [CTL-5] missing access: no write token for the staging bucket'; then
  pass "an attention-only blocker is raised without the worker stalling"
else
  fail "an attention-only blocker is raised without the worker stalling — got: ${CALLS}"
fi
if [[ "$(jq -r '.status' "$ORCH_DIR/workers/CTL-5.json")" == "implementing" && "$(jq -r '.attentionRequestRaisedSeq' "$ORCH_DIR/workers/CTL-5.json")" == "1" ]]; then
  pass "the attention-only worker keeps its status and the raised request is recorded"
else
  fail "the attention-only worker keeps its status and the raised request is recorded"
fi
if printf '%s\n' "$CALLS" | grep -qF 'attention orch-test worker-stalled CTL-1 [CTL-1] stalled: Merge conflicts (DIRTY) — cannot auto-resolve'; then
  pass "CTL-1 raised with its stallReason"
else
  fail "CTL-1 raised with its stallReason — got: ${CALLS}"
fi
if printf '%s\n' "$CALLS" | grep -qF 'attention orch-test worker-stalled CTL-4 [CTL-4] stalled: no reason recorded in the signal file'; then
  pass "CTL-4 raised with the no-reason fallback"
else
  fail "CTL-4 raised with the no-reason fallback — got: ${CALLS}"
fi
if ! printf '%s\n' "$CALLS" | grep -qE 'CTL-2|CTL-3'; then
  pass "script-raised stalls and live workers are skipped"
else
  fail "script-raised stalls and live workers are skipped — got: ${CALLS}"
fi
if [[ "$(jq -r '.attentionReason' "$ORCH_DIR/workers/CTL-1.json")" == "worker-stalled" ]]; then
  pass "the surfaced signal is marked so it is raised once"
else
  fail "the surfaced signal is marked so it is raised once"
fi

: > "$SCRATCH/state-calls.log"
run_scan
if [[ ! -s "$SCRATCH/state-calls.log" ]]; then
  pass "a second wake-up raises nothing new"
else
  fail "a second wake-up raises nothing new — got: $(cat "$SCRATCH/state-calls.log")"
fi

# A second, distinct blocker from the same worker is a new request: raised once.
jq '.attentionRequest = "ambiguous spec: two acceptance criteria conflict" | .attentionRequestSeq = 2' \
  "$ORCH_DIR/workers/CTL-5.json" > "$ORCH_DIR/workers/CTL-5.json.tmp" && mv "$ORCH_DIR/workers/CTL-5.json.tmp" "$ORCH_DIR/workers/CTL-5.json"
: > "$SCRATCH/state-calls.log"
run_scan
run_scan
CALLS="$(cat "$SCRATCH/state-calls.log" 2>/dev/null || true)"
if [[ "$(printf '%s\n' "$CALLS" | grep -c .)" == "1" ]] && printf '%s\n' "$CALLS" | grep -qF 'worker-attention CTL-5 [CTL-5] ambiguous spec: two acceptance criteria conflict'; then
  pass "a new request from the same worker is raised once across two wake-ups"
else
  fail "a new request from the same worker is raised once across two wake-ups — got: ${CALLS}"
fi

# The worker side: oneshot's request_attention records the request in the signal
# file without touching status, and bumps the sequence per call.
ONESHOT="${REPO_ROOT}/plugins/legacy/skills/oneshot/SKILL.md"
awk '/^request_attention\(\) \{$/ { on = 1 } on { print } on && /^\}$/ { exit }' "$ONESHOT" > "$SCRATCH/request-attention.sh"
printf '%s' '{"ticket":"CTL-9","status":"implementing"}' > "$SCRATCH/CTL-9.json"
SIGNAL_FILE="$SCRATCH/CTL-9.json" bash -c '
  comms_post() { :; }
  source "'"$SCRATCH"'/request-attention.sh"
  request_attention "scope conflict with CTL-8"
  request_attention "missing access: gh token lacks repo scope"
'
if [[ -s "$SCRATCH/request-attention.sh" ]] \
  && [[ "$(jq -r '.status' "$SCRATCH/CTL-9.json")" == "implementing" ]] \
  && [[ "$(jq -r '.attentionRequestSeq' "$SCRATCH/CTL-9.json")" == "2" ]] \
  && [[ "$(jq -r '.attentionRequest' "$SCRATCH/CTL-9.json")" == "missing access: gh token lacks repo scope" ]]; then
  pass "oneshot request_attention records the request in the signal file without changing status"
else
  fail "oneshot request_attention records the request in the signal file without changing status — got: $(cat "$SCRATCH/CTL-9.json")"
fi

echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
