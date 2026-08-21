#!/usr/bin/env bash
# cluster-fence-guard.sh (CTL-864) — cross-host worker fencing guard.
#
# Single source of truth for the side-effect fence used by phase-pr,
# phase-implement, phase-monitor-merge, phase-monitor-deploy, and phase-triage.
# Call BEFORE any irreversible side-effect (git push, gh pr create|merge,
# Linear mirror comment + transition):
#
#   "${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase "$PHASE" --ticket "$TICKET" || exit 10
#
# (All 5 call-sites use `|| exit 10`, matching the guard's only non-zero exit
# code; CTL-864 remediation aligned this example to that convention.)
#
# Contract:
#   CATALYST_CLUSTER_GENERATION unset/empty → exit 0  (single-host no-op)
#   generation current  (fence-check exit 0)  → exit 0  (proceed)
#   generation stale    (fence-check exit 10) → emit `failed` (reason
#                                               cluster_fence_stale), exit 10
#   fence UNREADABLE    (any other exit)      → bounded retry; if it never
#                                               answers, emit `failed` (reason
#                                               cluster_fence_unverified), exit 10
#
# ⛔ CTL-2048 — WHY THE THIRD ROW EXISTS, AND WHY IT IS NOT `stale`.
# This guard used to branch on `if node … fence-check …; then exit 0; fi` and treat
# EVERYTHING else as stale, with `>/dev/null 2>&1` throwing away the reason that would
# have separated them. `fence-check` exits 10 for a genuinely stale generation and 1 when
# it THREW — a transport error, an auth failure, an unparseable response — so "the fence
# says another host took over" and "I could not read the fence" were byte-identical to the
# caller.
#
# Measured on mini-2 on 2026-08-18, minutes after it produced its first two triage.json
# since Aug 14: both phase signals were written `failed / cluster_fence_stale`, and
# NEITHER fence was stale. Probed read-only immediately afterwards, `fence-check CTC-266 3`
# answered `{"current":true}` exit 0 — that ticket's fence was never even unreadable — and
# `fence-check CTC-759 1` returned a transport error once and then `{"current":true}` on
# three consecutive re-runs. The proxy had said so itself, in the line the guard discarded:
#   "reason":"transport-error" … "read-back NOT answered — the caller must treat this as UNVERIFIED"
# The guard converted UNVERIFIED into a definite negative. That is the inversion: "I could
# not look" rendered as "I looked, and it is stale."
#
# It is self-concealing, which is why it survived: `cluster_fence_stale` names a plausible
# cluster condition, so it reads as correct fencing rather than as a failed read, and mini
# showed zero of them — making it look host-specific and benign.
#
# ⛔ POSTURE ON UNVERIFIED: STILL DECLINE, BUT SAY THE TRUE THING.
# The side-effect stays blocked — proceeding on a fence we could not read would defeat the
# guard on exactly the runs it exists for. What changes is that the recorded reason no
# longer asserts a fact this guard did not establish, and a bounded retry runs first,
# because the observed failure was transient (3/3 on re-run: one retry would have avoided
# both of the measured failures).
#
# ⛔ A STALE ANSWER IS NOT RETRIED. Exit 10 is an ANSWER — the fence was read and another
# host owns it. Retrying it would just ask a settled question again, and on a real takeover
# it would delay the bow-out of a zombie worker.
set -uo pipefail
PHASE="" TICKET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)  PHASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Single-host / no token → exact no-op.
[[ -n "${CATALYST_CLUSTER_GENERATION:-}" ]] || exit 0

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SELF_DIR}/../.." && pwd)}"
CLUSTER_CLAIM_CLI="${PLUGIN_ROOT}/scripts/execution-core/cluster-claim.mjs"
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"

# Total attempts = 1 + retries. Only an UNREADABLE fence is retried (see the header).
# Deliberately small: a worker is blocked while this runs, and the observed failure
# recovered on the very next call.
FENCE_RETRIES="${CATALYST_FENCE_CHECK_RETRIES:-2}"
case "$FENCE_RETRIES" in ''|*[!0-9]*) FENCE_RETRIES=2 ;; esac
# ⛔ BASE 10, EXPLICITLY — AND THIS IS AN UNBOUNDED-LOOP BUG, NOT STYLE (Codex on #3685).
# The all-digits check above ACCEPTS a zero-padded value like `08`, and bash reads a leading
# zero as octal: `[[ $attempt -gt 08 ]]` errors with "value too great for base" and the
# construct evaluates FALSE. Measured — with FENCE_RETRIES=08 the break fires at NO attempt
# count, not even 99: the loop runs forever with `sleep $attempt` growing without limit, on
# a worker that is blocked waiting for it. This repo's own rule is that the loop must be
# self-limiting rather than relying on a condition that can fail open.
# `10#` forces base 10; the cap bounds the worst case an operator can ask for
# (10 retries ⇒ 1+2+…+10 = 55s of sleep) so a fat-fingered value cannot wedge a phase.
FENCE_RETRIES=$((10#$FENCE_RETRIES))
[[ $FENCE_RETRIES -lt 0 ]] && FENCE_RETRIES=0
[[ $FENCE_RETRIES -gt 10 ]] && FENCE_RETRIES=10

fence_rc=0
fence_out=""
attempt=0
while :; do
  # ⛔ The output is CAPTURED, never discarded. The CLI's own stderr is the only place the
  # distinguishing reason ("transport-error", an auth message, a parse failure) exists; the
  # old `>/dev/null 2>&1` is what made the two outcomes indistinguishable even in principle.
  fence_out="$(node "$CLUSTER_CLAIM_CLI" fence-check "$TICKET" "$CATALYST_CLUSTER_GENERATION" 2>&1)"
  fence_rc=$?
  [[ $fence_rc -eq 0 ]] && exit 0    # generation current → proceed
  [[ $fence_rc -eq 10 ]] && break    # ANSWERED stale → no retry, bow out below
  attempt=$((attempt + 1))
  if [[ $attempt -gt $FENCE_RETRIES ]]; then break; fi
  echo "${PHASE}: cluster fence UNREADABLE (rc=${fence_rc}, attempt ${attempt}/${FENCE_RETRIES}) — retrying: ${fence_out}" >&2
  sleep "$attempt"   # 1s, then 2s — bounded, and it sleeps rather than spinning
done

if [[ $fence_rc -eq 10 ]]; then
  # The fence was READ and another host owns it. Unchanged behaviour.
  echo "${PHASE}: cluster fence stale (gen=${CATALYST_CLUSTER_GENERATION}) — bowing out, no side-effect" >&2
  "${EMIT}" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "cluster_fence_stale" || true
  exit 10
fi

# The fence was NOT read. Decline the side-effect — but do not claim it was stale.
echo "${PHASE}: cluster fence UNVERIFIED after $((FENCE_RETRIES + 1)) attempts (rc=${fence_rc}, gen=${CATALYST_CLUSTER_GENERATION}) — bowing out, no side-effect; last output: ${fence_out}" >&2
"${EMIT}" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "cluster_fence_unverified" || true
exit 10
