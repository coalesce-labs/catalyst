# Step 4 — Authoring Escalation, End Block, and Failure Handling

## Step 4 — On a legitimate escalation: AUTHOR the two operator messages

This is the part that genuinely differs from phase-remediate. You author what the operator
sees in the Needs-You inbox AND in the push notification. Two surfaces, ONE
payload, executive-voiced (you are the senior engineer reporting up to the PM).

> **Required on escalation:** the inbox row (summary / ask / options / blocker)
> AND the push notification CTA are BOTH authored via `recovery-emit.mjs` (one
> `escalated` call writes both surfaces off the one payload). An escalation
> without both is INCOMPLETE — the item is not yet terminal and the goal stays FALSE.

**Voice:** answer-first (lead with the decision needed), plain language (NO stack traces,
seam_ids, signal paths, exit codes, "bg job" in the operator text — translate
mechanics into consequences), name specific things ("CTL-1188 and CTL-1190 both
rewrote `eligible-set.mjs`" beats "a conflict in a shared file"), and STATE WHY
you're asking and not just doing it.

**Pick the escalation type:**

- `decision` — two+ coexisting valid paths; the operator picks. REQUIRES `options[]`.
- `authorization` — you have a recommendation, but the action removes/degrades
  functionality or carries a real risk the operator must approve.
- `manual` — a capability/credential/value-judgment only a human has. Prefer
  `decision`/`authorization` when you actually have a recommendation.

**Build the payload with the CTL-1130 shim** (it rejects tautology copy):

```bash
EXPL_JSON="$(node "${EXEC_CORE}/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "recovery-pass" \
  --type decision \
  --problem "CTL-1188 and CTL-1190 both rewrote the eligible-set dispatch path; only one shape can ship." \
  --call-to-action "Which dispatch shape should win — per-host pinning or quota-aware?" \
  --options '[{"label":"Keep CTL-1188 per-host pinning","tradeoff":"CTL-1190 quota-aware load balancing must be re-derived on top"},{"label":"Keep CTL-1190 quota-aware","tradeoff":"loses CTL-1188 host pinning that shipped Tuesday"}]' \
  --why-you "both are valid architectures; the choice is a product-priority call, not an engineering one" \
  --why-not-auto "the two merged shapes touch the same public dispatch contract; picking one silently undelivers the other — not a conflict I can resolve without a priority call" \
  --observed "$(jq -nc --argjson b "$(cat "$BRIEF" 2>/dev/null || echo '{}')" '$b.diagnosis // {}')" \
  2>/dev/null || echo '{}')"
[ -n "$EXPL_JSON" ] || EXPL_JSON='{}'
```

> **Bash gotcha (CTL-1130).** Guard `EXPL_JSON` on its OWN line and pass the bare
> variable. NEVER inline `${EXPL_JSON:-{}}` — bash closes the expansion at the
> first `}`, corrupting the JSON.

**Emit the escalation through the recovery-emit shim.** It does three things at
once: emits `recovery.escalated` (WARN, severityNumber 13) carrying the rich
payload so the monitor's `notification-composer.ts` derives the push `short_text`
(≤140) + the inbox `full_briefing`; merges the payload as the `explanation` block
on your signal (→ `deriveAttention` flips `needs-human`); and latches the
host-local escalated intent (terminal):

```bash
node "${EXEC_CORE}/recovery-emit.mjs" escalated \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" --phase "recovery-pass" \
  --escalation "$EXPL_JSON"
```

**ESCALATE comment — posted by the shim (CTL-1439).** `recovery-emit.mjs escalated`
posts the one-line 🔼 ticket comment itself, so agents see the item is awaiting a human
decision and stop re-grabbing it. Do NOT post a separate `_rp_comment` for the
escalation — that would double-comment.

**On an autonomous FIX, record the win for the audit trail** (INFO, no push):

```bash
node "${EXEC_CORE}/recovery-emit.mjs" fixed \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" \
  --reason "Resolved the rebase conflict in eligible-set.mjs by keeping both additions; force-pushed; CI green; merged #2163."
```

## End block (router-dispatched mode — terminal emit)

In router-dispatched mode, emit the terminal event so the scheduler advances and
the bg job is reaped. (In bare sweep mode there is no signal envelope to close —
the printed per-item resolution lines are the record.)

```bash
if [[ -n "$TICKET" ]]; then
  EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
  # complete = "I finished the recovery pass on this item" (unstuck, leave-alone-
  # verdicted, OR escalated with the inbox+push authored). The OUTCOME (fixed vs
  # leave-alone vs escalated) lives in the recovery.* event + the ledger verdict +
  # the signal explanation, not in the phase status — mirroring phase-remediate's
  # always-complete-on-a-normal-run semantics. Reserve --status failed for the
  # pass ITSELF breaking (the failure block below).
  if [[ -x "$EMIT" ]]; then
    "$EMIT" --phase "recovery-pass" --ticket "$TICKET" --status complete
  fi
  # Self-halt to avoid a zombie (CTL-778).
  if [[ -f "${ORCH_DIR}/workers/${TICKET}/phase-recovery-pass.json" ]]; then
    _SELF_BG=$(jq -r '.bg_job_id // empty' \
      "${ORCH_DIR}/workers/${TICKET}/phase-recovery-pass.json" 2>/dev/null || true)
    [[ -n "$_SELF_BG" ]] && claude stop "${_SELF_BG:0:8}" >/dev/null 2>&1 || true
  fi
  [[ -n "${COMMS:-}" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
fi
```

## Failure handling (the pass ITSELF broke)

Only when the recovery pass cannot run (not when a single item is a legitimate
escalation — that goes through Step 4). Author a CTL-1130 explanation, then emit
`failed` with `--status failed`:

```bash
if [[ -n "$TICKET" ]]; then
  REASON="${1:-recovery-pass failed}"
  EXPL_JSON="$(node "${EXEC_CORE}/escalation-explain.mjs" \
    --ticket "$TICKET" --phase "recovery-pass" \
    --type authorization \
    --problem "the recovery pass could not run on ${TICKET}: ${REASON}" \
    --call-to-action "should ${TICKET} be re-dispatched, fixed by hand, or closed?" \
    --recommendation "re-run the recovery pass after the underlying tooling failure clears" \
    --risk "the ticket stays stuck and consumes attention until someone looks" \
    --why-asking "tooling failure, not a value judgment" \
    --authorize-label "re-run recovery on ${TICKET}" --can-execute true \
    2>/dev/null || echo '{}')"
  [ -n "$EXPL_JSON" ] || EXPL_JSON='{}'
  node "${EXEC_CORE}/recovery-emit.mjs" escalated \
    --ticket "$TICKET" --orch-dir "$ORCH_DIR" --phase "recovery-pass" --escalation "$EXPL_JSON" || true
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "recovery-pass" --ticket "$TICKET" --status failed --reason "$REASON"
  exit 1
fi
```
