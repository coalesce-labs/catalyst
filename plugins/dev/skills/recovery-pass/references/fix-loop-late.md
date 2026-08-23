# Steps 2.5–3, Iterate, Inbox, and Router Guardrails

## Step 2.5 — Nothing is actually wrong? LEAVE ALONE (a verdict, not a skip)

Sometimes the honest conclusion is that **no action is needed**: the flag is
stale (the label survived a state the ticket has left), a false positive, or the
ticket is **actively human-driven** (clearing the label or "fixing" the branch
would be actively harmful). That is a real verdict, not a reason to silently move on:

```bash
node "${EXEC_CORE}/recovery-emit.mjs" leave-alone \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" \
  --reason "<one line: why no action is needed — e.g. 'the escalation is stale; the human is actively driving this worktree'>"
```

One call writes all three surfaces: the `recovery.verdict` event, the ledger verdict
`decision:"leave-alone"` — which **refunds the dispatch attempt** and suppresses
re-review for the leave-alone window (default 24h) — and the ticket-visible 🔍 comment
(do NOT post a separate `_rp_comment` for this; the shim posts it). Without this call
the router re-dispatches the same review every cooldown until the 2-strike latch
silently freezes the ticket — the exact act-and-discard failure this verdict exists to close.

LEAVE-ALONE is for "the SYSTEM is wrong about this ticket," never for "I couldn't
figure it out" — that is Step 2 (keep trying) or Step 3 (escalate).

## Step 3 — Escalate ONLY IF one of these is genuinely true

**This is RUBRIC THREE** — the checklist below is its concrete form. Walk it; if NONE
are checked, it is NOT an escalation — go back to Step 1/2 and FIX it. When one IS
genuinely true, Step 4 authors the curated 6-field brief (Rubric Three) for the human.

```
[ ] Value judgment — a product / priority / UX call only the operator can make
    (which of two valid behaviors is "right", whether it's worth doing at all).
[ ] Affects / removes / degrades other functionality — the fix would delete,
    break, or regress another ticket's already-merged feature.
[ ] Real cost-benefit trade-off — a genuine functionality / performance / cost
    trade only the operator can own.
[ ] Serious architecture change — a load-bearing API boundary or structural
    decision, not a local edit.
[ ] Flies in the face of an ADR — the only-correct path contradicts an accepted
    ADR, or is something we've explicitly decided NOT to do autonomously.
[ ] Genuinely cannot do it autonomously after trying — I cannot determine the
    correct resolution, or an external approval/credential I do not hold is
    required.
```

**EXPLICIT RULE (the operator's direction).** Do NOT escalate a mere merge conflict. A
conflict in a file, a CI failure after rebase, a stale branch, a lockfile drift,
or "the PR is just sitting there mergeable" are NEVER escalations. You ARE allowed
and EXPECTED to resolve conflicts, rebase, merge PRs, and re-trigger CI
autonomously. If the message you would write describes a *mechanical state* rather
than a *decision the operator owns*, that is the tell that it belongs in the FIX
path — re-check Step 2.

## Iterate

In sweep mode, repeat Steps 0–4 for every `STUCK YOURS <ticket>` item the context
script printed (skip CONTEXT items — those are another host's). **Bind `TICKET` to
the CURRENT item's ticket at the top of each iteration** (it is NOT the dispatcher
var — that is empty in the sweep) and re-resolve `SIGNAL_FILE` / the per-item brief
from it, so Step 4's `escalation-explain.mjs --ticket "$TICKET"` and
`recovery-emit.mjs escalated --ticket "$TICKET"` carry the real ticket — an empty
`--ticket` is rejected (exit 2) and would leave the item neither FIXED nor ESCALATED,
so the goal would never go TRUE. Stop only when every YOURS item is UNSTUCK,
LEAVE-ALONE-verdicted, or legitimately ESCALATED.

## Mid-flight inbox check (CTL-749)

Before each item and after long actions, read
`${ORCH_DIR}/workers/${TICKET}/inbox.jsonl` (when present): a `directive` answers a
prior question (use it and proceed); a `pause`/`abort` halts you (emit complete
with what's done, or failed on abort). Archive what you absorb.

## How this plugs in under the router's guardrails

recovery-pass is the WORKER; the router (`reasoningRecoveryPass` +
`defaultInvokeRecoveryPass` + the scheduler binding) keeps every guardrail and
this skill plugs in beneath them — exactly where the phase-remediate dispatch sat:

- **Mode gate** — `off | shadow | enforce` from `readRecoveryPassConfig()`
  (`CATALYST_RECOVERY_PASS`). At `off` (the default) the pass never runs — **no
  live behavior change until an operator opts in.**
- **Backlog filter** — only `failed | stalled | unknown`, HRW
  ownership, and the terminal/merged drop. You never see a finished ticket.
- **Caps** — the per-tick fix cap (`maxFixesPerTick`, default 3) and the
  event-counted per-target recovery-pass cycle cap (`countRecoveryPassCycles ≥
  RECOVERY_PASS_CYCLE_CAP`, default 3) both live in the router.
- **Cooldown + escalated-latch + leave-alone TTL** — the host-local intent ledger
  (`shouldSkipItem` / `recordIntent`, 30-min cooldown, max-attempts 2, escalated
  terminal; a leave-alone verdict suppresses re-review for
  `RECOVERY_LEAVE_ALONE_TTL_MS`, default 24h).
- **Decide/act bright line (ADR-022/023/025)** — the router DERIVES the
  classification and owns the cooldown/cap; you ACT and emit the result back to
  the log. You select among real moves; you never spawn an open-ended fixer loop.

## Why recovery-pass is the right name (and not phase-remediate)

phase-remediate (CTL-653) is the in-pipeline verify⇄remediate fixer for one
ticket. recovery-pass (CTL-1176 rung 3) is the goal-driven operator/authoring
layer on top of the deterministic `recovery-reasoning` ladder — it consumes the
diagnostician + unstuck-sweep output, acts across the pipeline, and authors the
operator messages. The dispatcher resolves the phase `recovery-pass` to
`/catalyst-dev:recovery-pass` (the one `skill_for_phase` exception), so the same
skill serves both the router-dispatched and the operator-sweep code paths.
