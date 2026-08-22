# Prelude

Copy into the running session, adapted per mode.

```bash
set -uo pipefail   # NOT -e: a single ticket's failure must not abort the sweep

# ── Resolve the runtime context, tolerating bare invocation ──────────────────
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-$HOME/catalyst/execution-core}"
ORCH_ID="${CATALYST_ORCHESTRATOR_ID:-recovery-pass}"
PHASE="${CATALYST_PHASE:-recovery-pass}"
TICKET="${CATALYST_TICKET:-}"   # set when router-dispatched; empty for the sweep
CHANNEL="orch-${ORCH_ID}"

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  RUNTIME_ROOT_LIB=""
  if [[ -f "./plugins/dev/scripts/lib/catalyst-runtime-root.sh" ]]; then
    RUNTIME_ROOT_LIB="./plugins/dev/scripts/lib/catalyst-runtime-root.sh"
  else
    __rr_mkt="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts/lib/catalyst-runtime-root.sh 2>/dev/null | sort -V | tail -1 || true )"
    if [[ -n "$__rr_mkt" && -f "$__rr_mkt" ]]; then
      RUNTIME_ROOT_LIB="$__rr_mkt"
    else
      __rr_cache="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts/lib/catalyst-runtime-root.sh 2>/dev/null | sort -V | tail -1 || true )"
      [[ -n "$__rr_cache" && -f "$__rr_cache" ]] && RUNTIME_ROOT_LIB="$__rr_cache"
      unset __rr_cache
    fi
    unset __rr_mkt
  fi
  DEV_SCRIPTS=""
  if [[ -n "$RUNTIME_ROOT_LIB" ]]; then
    # shellcheck disable=SC1090
    . "$RUNTIME_ROOT_LIB"
    catalyst_dev_scripts >/dev/null 2>&1 || true
    DEV_SCRIPTS="${CATALYST_DEV_SCRIPTS:-}"
  fi
  if [[ -z "$DEV_SCRIPTS" ]]; then
    echo "recovery-pass: FATAL — CLAUDE_PLUGIN_ROOT unset and catalyst_dev_scripts probe missed too; refusing to silently skip the CTL-615 yield gate with a guessed PLUGIN_ROOT" >&2
    exit 1
  fi
  PLUGIN_ROOT="$(dirname "$DEV_SCRIPTS")"
fi
EXEC_CORE="${PLUGIN_ROOT}/scripts/execution-core"

# ── Mode + the app-actor coordination-comment shim (CTL-1176) ────────────────
# Enforce-only: the worker is dispatched ONLY in enforce mode (shadow just emits
# would-escalate and never invokes the skill — recovery-reasoning.mjs), so a
# coordination comment must NEVER post outside enforce. A bare operator sweep
# leaves CATALYST_RECOVERY_PASS unset → treated as enforce (the operator is acting live).
RECOVERY_MODE="${CATALYST_RECOVERY_PASS:-enforce}"

# _rp_comment <ticket> <body> — post an app-actor coordination comment on the
# ticket (claim/unstuck/escalate visibility for other agents/hosts). FAIL-OPEN:
# a comment failure must NEVER abort the unstick. Enforce-only + bounded (call it
# ONCE per item per moment — the router's cooldown/act-once already prevents
# spam). No-op in shadow/off. Mirrors the canonical phase-skill invocation.
_RP_COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
[[ -x "$_RP_COMMENT_POST" ]] || _RP_COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"
_rp_comment() {
  local t="$1" body="$2"
  [[ "$RECOVERY_MODE" == "enforce" ]] || return 0          # enforce-only
  [[ -n "$t" && -n "$body" ]] || return 0                  # never with empty ticket
  if [[ -n "$_RP_COMMENT_POST" && -x "$_RP_COMMENT_POST" ]]; then
    "$_RP_COMMENT_POST" "$t" "$body" >/dev/null 2>&1 \
      || echo "recovery-pass: coordination comment failed on ${t} (continuing)" >&2
  fi
  return 0
}

# ── Router-dispatched mode: run the phase-agent envelope ─────────────────────
if [[ -n "$TICKET" ]]; then
  SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"

  # CTL-615 yield: if the signal's bg_job_id names a DIFFERENT live bg job, we are
  # a redispatch duplicate of a still-running worker — bow out (exit 0), no emit.
  YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
  if [[ -f "$SIGNAL_FILE" && -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
       --signal "$SIGNAL_FILE" --phase "$PHASE" \
       --worker-dir "$(dirname "$SIGNAL_FILE")"; then
    echo "recovery-pass: yielding to canonical worker (CTL-615)" >&2
    exit 0
  fi

  # Join comms + start a cost session + flip the signal to running (best-effort).
  COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
  [[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
  if [[ -n "$COMMS" && -x "$COMMS" ]]; then
    "$COMMS" join "$CHANNEL" --as "$TICKET" --capabilities "recovery-pass: ${TICKET}" \
      --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
    "$COMMS" send "$CHANNEL" "recovery-pass started" --as "$TICKET" --type info \
      --orch "$ORCH_ID" >/dev/null 2>&1 || true
  fi
  SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
  if [[ -x "$SESSION_SCRIPT" ]]; then
    CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "recovery-pass" \
      --ticket "$TICKET" --workflow "${CATALYST_SESSION_ID:-}")
    export CATALYST_SESSION_ID
  fi
  if [[ -f "$SIGNAL_FILE" ]]; then
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ); TMP="${SIGNAL_FILE}.tmp.$$"
    jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
      .status = "running" | .updatedAt = $ts
      | if $sid != "" then .catalystSessionId = $sid else . end
    ' "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
  fi

fi

# ── Context / mode resolution (BOTH modes) ───────────────────────────────────
# Run the read-only context resolver FIRST. It prints a MODE banner + the stuck
# set, and makes NO direct Linear API calls (local on-disk state only): in
# dispatched mode it reads the recovery-pass.json brief (the eyes+hands output —
# CONSUME it, do NOT re-run the diagnostician or the seams); in sweep mode it
# unions THREE local sources — worker signals + the unified event log + the
# webhook-fed Linear cache — deduped by ticket and HRW-TAGGED (a soft owner
# signal, NOT a hard filter): YOURS = act on it; CONTEXT = another host owns it,
# awareness only. Read its output; the MODE line drives which path you take below.
node "${EXEC_CORE}/recovery-pass-context.mjs" ${TICKET:+--ticket "$TICKET"} --orch-dir "$ORCH_DIR"
```
