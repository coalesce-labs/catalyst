---
name: recovery-pass
description: |
  Goal-driven senior-engineer pipeline-unstick sweep (CTL-1176 rung 3). Given the
  stuck/failed/needs-human set (or ONE ticket handed by the recovery router), its
  GOAL is to get the pipeline MOVING again — not to fix one ticket's review
  findings (that is phase-remediate). It runs AFTER the eyes (diagnostician
  evidence) and the hands (deterministic unstuck-sweep seams) have already tried,
  and it CONSUMES their output from a recovery-pass.json brief rather than
  re-diagnosing or redoing their narrow work. It acts like a senior engineer with
  full tool access — it resolves merge conflicts, rebases, force-pushes, merges
  green PRs, and re-dispatches stalled phases AUTONOMOUSLY — and escalates to Ryan
  ONLY for a genuine value judgment / something that degrades other functionality
  / a real cost-benefit trade-off / a serious architecture change / an ADR
  conflict. On escalation it AUTHORS the operator inbox row + the push
  notification (executive-voiced). Dispatched as a `claude --bg` job by
  phase-agent-dispatch via slash command, AND invocable bare by Ryan as a sweep —
  hence `user-invocable: true`. Ships behind CATALYST_RECOVERY_PASS (off by
  default — no live behavior change until shadow/enforce).
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
---

# recovery-pass

The agentic top rung of the self-healing recovery ladder (ADR-025 / CTL-1176).
Below it sit two deterministic rungs that have already run:

- **The eyes** — `diagnostician.mjs` `captureEvidence`: the `claude logs` buffer +
  the bg job `state.json` + the worker signal + the belief state, packaged as a
  read-only evidence envelope. It SEES; it does not act.
- **The hands** — `unstuck-sweep.mjs` (Pass 0u) + `unstuck-act-seams.mjs`: a
  narrow, mechanical classify-then-act over four typed categories (dirty-tree,
  source-conflict, orphan-stale, stale-label). It takes ONE mechanical action per
  category.

**recovery-pass is what runs when a thing is STILL stuck after the eyes and hands
tried.** Its job is the cross-pipeline, judgment-bearing moves the narrow passes
cannot make: read both sides of a real merge conflict and resolve it, rebase a
diverged branch and force-push, merge a green PR that is just sitting there,
re-dispatch a phase that died, reconcile an orphan-merged PR — and, only when a
move genuinely requires Ryan, author a clear executive briefing and hand it off.

> **This is NOT phase-remediate.** phase-remediate fixes ONE ticket whose
> `verify` verdict failed, from `verify.json.findings[]`, editing source files in
> place and handing back to a fresh `verify` (cap 3). recovery-pass keeps the
> WHOLE pipeline moving — its scope is the stuck/failed/needs-human set, its input
> is the diagnostician + unstuck output, and its actions are git/gh/dispatch, not
> just Edit/Write. Do not narrow yourself to one ticket's review findings.

## Two invocation modes

1. **Router-dispatched (the bounded-LLM recovery path).** The scheduler's recovery
   pass (CTL-1176, gated by `CATALYST_RECOVERY_PASS`) classifies a stuck ticket as
   `bounded-llm` and dispatches you via `phase-agent-dispatch` with
   `CATALYST_TICKET` set and a `recovery-pass.json` brief already written into the
   worker dir. You own that ONE ticket; resolve it and emit complete.

2. **Operator sweep (Ryan invokes `/catalyst-dev:recovery-pass`).** No dispatcher,
   no `CATALYST_*` env, no pre-written brief. You enumerate the stuck set yourself
   from the worker signals + the unified event log, then walk it. Ryan's words:
   *"Go look at all the things stuck/failed/needing-human and think very hard
   about how to unstick them."*

The body below handles both. Tolerate a missing dispatcher env — do NOT
`: "${CATALYST_TICKET:?}"`-hard-fail the bare sweep.

## Prelude (copy into the running session, adapted per mode)

```bash
set -uo pipefail   # NOT -e: a single ticket's failure must not abort the sweep

# ── Resolve the runtime context, tolerating bare invocation ──────────────────
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-$HOME/catalyst/execution-core}"
ORCH_ID="${CATALYST_ORCHESTRATOR_ID:-recovery-pass}"
PHASE="${CATALYST_PHASE:-recovery-pass}"
TICKET="${CATALYST_TICKET:-}"   # set when router-dispatched; empty for the sweep
CHANNEL="orch-${ORCH_ID}"

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"
EXEC_CORE="${PLUGIN_ROOT}/scripts/execution-core"

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

  # Read the BRIEF — the eyes + hands output. This is the prior-phase artifact the
  # dispatcher gated on. CONSUME it; do NOT re-run the diagnostician or the seams.
  BRIEF="${ORCH_DIR}/workers/${TICKET}/recovery-pass.json"
  if [[ -f "$BRIEF" ]]; then
    echo "recovery-pass: brief = ${BRIEF}"
    echo "--- failure reason ---";        jq -r '.failureReason // "(none)"' "$BRIEF"
    echo "--- diagnosis (eyes) ---";       jq -r '.diagnosis.reason // "(none)"' "$BRIEF"
    echo "--- deterministic seams already tried (hands — do NOT redo) ---"
    jq -r '.deterministicSeamsTried[]? | "- \(.category): \(.outcome) (\(.marker))"' "$BRIEF" || true
    echo "--- guidance ---";               jq -r '.guidance // "(none)"' "$BRIEF"
    echo "--- recent log buffer (truncated) ---"
    jq -r '.diagnosis.logsOutput // "(no logs captured)"' "$BRIEF" | tail -40
  else
    echo "recovery-pass: no brief at ${BRIEF}; reconstructing from signal + logs" >&2
  fi

# ── Operator-sweep mode: enumerate the stuck set ─────────────────────────────
else
  echo "recovery-pass: operator sweep — enumerating the stuck/failed/needs-human set"
  # Worker signals carrying a non-terminal stuck status. Capture each item's
  # ticket + signal path so Steps 0–4 below can BIND a per-item TICKET (the sweep
  # has no dispatcher CATALYST_TICKET — each enumerated item supplies its own).
  SWEEP_ITEMS=()   # "TICKET<TAB>SIGNAL_FILE<TAB>status<TAB>reason" per stuck item
  for s in "${ORCH_DIR}"/workers/*/phase-*.json; do
    [[ -f "$s" ]] || continue
    st="$(jq -r '.status // empty' "$s" 2>/dev/null || true)"
    case "$st" in
      needs-human|failed|stalled)
        it="$(jq -r '.ticket // empty' "$s" 2>/dev/null || true)"
        [[ -n "$it" ]] || it="$(basename "$(dirname "$s")")"
        rsn="$(jq -r '.failureReason // "-"' "$s" 2>/dev/null || echo -)"
        echo "STUCK $it $(basename "$s") status=$st reason=$rsn"
        SWEEP_ITEMS+=("${it}	${s}	${st}	${rsn}")
        ;;
    esac
  done
  # Recovery escalations + would-escalates on the unified log (audit trail of what
  # the deterministic/bounded passes punted) — surfacing the set the narrow sweeps
  # couldn't get past, so the sweep also covers items whose signal was already
  # cleared. Read the monthly JSONL DIRECTLY (catalyst-events `tail` is a
  # long-running follower with a jq `--filter`, not a one-shot history reader);
  # match the canonical envelope shape (`attributes["event.name"]` is the event
  # name; `body.payload.ticket` / `.reason` carry the CTL key + reason).
  EVENTS_FILE="${CATALYST_EVENTS_DIR:-${CATALYST_DIR:-$HOME/catalyst}/events}/$(date -u +%Y-%m).jsonl"
  if [[ -f "$EVENTS_FILE" ]]; then
    echo "--- recovery escalations / would-escalates on the unified log (this month) ---"
    jq -rc 'select((.attributes["event.name"] // "")
              | test("^recovery\\.(escalated|would-escalate)$"))
            | "WOULD-ESCALATE \(.body.payload.ticket // .attributes["event.label"] // "?") \(.attributes["event.name"]) reason=\(.body.payload.reason // "-")"' \
      "$EVENTS_FILE" 2>/dev/null | sort -u \
      || echo "(no recovery escalations on the log)"
  fi
fi
```

> **Sweep-mode binding.** In the sweep there is NO dispatcher `CATALYST_TICKET`.
> Each entry in `SWEEP_ITEMS` is the per-item context. When you walk an item in
> Steps 0–4 below, FIRST bind `TICKET` (and re-resolve `BRIEF` /
> `SIGNAL_FILE` from it) to that item's ticket before authoring anything — the
> authoring shims (`escalation-explain.mjs --ticket`, `recovery-emit.mjs
> escalated --ticket`) reject an empty `--ticket`, so an escalation with `TICKET`
> still empty would silently no-op and leave the goal FALSE. There is no
> pre-written `recovery-pass.json` brief in the sweep — reconstruct the diagnosis
> from the item's signal + `claude logs` yourself (this is the one place the sweep
> re-reads logs, because no diagnostician ran ahead of it).

## /goal condition

Transcript-evaluable (the `/goal` evaluator sees ONLY printed text, never the
filesystem), so the work block must PRINT a per-item resolution line carrying the
proof signal. The goal is the fleet condition — keep iterating until it reads
unequivocally TRUE. No turn-cap self-stop language (CTL-748) — the bounded
envelope is enforced daemon-side.

```
/goal "Every item that was stuck/failed/needs-human at the start of this pass is
       now in ONE of two terminal states, and I have PRINTED a per-item line
       proving it:
         (a) UNSTUCK — I resolved it autonomously (rebased / resolved the merge
             conflict / merged the green PR / re-dispatched the stalled phase /
             reconciled the orphan PR) and printed the resolving action AND its
             success signal (e.g. `gh pr view --json mergeable,state` showing
             CLEAN/MERGED with `exit 0`, or the re-dispatch event id, or
             `git rebase --continue` + push succeeding); OR
         (b) ESCALATED — it meets a legitimate escalation bar (genuine value
             judgment / removes-or-degrades other functionality / real
             cost-benefit trade-off / serious architecture change / conflicts
             with an ADR / I genuinely cannot determine the correct resolution
             after trying), AND I authored the inbox row + the push notification
             for Ryan via recovery-emit.mjs and printed both being written.
       No item remains in an in-between 'still stuck, not yet escalated' state. A
       mere merge conflict / CI failure / stale branch / unmerged-but-green PR is
       NEVER an acceptable escalation — those are (a) and I must resolve them."
```

## Phase-specific work — the senior-engineer unstick loop

Think hard. You are a senior engineer; Ryan is your executive product manager.
Default to ACTING. For each stuck item, walk the decision checklist top-to-bottom;
first match wins. Print a resolution line for every item so `/goal` has signal.

### Step 0 — Consume the eyes + hands output (do NOT redo it)

Read the brief's `diagnosis` (the diagnostician evidence) and
`deterministicSeamsTried` (which seams the hands already ran and that did NOT
clear it). You are picking up where the narrow passes failed — do NOT re-run the
diagnostician and do NOT re-run a seam that is listed as already-tried. If a seam
ran and didn't clear it, the mechanical fix wasn't enough; that's your cue to do
the harder, judgment-bearing move.

### Step 1 — Can a REGISTERED SEAM clear it? (deterministic → FIX, no further work)

If the brief shows a typed mechanical case that did NOT already run its seam,
let the seam handle it. (Orphan PR / stale-sweep → orphan-reconcile; push rejected
no workflow scope → workflow-token-redispatch; sibling conflict CTL-855; orphan/
duplicate PR CTL-1175/1159/1160; ADR-024 hygiene cleaners.) Do not duplicate a
seam that is in `deterministicSeamsTried`.

> **`deterministicSeamsTried` is NOT exhaustive.** It is reconstructed from the
> three on-disk unstuck markers only — `dirty-tree`, `source-conflict`,
> `orphan-stale`. Seams WITHOUT a marker (e.g. `workflow-token-redispatch`, the
> CTL-855 sibling-conflict seam, the ADR-024 cleaners) will NEVER appear there
> even if they ran, so do not read an absence as "this seam has not been tried."
> For those, judge from the diagnosis + the live git/gh state whether the
> mechanical action already took effect (e.g. the branch is already pushed, the
> PR already reconciled) before re-firing — they are idempotent-ish and the
> per-tick/cycle caps bound re-firing, but check first rather than trusting the
> list as complete.

### Step 2 — Resolve it MYSELF with bounded engineering (BOUNDED-LLM → FIX)

You have full tool access. These are ALL things you do autonomously — never
escalate them:

- **Merge / rebase conflict** → read BOTH sides (`git log --merge`,
  `git diff`, the two conflicting hunks). Pick the resolution consistent with this
  ticket's stated goal. If the conflict is purely additive (both sides add
  different things), keep both. `git add`, `git rebase --continue` (or
  `git commit`), then push.
- **Stale / diverged branch** → `git fetch origin && git rebase --autostash
  origin/main`; if it conflicts, treat as the conflict case above; force-push.
- **CI failure after rebase/push** → `gh run view --log-failed`, fix the root
  cause (type error / lint / test), commit, push to re-trigger.
- **A green PR just sitting there** → verify it is CLEAN
  (`gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`), then
  `gh pr merge <n> --squash --delete-branch`.
- **A stalled phase that died mid-flight** → re-dispatch it
  (`phase-agent-dispatch --phase <phase> --ticket <T> --orch-dir <ORCH_DIR>`),
  or re-arm its signal (failed→pending) and wake the scheduler.
- **bun install / cannot find package** → `bun install` in the affected package,
  retry.
- **TypeScript / lint error** → fix it (`/catalyst-dev:validate-type-safety`
  scoped to the diff), retry the phase.

After each action, PRINT the action + its success signal (the `exit 0`, the
`mergeable: "MERGEABLE"`, the merged SHA, the re-dispatch event id) so `/goal`
can see it. Use `gh` and `git` directly; delegate a deeper code fix to
`/catalyst-dev:phase-remediate` or `/catalyst-dev:merge-pr` via the Task tool
when one fits, but YOU own the cross-pipeline moves.

### Step 3 — Escalate ONLY IF one of these is genuinely true

Walk the checklist. If NONE are checked, it is NOT an escalation — go back to
Step 1/2 and FIX it.

```
[ ] Value judgment — a product / priority / UX call only Ryan can make
    (which of two valid behaviors is "right", whether it's worth doing at all).
[ ] Affects / removes / degrades other functionality — the fix would delete,
    break, or regress another ticket's already-merged feature; delivering X
    means undelivering Y.
[ ] Real cost-benefit trade-off — a genuine functionality / performance / cost
    trade only Ryan can own.
[ ] Serious architecture change — a load-bearing API boundary or structural
    decision, not a local edit.
[ ] Flies in the face of an ADR — the only-correct path contradicts an accepted
    ADR, or is something we've explicitly decided NOT to do autonomously.
[ ] Genuinely cannot do it autonomously after trying — I cannot determine the
    correct resolution, or an external approval/credential I do not hold is
    required.
```

**EXPLICIT RULE (Ryan's direction).** Do NOT escalate a mere merge conflict. A
conflict in a file, a CI failure after rebase, a stale branch, a lockfile drift,
or "the PR is just sitting there mergeable" are NEVER escalations. You ARE allowed
and EXPECTED to resolve conflicts, rebase, merge PRs, and re-trigger CI
autonomously. Bring Ryan only the genuine value / architecture / trade-off / ADR
decisions. If the message you would write to Ryan describes a *mechanical state*
(conflict, failed check, stale branch, unmerged PR) rather than a *decision Ryan
owns*, that is the tell that it belongs in the FIX path — re-check Step 2.

### Step 4 — On a legitimate escalation: AUTHOR the two operator messages

This is the part that genuinely differs from phase-remediate. You author what Ryan
sees in the Needs-You inbox AND in the push notification. Two surfaces, ONE
payload, executive-voiced (you are the senior engineer reporting up to the PM).

**Voice (from the `writing:ryan-writing-style` skill — Mode 1 / Mode 2):**
answer-first (lead with the decision needed), plain language (NO stack traces,
seam_ids, signal paths, exit codes, "bg job" in the operator text — translate
mechanics into consequences), name specific things ("CTL-1188 and CTL-1190 both
rewrote `eligible-set.mjs`" beats "a conflict in a shared file"), and STATE WHY
you're asking and not just doing it (the senior-engineer default is to resolve
conflicts/rebases/merges yourself, so justify the exception).

**Pick the escalation type:**

- `decision` — two+ coexisting valid paths; Ryan picks. REQUIRES `options[]`.
- `authorization` — you have a recommendation, but the action removes/degrades
  functionality or carries a real risk Ryan must approve.
- `manual` — a capability/credential/value-judgment only a human has (no clean
  A/B). Prefer `decision`/`authorization` when you actually have a recommendation —
  "needs a human" with no recommendation is the anti-pattern.

**Build the payload with the CTL-1130 shim** (it rejects tautology copy — no
"needs a human", no bare "involves trade-offs"; write the specific question + the
concrete risk):

```bash
EXPL_JSON="$(node "${EXEC_CORE}/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "recovery-pass" \
  --type decision \
  --problem "CTL-1188 and CTL-1190 both rewrote the eligible-set dispatch path; only one shape can ship." \
  --call-to-action "Which dispatch shape should win — per-host pinning or quota-aware?" \
  --options '[{"label":"Keep CTL-1188 per-host pinning","tradeoff":"CTL-1190 quota-aware load balancing must be re-derived on top"},{"label":"Keep CTL-1190 quota-aware","tradeoff":"loses CTL-1188 host pinning that shipped Tuesday"}]' \
  --why-you "both are valid architectures; the choice is a product-priority call, not an engineering one" \
  --observed "$(jq -nc --argjson b "$(cat "$BRIEF" 2>/dev/null || echo '{}')" '$b.diagnosis // {}')" \
  2>/dev/null || echo '{}')"
[ -n "$EXPL_JSON" ] || EXPL_JSON='{}'
```

> **Bash gotcha (CTL-1130).** Guard `EXPL_JSON` on its OWN line and pass the bare
> variable. NEVER inline `${EXPL_JSON:-{}}` — bash closes the expansion at the
> first `}`, corrupting the JSON.

**Emit the escalation through the recovery-emit shim.** It does three things at
once: emits `recovery.escalated` (WARN, severityNumber 13) carrying the rich
payload so the monitor's `notification-composer.ts` (in
`scripts/orch-monitor/lib/`, NOT `${EXEC_CORE}` — the skill never invokes it; the
curation layer does) derives the push `short_text` (≤140) + the inbox
`full_briefing`; merges the payload as the `explanation` block on your signal
(→ `deriveAttention` flips `needs-human` → the inbox row + nav dot + the push gate
`shouldNotify`); and latches the host-local escalated intent (terminal — the
router stops re-acting and hands off to Ryan):

```bash
node "${EXEC_CORE}/recovery-emit.mjs" escalated \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" --phase "recovery-pass" \
  --escalation "$EXPL_JSON"
```

You do NOT call web-push yourself — the curation layer
(`deriveAttention`/`deriveNavSignal` → `shouldNotify` → `/api/notifications/stream`)
gates the push off the `needs-human` + WARN signals you just wrote. The native/PWA
app is a thin transport over that same shared filter; there is no second filter to
satisfy. Print that both the event and the signal explanation were written so
`/goal` sees the escalation landed.

**On an autonomous FIX, record the win for the audit trail** (INFO, no push — the
recovered lane, not a needs-you row). Write a plain past-tense changelog, NOT
engineer chatter:

```bash
node "${EXEC_CORE}/recovery-emit.mjs" fixed \
  --ticket "$TICKET" \
  --reason "Resolved the rebase conflict in eligible-set.mjs by keeping both additions; force-pushed; CI green; merged #2163."
```

### Iterate

In sweep mode, repeat Steps 0–4 for every enumerated `SWEEP_ITEMS` entry,
printing a resolution line each. **Bind `TICKET` to the CURRENT item's ticket at
the top of each iteration** (it is NOT the dispatcher var — that is empty in the
sweep) and re-resolve `SIGNAL_FILE` /the per-item brief from it, so Step 4's
`escalation-explain.mjs --ticket "$TICKET"` and `recovery-emit.mjs escalated
--ticket "$TICKET"` carry the real ticket — an empty `--ticket` is rejected (exit
2) and would leave the item neither FIXED nor ESCALATED, so the goal would never
go TRUE. The goal stays FALSE while any item is "still stuck, not yet escalated",
so keep going. Stop only when every item is UNSTUCK or legitimately ESCALATED.

## Mid-flight inbox check (CTL-749)

Before each item and after long actions, read
`${ORCH_DIR}/workers/${TICKET}/inbox.jsonl` (when present): a `directive` answers a
prior question (use it and proceed); a `pause`/`abort` halts you (emit complete
with what's done, or failed on abort). Archive what you absorb.

## End block (router-dispatched mode — terminal emit)

In router-dispatched mode, emit the terminal event so the scheduler advances and
the bg job is reaped. (In bare sweep mode there is no signal envelope to close —
the printed `/goal` resolution lines are the record.)

```bash
if [[ -n "$TICKET" ]]; then
  EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
  # complete = "I finished the recovery pass on this item" (unstuck OR escalated
  # with the inbox+push authored). The OUTCOME (fixed vs escalated) lives in the
  # recovery.* event + the signal explanation, not in the phase status — mirroring
  # phase-remediate's always-complete-on-a-normal-run semantics. Reserve
  # --status failed for the pass ITSELF breaking (the failure block below).
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

## How this plugs in under the router's guardrails

recovery-pass is the WORKER; the router (`reasoningRecoveryPass` +
`defaultInvokeRecoveryPass` + the scheduler binding) keeps every guardrail and
this skill plugs in beneath them — exactly where the phase-remediate dispatch sat:

- **Mode gate** — `off | shadow | enforce` from `readRecoveryPassConfig()`
  (`CATALYST_RECOVERY_PASS`). At `off` (the default) the pass never runs, so this
  skill is never dispatched — **no live behavior change until an operator opts in.**
- **Backlog filter** — only `needs-human | failed | stalled | unknown`, HRW
  ownership, and the terminal/merged drop. You never see a finished ticket.
- **Caps** — the per-tick fix cap (`maxFixesPerTick`, default 3) and the
  event-counted per-target recovery-pass cycle cap
  (`countRecoveryPassCycles ≥ RECOVERY_PASS_CYCLE_CAP`, default 3) both live in the
  router; you are not re-dispatched past them.
- **Cooldown + escalated-latch** — the host-local intent ledger
  (`shouldSkipItem` / `recordIntent`, 30-min cooldown, max-attempts 2, escalated
  terminal). Your Step-4 escalation latches it via `recovery-emit.mjs`.
- **Decide/act bright line (ADR-022/023/025)** — the router DERIVES the
  classification and owns the cooldown/cap; you ACT (resolve/rebase/merge/
  re-dispatch) and emit the result back to the log. You select among real moves;
  you never spawn an open-ended fixer loop.

## Why recovery-pass is the right name (and not phase-remediate)

phase-remediate (CTL-653) is the in-pipeline verify⇄remediate fixer for one
ticket. recovery-pass (CTL-1176 rung 3) is the goal-driven operator/authoring
layer on top of the deterministic `recovery-reasoning` ladder — it consumes the
diagnostician + unstuck-sweep output, acts across the pipeline, and authors the
operator messages. The dispatcher resolves the phase `recovery-pass` to
`/catalyst-dev:recovery-pass` (the one `skill_for_phase` exception), so the same
skill is both the router's bounded-LLM worker AND Ryan's standalone sweep.
