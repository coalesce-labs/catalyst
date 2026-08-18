# The prelude — every phase agent copies this verbatim

Read this when authoring or auditing a phase agent's startup block. It is the shared
envelope: env-var contract, comms join, session start, signal file, inbound drain.

⚠️ The template's own prelude says `set -euo pipefail`, but SEVEN live phase skills use
`set -uo pipefail` (triage, research, plan, verify, review, monitor-deploy, teardown) and
four use `-euo` (implement, monitor-merge, remediate, pr). Which one you copy decides
whether a failed `gh` call aborts the phase or falls through — so state it deliberately
rather than assuming "verbatim" settled it.


```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required (set by phase-agent-dispatch)}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="orch-${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  # CTL-1628 Phase A2 bug fix: CLAUDE_PLUGIN_ROOT is normally set by the
  # runtime that launched this phase agent. This branch used to fall back to
  # a hardcoded personal absolute path
  # (/Users/ryan/.claude/plugins/cache/catalyst/catalyst-dev/<version>), which
  # is wrong on every OTHER machine/user and, worse, fails SILENTLY: a bad
  # PLUGIN_ROOT here means `[[ -x "$YIELD_CHECK" ]]` below just evaluates
  # false and the CTL-615 duplicate-worker yield gate is skipped without any
  # warning. Resolve properly via lib/catalyst-runtime-root.sh's
  # catalyst_dev_scripts (same probe every other catalyst-dev consumer uses:
  # cwd sibling → marketplace clone → versioned cache), and make a genuine
  # miss LOUD instead of silently proceeding with a broken PLUGIN_ROOT.
  # CTL-1628 A2 verify-round-2 bug fix: was a for-loop over unsorted glob
  # expansion, which takes the LEXICALLY FIRST match per rung (e.g. "1.10.0"
  # sorts before "1.9.0" lexically) — the same oldest-wins glob defect
  # db315537 fixes in god-gather.sh:187. Align with the `sort -V | tail -1`
  # newest-wins convention every other cache/marketplace probe in this repo
  # uses (require-catalyst-dev.sh, lib/catalyst-runtime-root.sh itself, …).
  # CTL-1628 A2 verify-round-3 bug fix: this whole prelude runs under
  # `set -euo pipefail` (line 76), and these two assignments are bare
  # top-level statements — NOT wrapped in a function called via
  # `$(fn || true)` the way every sibling probe in this PR is (lib
  # `__cd_resolve || true`, both require-catalyst-dev.sh shims'
  # `__rcd_bootstrap_find || true` / `__rcd_resolve || true`, god-gather.sh's
  # own `|| true`). On a total miss `ls -d <no-match-glob>` exits 1;
  # `pipefail` carries that through `sort -V | tail -1`; with no `|| true`
  # the failing assignment trips errexit and the shell dies HERE, silently
  # (ls's own diagnostic is `2>/dev/null`'d and errexit itself prints
  # nothing) — before the cache rung is ever probed and before the FATAL
  # miss message below can ever print, defeating this very fix's LOUD-miss
  # requirement. Guard each assignment with `|| true` like every sibling
  # probe already does.
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
    # catalyst_dev_scripts exports CATALYST_DEV_SCRIPTS as a side effect
    # (it does not print the path) — same contract require-catalyst-dev.sh
    # has always had, so read the exported var, not a command substitution.
    catalyst_dev_scripts >/dev/null 2>&1 || true
    DEV_SCRIPTS="${CATALYST_DEV_SCRIPTS:-}"
  fi
  if [[ -z "$DEV_SCRIPTS" ]]; then
    echo "phase-${PHASE}: FATAL — CLAUDE_PLUGIN_ROOT unset and catalyst_dev_scripts probe missed too; refusing to silently skip the CTL-615 yield gate with a guessed PLUGIN_ROOT" >&2
    exit 1
  fi
  PLUGIN_ROOT="$(dirname "$DEV_SCRIPTS")"
fi

# 0. Codified bg_job_id yield (CTL-615). If the signal file's bg_job_id
#    names a DIFFERENT live bg job, we are a redispatch duplicate of a
#    still-running canonical worker. Bow out without touching the signal,
#    without emitting any phase event. The helper writes a yield sidecar
#    `${ORCH_DIR}/workers/${TICKET}/.phase-${PHASE}-yield` so the
#    operator/daemon can attribute the no-op. Exit 0 by design — this is
#    NOT a failure; the canonical worker keeps running.
YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
if [[ -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
     --signal "$SIGNAL_FILE" \
     --phase "$PHASE" \
     --worker-dir "$(dirname "$SIGNAL_FILE")"; then
  echo "phase-${PHASE}: yielding to canonical worker (CTL-615)" >&2
  exit 0
fi

# 1. Join the shared comms channel (best-effort — phase agents must not crash
#    if catalyst-comms is unavailable).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-${PHASE}: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-${PHASE} started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# 2. Start a catalyst-session (cost / token instrumentation).
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-${PHASE}" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

# 3. Mark the signal file as "running" + record the start timestamp +
#    persist catalystSessionId (CTL-496: orchestrate-roll-usage --phase
#    reads this to attribute cost to the right session_metrics row without
#    relying on the ticket+skill_name DB-lookup heuristic).
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"
```

