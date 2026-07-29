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
  green PRs, and re-dispatches stalled phases AUTONOMOUSLY — and escalates to the operator
  ONLY for a genuine value judgment / something that degrades other functionality
  / a real cost-benefit trade-off / a serious architecture change / an ADR
  conflict. On escalation it AUTHORS the operator inbox row + the push
  notification (executive-voiced). Dispatched as a `claude --bg` job by
  phase-agent-dispatch via slash command, AND invocable bare by the operator as a sweep —
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
  - Task  # spawns thoughts-locator / thoughts-analyzer subagents for Rubric One (plan-deliverable read)
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
move genuinely requires the operator, author a clear executive briefing and hand it off.

> **This is NOT phase-remediate.** phase-remediate fixes ONE ticket whose
> `verify` verdict failed, from `verify.json.findings[]`, editing source files in
> place and handing back to a fresh `verify` (cap 3). recovery-pass keeps the
> WHOLE pipeline moving — its scope is the stuck/failed/needs-human set, its input
> is the diagnostician + unstuck output, and its actions are git/gh/dispatch, not
> just Edit/Write. Do not narrow yourself to one ticket's review findings.

## What you're walking into

1. **What's been done before.** The eyes (the diagnostician) and the hands (the
   deterministic unstuck seams) already ran on this — and failed to clear it. You
   are the rung above them; the mechanical fixes were not enough.
2. **What you know.** Router-dispatched: the `recovery-pass.json` brief (the
   eyes+hands output). Sweep: the discovered stuck-set printed by the context
   script (`recovery-pass-context.mjs`) — worker signals + the event log + the
   Linear cache.
3. **Your goal.** Get every stuck item MOVING again. Not "fix one review finding"
   — keep the pipeline flowing.
4. **Your mandate.** You are a senior engineer with full tool access; the operator is your
   executive PM. Default to ACTING: resolve conflicts, rebase, force-push, merge
   green PRs, re-dispatch stalled phases — autonomously.
5. **Your escalation cases.** Bring the operator ONLY the genuine value-judgment /
   degrades-other-functionality / real-cost-benefit / serious-architecture / ADR
   cases (the Step-3 checklist). A mere conflict or failed check is never one.

## Two invocation modes

1. **Router-dispatched (the bounded-LLM recovery path).** The scheduler's recovery
   pass (CTL-1176, gated by `CATALYST_RECOVERY_PASS`) classifies a stuck ticket as
   `bounded-llm` and dispatches you via `phase-agent-dispatch` with
   `CATALYST_TICKET` set and a `recovery-pass.json` brief already written into the
   worker dir. You own that ONE ticket; resolve it and emit complete.

2. **Operator sweep (invoked directly via `/catalyst-dev:recovery-pass`).** No dispatcher,
   no `CATALYST_*` env, no pre-written brief. You enumerate the stuck set yourself
   from the worker signals + the unified event log, then walk it. The operator's framing:
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

The script's banner is your context:

- `MODE=dispatched` → the brief block + tail-of-logs is printed; you own that ONE
  ticket. Go to the Step-0..4 fix loop. (Brief missing → it falls through to a
  ticket-scoped sweep and you reconstruct the diagnosis yourself.)
  - **HOLISTIC dispatch (CTL-1300) — when the brief carries a `board context
    (whole-board, read-only)` block** (printed under the header
    `--- board context (whole-board, read-only) ---`): the
    daemon-side **board-health delegate** (CTL-1290) already ran the Step -1 board
    scan and dispatched you ON a detected board anomaly. Your `CATALYST_TICKET` is
    only the **anchor** (the dispatch handle) — your **mandate is the WHOLE board**,
    exactly like the operator sweep. CONSUME the injected board context as your
    Step -1 result (its slots / eligible-queue / stuck-workers / stranded-nodes /
    invariants are the daemon's findings — do NOT re-derive the scan cold), then
    keep the board moving: walk the anomalies it surfaced and the flagged set, FIX
    or ESCALATE per the 3-tier rope. Verify-before-act still applies to anything
    you touch.
- `MODE=sweep` → a `STUCK YOURS <ticket> [...]` line per owned item, then (when
  multiHost) a `CONTEXT` group of items another host owns, and a
  `TOTAL: N items (M yours, K context)` summary. ACT on the YOURS items — walk
  them all. The CONTEXT items are situational awareness ONLY: do NOT act on them
  (that host owns them — acting would cause cross-host double-action), but they
  may explain a conflict or dependency in one of your items (e.g. "CTL-1190 also
  touched this file"). At N=1 every item is YOURS. There is no pre-written brief —
  see the **Sweep SOP** section below for how to reconstruct each item's
  diagnosis yourself.

> **Sweep-mode binding.** In the sweep there is NO dispatcher `CATALYST_TICKET`.
> Each `STUCK YOURS <ticket>` line the context script printed is one per-item
> context to act on (CONTEXT lines are awareness only — never bind TICKET to one).
> When you walk a YOURS item in Steps 0–4 below, FIRST bind `TICKET` (and re-resolve
> `BRIEF` / `SIGNAL_FILE` from it) to that item's ticket before authoring anything
> — the authoring shims (`escalation-explain.mjs --ticket`, `recovery-emit.mjs
> escalated --ticket`) reject an empty `--ticket`, so an escalation with `TICKET`
> still empty would silently no-op and leave the goal FALSE. There is no
> pre-written `recovery-pass.json` brief in the sweep — reconstruct the diagnosis
> from the item's signal + `claude logs` yourself (this is the one place the sweep
> re-reads logs, because no diagnostician ran ahead of it).

## /goal condition — your self-evaluated stop condition

This is your **self-evaluated stop condition. There is no `/goal` command, and
none can be invoked from a skill or a `claude --bg` session (verified — `/goal`
is not a real Catalyst command, and slash commands do not nest inside a running
skill or a background worker).** Read the block below as a plain-English success
criterion that YOU check your own printed resolution lines against — it is not
handed to any evaluator. (Repo-wide consistency note: any other skill text that
implies a `/goal` evaluator reads printed text is using the same loose shorthand;
treat the success criterion as self-checked there too. Do not edit those skills
from here.)

So PRINT a per-item resolution line carrying the proof signal — that is your own
audit record of the goal being met, and the artifact a later reviewer reads. The
goal is the fleet condition — keep iterating until it reads unequivocally TRUE.
No turn-cap self-stop language (CTL-748) — the bounded envelope is enforced
daemon-side.

```
/goal "THE BOARD IS MOVING. I am the delegate on watch — a senior operator reading
       the whole board the way the operator does — NOT an item-by-item resolver. The flagged
       stuck set is necessary but NOT sufficient: a clean flagged list while the
       board is frozen is still FAILURE. Concretely, ALL of:

       (1) HOLISTIC — I scanned the WHOLE board (Step -1 below) and there is no
           SILENT wedge. For each board-level invariant I confirmed it healthy or
           handled the violation:
             - dispatch is live: open worker slots are FILLING, not held while an
               eligible queue waits (the liveness-hold class — open slots + a
               waiting queue + ~0 dispatch is a wedge, even though no ticket emits
               a 'stuck' signal);
             - no worker is stuck far past normal for its phase;
             - the blocked-dependency tree is alive: nothing is blocked by a ticket
               that is itself unscheduled/stuck (walk the tree);
             - no project I own has gone silent;
             - we are not near a Linear/GitHub rate-limit cliff.
           Every anomaly I FIXED, or — if it is a system-wide change — ESCALATED
           with a briefing (Tier 3 below).

       (2) ITEMS — every item the deterministic eyes+hands flagged as YOURS (HRW-
           owned) is now UNSTUCK (resolved autonomously — rebased / resolved the
           conflict / merged the green PR / re-dispatched the dead phase / reconciled
           the orphan PR), LEAVE-ALONE-verdicted (reviewed healthy — the verdict
           EMITTED via recovery-emit, never just concluded), or ESCALATED. Before
           I ACT on any item I VERIFIED its LIVE
           Linear state (verify-before-act) — never the stale board cache. CONTEXT
           (another host's HRW-owned) items I read for awareness, never act on.

       (3) LEARNING — for anything I had to do that points at an automation gap —
           ESPECIALLY a daemon restart — I filed a finding in the Self-Healing
           Delegate Linear project (Tier-2 below).

       I PRINTED a resolution line per item AND per board anomaly, carrying the proof
       signal (the exit 0 / mergeable:MERGEABLE / merged SHA / re-dispatch event id /
       the finding's ticket id). A mere merge conflict / CI failure / stale branch /
       unmerged-green-PR / stale cache is NEVER an escalation — those are fixes. I
       escalate ONLY genuine value / architecture / trade-off / ADR / system-wide
       decisions."
```

## Sweep SOP — diagnose Catalyst yourself (no brief)

When the context script printed `MODE=sweep`, there is NO pre-written brief: no
diagnostician ran ahead of you, so YOU reconstruct each item's diagnosis from the
local sources before you act. This is the one place you read logs directly. A
minimal senior-engineer onboarding to the machine you are operating:

**Act on YOURS, not CONTEXT.** The script tags each item `YOURS` (you own it under
HRW — act on it) or `CONTEXT` (another host owns it — `owner=<host>`). HRW is a
SOFT signal here: CONTEXT items are kept so you have situational awareness — a
sibling ticket you don't own may explain a conflict or dependency in one of your
items ("CTL-1190 also rewrote this file"). But when multiHost you must NOT act on
a CONTEXT item — that node owns it, and acting would cause cross-host
double-action. Reconstruct + fix only the YOURS items; read CONTEXT items for
context. At N=1 every item is YOURS.

**The pipeline model.** Catalyst ships work through a 9-phase pipeline — triage →
research → plan → implement → verify → review → pr → monitor-merge →
monitor-deploy. Each phase runs as one short-lived `claude --bg` worker. A worker
writes its state to a signal file at `${ORCH_DIR}/workers/<ticket>/phase-*.json`
(`status`, `failureReason`, `bg_job_id`). A ticket is "stuck" when a phase signal
sits at `needs-human`/`failed`/`stalled`, or its worker died with the signal frozen.

**Where to look (per item).**

- **The worker signal** — `${ORCH_DIR}/workers/<ticket>/phase-*.json`: which phase,
  its `status`, its `failureReason`, and the `bg_job_id`.
- **The worker transcript** — `claude logs <shortId>` (the first 8 chars of the
  signal's `bg_job_id`): what the worker actually did and where it stopped.
- **The unified event log** — `~/catalyst/events/YYYY-MM.jsonl`: the surrounding
  phase/recovery events for this ticket (escalations, dispatches, completions).
- **The worktree** — `~/catalyst/wt/catalyst-workspace/<ticket>`: the live branch
  state — `git status`, `git log`, conflict markers, a half-finished rebase.
- **The PR** — `gh pr list --search <ticket>` then `gh pr view <n> --json
  mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`: is there a PR, is
  it green, is it BEHIND/CONFLICTING, is it just sitting there mergeable.
- **The Linear cache** — the `linear-state=…` / `labels=…` the context script
  printed for the item (orientation snapshot only; always verify by reading the ticket
  via direct SQL against the replica before acting — see the Verify-before-act callout).

**Then diagnose like a senior engineer.** From those: what phase is it in? what
failed — a conflict, a failed check, a dead worker, an un-merged green PR, a
stalled dispatch? Is there a PR and what state is it in? Write yourself the
one-line diagnosis the brief would have carried, then drop into the Step-1/2 fix
loop below (skip Step 0's "consume the brief" — you just built it yourself).

**Verify the work, not the status (CTL-1214).** When an item is BLOCKED on a
dependency marked Done, OR itself claims completion but is stuck, do NOT trust the
Done/complete status. Verify the deliverable actually SHIPPED: (a) was a PR whose
SCOPE matches the ticket's deliverable merged to main — check the merged PR's
actual diff (`gh pr view <n> --json files,title` / `gh pr diff <n>`), not just
that *a* PR closed it (an unrelated PR merged under its number is the trap — e.g.
CTL-1214 was marked Done but a cluster-installer PR merged under its number; its
config-reader migration never shipped, wedging SLI-17/OTL-13); and (b) does the
claimed code/artifact actually exist on main (grep/read it)? A "Done" ticket whose
deliverable never shipped is a real finding, not a clean dependency.

**What to do when it didn't ship.** If you can confidently ship the small missing
piece yourself, do it (FIX). If the missing deliverable is load-bearing (a
schema/config migration, a structural change), escalate as a `decision` — reopen
the falsely-Done ticket and ship it first, vs authorize me to do the migration now
— with the inbox+push authored (Step 4). A falsely-Done load-bearing dependency
meets the "serious architecture change" / "genuinely cannot proceed autonomously"
bar; it is NOT a mechanical conflict to merge past.

## Step -1 — Holistic board scan (the delegate's FIRST job)

You are the delegate on watch. Before you touch a single flagged item, take the
operator's-eye view the operator takes: *is the board actually moving?* The flagged stuck
set (the per-item loop below) catches things that emit a stuck signal — but the
worst wedges emit NO item signal at all (the scheduler silently holding dispatch,
a node that stopped participating, a blocker nobody scheduled). A human sees those
in two seconds; your job is to see them too. Walk these board-level invariants; for
each, print `BOARD <invariant> OK` or `BOARD <invariant> ANOMALY: <what> → <action>`.

> **If your brief carried an injected board context (CTL-1300 holistic dispatch),
> START FROM IT — don't re-derive cold.** When the daemon-side board-health delegate
> dispatched you, the `board context (whole-board, read-only)` block already carries
> this scan's result: per-invariant `{ok, failed}`, the stuck workers + ages, the
> stranded nodes + their owned tickets, slots, and the eligible-queue depth. Treat
> those as the daemon's authoritative findings for the invariants below — confirm
> and ACT on them rather than re-running the full LogQL/PromQL sweep from scratch
> (the daemon already paid that cost; re-hammering Loki/Linear is itself a wedge
> cause). Drop to the live queries only to fill a gap the injected context did not
> cover, or to verify-before-act on a specific item you are about to touch.

> **Your eyes here are the sensing substrate — these checks are queries, not vibes.**
> The copy-paste LogQL/PromQL recipes, the silent-daemon detector, and a per-signal
> **diagnose → unstick → file playbook** (each wedge signal → the query that confirms
> it → likely cause → the rope-tier action → the finding to file if it recurs) live in
> the **`sensing-substrate`** skill — read `plugins/dev/skills/sensing-substrate/SKILL.md`
> FIRST when you suspect a silent freeze. Run its per-daemon **silence sweep** + the
> **wedge-signal counts**, then map any non-zero signal to its playbook row. Obey the
> self-constraint there: read once, cache, batch — never hammer Loki/Linear while
> diagnosing (that is itself a wedge cause).

1. **Dispatch is live.** Are there open worker slots AND an eligible/waiting queue
   AND ~no dispatch happening? That's a silent wedge (the liveness-hold class). Check
   the recent scheduler ticks in the unified event log for `holding new-work dispatch`
   warnings, compare live `claude agents` count vs maxParallel vs the "dispatching
   next" queue. If dispatch is frozen: it's usually a daemon/liveness problem → Tier 2
   (restart) or Tier 3 (a system setting like overriding the hold) — NOT a per-item fix.
2. **No worker stuck past normal.** Any worker non-terminal far longer than its phase
   typically takes (e.g. an implement worker idle for tens of hours)? Treat it as a
   stuck item even if it isn't flagged — and as a throughput alarm.
3. **The blocked tree is alive.** For tickets that are blocked, walk the blocker tree
   (LIVE Linear relations — the cache misses relation changes entirely). Anything
   blocked by a ticket that is itself unscheduled (Backlog) or stuck means the chain
   is dead. Surface it; promoting a blocker into the working set auto-dispatches it,
   so for non-trivial blockers PROPOSE (Tier 3) rather than silently promote.
4. **No owned project has gone silent.** A project with no movement in its expected
   cadence → a finding for the operator.
5. **Rate-limit headroom.** Are we near a Linear/GitHub rate-limit cliff (recent
   `RATELIMITED` / 429s on the event log, the per-host key budget)? A rate-limit wedge
   cascades and stalls everyone — flag it early. And obey it yourself: read once,
   cache, batch; never hammer the API while diagnosing.

If the board scan is all-OK and the flagged YOURS set is empty, you are done — print
`BOARD all-clear` and stop (no LLM thrash on a healthy board). Otherwise continue.

> **Verify-before-act (do NOT trust the context-script snapshot).** The
> `linear-state=…` / `labels=…` values the context script printed are an orientation
> snapshot that may lag. Before you act on or escalate ANY ticket, read its current
> Linear state via direct SQL against the replica (see the `linearis` skill's
> "Reading Linear" section) — never act on the snapshot alone. A ticket the context
> shows blocked / needs-human / in a given column may be none of those. Reads → the
> replica; writes → `linearis`.

## The 3-tier rope — how much you may do on your own

The line is simple: **does this change the SYSTEM, or just unstick a stuck THING?**

- **Tier 1 — Just fix it (act silently, log it).** Rebases, merge conflicts, a green
  PR sitting unmerged, re-dispatch a dead phase, clear a stale cache row/label, CI
  fixups. Record the win via `recovery-emit.mjs fixed` (INFO, no push).
- **Tier 2 — Fix it, but FILE a finding.** A **daemon restart** is the canonical case:
  do it autonomously (you ARE allowed to restart a broker / execution-core / monitor),
  but needing a manual restart is the tell we're missing a supervisor — so file an
  automation-gap finding (below). The restart is the band-aid; the finding is the fix.
- **Tier 3 — Ask first (executive briefing → the operator decides → becomes a setting).** Any
  system-wide change: overriding the liveness hold, a global config flip, taking a node
  out of the roster. Escalate via Step 4 with a briefing that REFRESHES the operator on *what
  it is, why we have it, why it's failing, your recommendation* — plain language, no
  jargon. He decides; the decision becomes a durable setting so next time it's Tier 1/2.

## The three delegate rubrics — the senior-engineer judgment gates

The 3-tier rope says *how much* you may do. These three rubrics say *exactly how to
judge* the three hardest cases the delegate faces, and they are the **gating
heuristics you MUST satisfy before any autonomous action** of that kind. They make
the Step 0–4 loop below concrete: Rubric One governs moving a PR-state ticket to
Done, Rubric Two governs finishing a stuck PR yourself vs. escalating, Rubric Three
governs deciding a human is genuinely needed and authoring the brief for them.

> **Consistency with the code (CTL-1157 — THE REVERSAL).** Rubric One's autonomous Done write goes
> through `linear-reconcile-cli.mjs declare … --by "recovery-pass"`, which **now just WRITES the Done
> declaration — there is NO refuse-gate.** The earlier fail-closed open-PR gate (the CLI ran its own
> `gh pr list … --state open` and refused the write, exit 2, nothing persisted, while any non-merged
> PR remained) was the handcuff the owner REMOVED. Done-safety is YOUR judgment as a senior engineer,
> not a mechanical block. `open-pr-gate.mjs` is no longer a gate that refuses — it is an open-PR
> **ENUMERATOR**, a FACTS source you (and the pure-code backstops) read; callers DECIDE. You
> enumerate the ticket's open PRs, reason about and remediate EACH yourself (finish/merge the ones
> that are part of the solution, CLOSE the abandoned/superseded ones), THEN declare Done —
> autonomously, no human in the loop. The hard block is held IN RESERVE. If a Done ever lands while an
> open PR still exists — via a pure-code backstop (`terminalDoneOnce` / the reconcile drain), NOT via
> you — those backstops emit the loud `recovery.done-applied-with-open-pr` alarm (SLICE 3). That
> observability is the signal that would justify reinstating the block, and is exactly why STEP PR-2's
> remediate-every-open-PR work is load-bearing: a clean Done (every open PR finished or closed) is
> silent; a Done-with-open-PR is loud.

### RUBRIC ONE — Done-judgment over a PR-state ticket

> You are a senior engineer with the authority to move a ticket to Done autonomously. This is NEVER a
> mechanical merge→Done, and it is NOT a fail-closed gate that refuses you (the owner removed that
> handcuff — see "Consistency with the code" above). It is a JUDGMENT you make after reading the facts
> and remediating every open PR yourself. The open-PR check is FACTS you read, not an auto-refuse and
> not an auto-escalate. You escalate (Rubric Three) ONLY when an open PR presents a genuine judgment
> call you cannot safely decide — never just because an open PR exists.
>
> **STEP PR-1 — Enumerate ALL the ticket's PRs (open + merged + closed) — the FACTS.** Run `gh pr
> list --search "<TICKET>" --state all --json number,title,state,mergedAt,isDraft,reviewDecision` (a PR
> is merged when `state == "MERGED"` / `mergedAt` is non-null — there is no `merged` JSON field).
> Also read `workers/<T>/phase-pr.json` and `workers/<T>/phase-monitor-merge.json` for `.pr.number`;
> also check `gh pr list --head "<branch>"` (the `ryan/<ticket>-slug` Linear branch — catches human
> PRs whose title omits the key); and the ticket's **Linear attachments** (linked PRs) via
> `catalyst-linear read <T>` (source:replica — NEVER bare `linearis`). Union all PR numbers. The
> facts helper `open-pr-gate.mjs` (`defaultCheckOpenPrs`) already UNIONs exactly these three
> discovery passes (ticket-key search + branch-head + replica attachments) and confirms OPEN state via
> `gh` — it is the single source of truth for "which PRs are still open"; `gh` directly is the manual
> equivalent. The signal file records only the phase-pr agent's OWN PR — never trust it as the
> complete set.
>
> **STEP PR-2 — THE MULTI-PR TRAP: reason about EACH open PR and remediate it YOURSELF.** Do NOT mark
> the ticket Done just because ONE of several PRs merged — a ticket commonly has more than one PR, and
> a single merge says nothing about the others. For EVERY PR in the union with `state:"open"`, make a
> senior-engineer call:
>
> - **Still needed / part of the solution** (it carries deliverable scope that hasn't landed
>   elsewhere) → **FINISH it**: rebase, fix CI, merge it via **Rubric Two**'s rc=0/1/2/3 flow
>   (`rebase_onto_base_classified` + `draft_pr_push_verify` + the green-PR merge). Do NOT close it.
>   If the enumerator printed it as `owner/repo#n` (cross-repo), pass `-R <owner/repo>` on the merge
>   (see Rubric Two) so you don't merge the ticket-repo's same-numbered PR instead.
> - **Abandoned / superseded** (a later PR replaced it, a dead spike, a duplicate, scope dropped) →
>   **CLOSE it yourself**: `gh pr close <n> -R <owner/repo> --comment "<why — superseded by #X /
>   abandoned spike / duplicate of #Y / scope moved to CTL-NNN>"`. ALWAYS pass `-R <owner/repo>` when
>   the open-PR enumerator reported the PR in a repo OTHER than the ticket's own (a cross-repo Linear
>   attachment prints as `owner/repo#n`) — a bare `gh pr close <n>` runs against the ticket's repo and
>   would close the wrong same-numbered PR while leaving the attached one open. Closing a dead PR is an
>   autonomous senior-engineer call, NOT an escalation.
> - **Genuine judgment call** — the open PR conflicts with an ADR/principle you must not override, OR
>   you genuinely cannot safely decide needed-vs-abandoned (e.g. it has truly diverged from a sibling
>   change and only one can coexist, or it's a release-cut decision) → **escalate (Rubric Three)**.
>   This is the ONLY open-PR branch that escalates.
>
> Loop until NO open PR remains that SHOULD remain (every one is finished/merged, or closed, or
> escalated). A stale/BEHIND open PR, a red-CI open PR with a deterministic fix, and an abandoned PR
> are NEVER escalations — you remediate them here.
>
> **STEP PR-3 — Read the plan (deliverable scope).** Spawn the `thoughts-locator` subagent (via the
> Task tool) to find docs in `thoughts/shared/{plans,prs,research}/` mentioning the ticket; spawn
> `thoughts-analyzer` on the most recent plan. Extract the declared deliverable scope (how many PRs,
> what subsystems, any "requires follow-up"/"multi-PR" note). No plan doc → fall back to
> `catalyst-linear read <T>` for the description+title. This is what lets you judge in PR-2 whether an
> open PR is "still needed" vs "abandoned", and in PR-4 whether the merged work actually covers the
> deliverable. If scope is genuinely ambiguous and the call is expensive/hard-to-undo → escalate.
>
> **STEP PR-4 — Deliverable completeness (judgment, not a block).** Cross-reference each merged PR's
> coverage (`gh pr view <n> --json files,title,body`) against the plan's declared deliverable. If a
> plan subsystem is covered by an open PR, that PR was already handled in PR-2. Work that is in NO PR
> at all (never built) and is load-bearing → escalate (`escalation_type:"decision"`: reopen vs. scope
> a new ticket) — do NOT Done over a missing deliverable.
>
> **STEP PR-5 — Children gate.** `catalyst-linear read <T>` → `.children`. Any child in a
> non-terminal state that the plan says is in-scope for this parent → this is a parent tracker; do NOT
> Done it. Surface the open children as the real blockers.
>
> **STEP PR-6 — Mark the ticket Done autonomously (no human in the loop).** Once every open PR is
> finished/merged or closed (PR-2), the deliverable is covered (PR-4), and no non-terminal in-scope
> child remains (PR-5), confirm live state is non-terminal (`catalyst-linear read <T>` —
> verify-before-act), then declare Done. **The CLI surface is POSITIONAL: `declare <TICKET>` — ticket
> is a positional arg, the author flag is `--by` (NOT `--declared-by`), `--state` defaults to `done`.
> There is no `--ticket` flag; an unknown `--` flag makes the CLI error out.**
>
> ```bash
> # Use the catalyst-linear-reconcile WRAPPER (prefers bun, node fallback) — NOT bare
> # `node`. The CLI's default current-state reader imports bun:sqlite; under node it
> # degrades to unknown-current, so a `--state done` write is SKIPPED as
> # "unknown-current-unsafe" WHILE the CLI still exits 0 (it persisted the declaration).
> # That records the ticket Done while Linear stays non-terminal until a later drain —
> # exactly the silent false-Done this rubric must avoid. The wrapper runs bun so the
> # current-state read is real and the Done write actually lands.
> "${EXEC_CORE%/*}/catalyst-linear-reconcile" declare "$TICKET" \
>   --by "recovery-pass" --state done ${BRANCH:+--branch "$BRANCH"} \
>   --prs-closed "$PRS_CLOSED" --prs-kept "$PRS_KEPT" --open-prs-at-done "$PRS_STILL_OPEN"
> ```
>
> Pass your PR-2 tallies so the **Done-moves panel** (SLICE 3) records WHAT you did: `--prs-closed`
> = how many abandoned/superseded PRs you closed; `--prs-kept` = how many you finished/merged as
> part-of-solution; `--open-prs-at-done` = how many are STILL open at the Done (this should be **0**
> for a clean delegate Done — every open PR was finished or closed in PR-2 — and `>0` is the red-line
> that fires the `recovery.done-applied` WARN). These ride the `recovery.done-applied` event
> (`recovery_mode=enforce`, `by=recovery-pass`); they default to 0 if omitted.
>
> This **now just WRITES** — there is NO refuse-gate and it exits 0; the durable declaration is
> dropped regardless of the immediate Linear write (a pending write is retried by the reconcile
> drain). `--state done` is the default (pass it for clarity); pass `--branch "$BRANCH"` when you know
> the Linear branch name. Then record the win:
>
> ```bash
> node "${EXEC_CORE}/recovery-emit.mjs" fixed --ticket "$TICKET" \
>   --reason "Reasoned about every open PR (finished/merged the needed, closed the abandoned); deliverable verified against plan; declared Done."
> _rp_comment "$TICKET" "✅ **recovery-pass** resolved every open PR (merged the needed, closed the abandoned) + verified the plan deliverable → declared Done."
> ```
>
> **The Done write itself no longer fires any ALARM** — that's the point of having done the PR-2 work.
> Two SLICE 3 events distinguish a clean Done from a dirty one: (1) EVERY autonomous Done — yours and
> the pure-code backstops' — emits the broad `recovery.done-applied` (INFO) "Done-moves" event with
> your `prs_closed` / `prs_kept` tallies and `open_prs_at_done`; (2) the loud
> `recovery.done-applied-with-open-pr` (WARN) alarm fires ONLY from the pure-code backstops
> (`terminalDoneOnce` / the reconcile drain) IF a Done lands while an open PR still exists. For YOUR
> Done, `open_prs_at_done` should be **0** — every open PR finished or closed in PR-2 — which keeps the
> Done-moves event INFO and fires no WARN. A Done that lands with `open_prs_at_done > 0` flips the
> event to WARN and is the red-line the panel alarms on. So PR-2 is load-bearing: enumerate-and-remediate
> is what keeps `open_prs_at_done` at 0 and your Done alarm-silent.
>
> **STEP PR-7 — When to escalate instead of Done (genuine judgment ONLY → Rubric Three):**
> a. An open PR conflicts with an ADR/principle you must not override.
> b. You genuinely cannot safely decide an open PR's needed-vs-abandoned (truly-diverged sibling, or a
>    product/release-cut call) — the Gherkin "genuine human decision" case.
> c. Plan declared N PRs; M<N merged, the rest CLOSED — and ship-now-vs-new-ticket is a real call.
> d. Merged-PR diff misses a plan-declared subsystem that's in NO PR (partial, load-bearing deliverable).
> e. Non-terminal in-scope children that the plan owns under this parent.
> f. No plan doc AND ambiguous Linear description — escalate rather than guess.
>
> NOT escalations (you remediate these in PR-2 yourself): a stale/BEHIND open PR (rebase + merge it), a
> red-CI open PR with a deterministic fix (fix it, push, re-check), an abandoned/superseded open PR
> (close it). Mechanically-resolvable ⇒ FIX; genuine-judgment ⇒ escalate.

### PR-not-merged remediation playbook (CTL-1496)

When the recovery-pass brief category is `pr-not-merged` (set by the Phase-2 classifier when
`phase-teardown` failed with `failureReason: "pr_not_merged"`), follow this sub-playbook before
the general Rubric Two logic. The brief already embeds the concrete blockers from the classify-time
probe; re-probe live state at act-time to get the current picture:

```bash
# Re-probe live PR state (read-only; same seam as classifier)
gh pr view --json number,state,mergeStateStatus,mergeable,statusCheckRollup
```

**Step 1 — CI branch** (failing required checks): for each failing check named in the brief:
1. `gh run view --log-failed` to read the failure log.
2. Fix the root cause in code (bounded by the existing attempts cap — see Rubric Two).
3. `git add … && git commit && git push` to re-trigger CI.
4. Re-probe after CI completes; if CLEAN, proceed to Step 3 (merge).

**Step 2 — Review branch** (unresolved bot-review threads): for each unresolved bot thread:
1. Read the thread body — understand the specific finding (file, line, concern).
2. Address the actionable finding in code; commit.
3. Resolve the thread via the `resolveReviewThread` GraphQL mutation (reuse
   `orchestrate-resolve-fixed-threads`'s mutation or call
   `/catalyst-dev:review-comments <PR> --headless`).
4. Post `@codex review` via `plugins/dev/scripts/lib/gh-pr-comment.sh <PR> "@codex review" --idempotent`
   to re-trigger the automated reviewer. Wait bounded (`catalyst-events wait-for`) for re-review.
5. Escalate ONLY a finding that is a genuine judgment call (human `CHANGES_REQUESTED` or a design
   decision you cannot resolve) — write the finding to `.review-escalations.jsonl` and use it as
   the curated escalation brief (PR + thread linked, never the opaque `pr_not_merged` string).

**Step 3 — Merge** (when the probe returns `mergeStateStatus: "CLEAN"`):
- Run `gh pr view <n> --json mergeable,mergeStateStatus` to confirm.
- Run the cluster fence guard: `"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase recovery-pass --ticket <T>`.
- Merge: `gh pr merge <n> --squash --delete-branch`. **NEVER `--admin` or force-merge past a
  failing or pending check** — this is the load-bearing safety property (Rubric Two invariant).

**Step 4 — Escalate** only when:
- A human reviewer (not a bot) left `CHANGES_REQUESTED` → escalate with the reviewer's SPECIFIC
  ask (file, line, and body), PR number linked. Never "Failure reason: pr_not_merged".
- CI persistently red after 3 honest attempts at a genuine design incompatibility → decision
  escalate naming the failing check and the incompatibility.
- The PR was not found (no open PR for the ticket) → escalate with the specific reason.

### RUBRIC TWO — Finish-the-PR vs. escalate

> When you anchor on a stuck PR, you are the senior engineer who unsticks it. Default to FINISHING it.
> Source the lib primitives once: `source "${PLUGIN_ROOT}/scripts/lib/worktree-rebase.sh"` and
> `source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"`. `$BASE` is `origin/<the PR's base branch>`.
>
> **FINISH (do it yourself), bounded engineering:**
> - BEHIND/DIRTY worktree → `rebase_onto_base_classified "$BASE"`, then branch on the rc:
>   - rc=0 (clean/additive) → `draft_pr_push_verify`, re-arm the failed monitor-merge signal to
>     `status:"pending"` (atomic tmp+mv) so the scheduler re-queues it, `recovery-emit fixed`.
>   - rc=1 (fetch fail) → proceed un-rebased; log; NOT an escalation.
>   - rc=2 (source conflict — the ctl708 auto-resolver stub always returns rc=2 for ANY real source
>     conflict) → **resolve it yourself**: `git log --merge`, `git diff`, pick the resolution
>     consistent with the ticket goal, `git add`, `git rebase --continue`, `draft_pr_push_verify`.
>     This is bounded-LLM engineering, NOT an automatic escalation.
> - Green PR just sitting there → `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`,
>   then run the cluster fence guard (`"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase
>   recovery-pass --ticket <T>`), then `gh pr merge <n> --squash --delete-branch`. **When the open-PR
>   enumerator printed this PR as `owner/repo#n` (a cross-repo Linear attachment, a DIFFERENT repo than
>   the ticket's), you MUST pass `-R <owner/repo>` on the view AND the merge (`gh pr merge <n> -R
>   <owner/repo> …`)** — a bare `gh pr merge <n>` runs against the ticket's repo and would merge the
>   wrong same-numbered PR (landing unintended code + deleting its branch) while the attached one stays
>   open. Verify the merge via REST (`gh api repos/<owner/repo>/pulls/<n> --jq '.merged'`) —
>   `--delete-branch` exits non-zero from a worktree even when the squash succeeded.
> - Red CI with a deterministic cause (type error, lint, a flaky test) → fix it, push, re-check
>   (bounded by the attempts cap of 2 — after honest attempts that still fail on a *genuine design
>   incompatibility*, it becomes an escalation, below).
>
> **ESCALATE instead of finishing (→ Rubric Three) when:**
> - rc=3 (thoughts/ symlink conflict) → always escalate (symlink safety; never auto-resolve).
> - `draft_pr_push_verify` rc=3 (workflow-scope OAuth missing, no `CATALYST_WORKFLOW_GITHUB_TOKEN`) →
>   authorization escalate: "add CATALYST_WORKFLOW_GITHUB_TOKEN to claude-accounts.env and re-run".
> - Human reviewer (not a bot) left CHANGES_REQUESTED → authorization escalate with the reviewer's ask.
> - Source conflict spans a load-bearing API boundary (the conflicting hunk is another ticket's merged
>   public contract, not a local impl detail) → decision escalate with both options.
> - CI persistently red after 3+ honest fix attempts where the root cause is a genuine design
>   incompatibility (not a type/lint error) → authorization escalate. **NEVER `--admin` / force-merge
>   past a failing or pending check.** This is the load-bearing safety property.

### RUBRIC THREE — When a human is GENUINELY needed

> Escalate ONLY when you decide one of these is true. Otherwise you keep the board moving yourself.
> Every escalation writes the curated 6-field brief (below) authored FOR the human.
>
> 1. **ADR / principle conflict** — the fix would violate a documented architectural decision or a
>    stated principle. `escalation_type:"decision"`. Name the ADR/principle and the two shapes.
> 2. **Real regression risk** — the only way forward changes a shipped, load-bearing contract another
>    ticket depends on, and you cannot prove the change is safe. `escalation_type:"decision"`.
> 3. **Un-contemplated decision** — the plan/description does not cover the situation and choosing
>    wrong is expensive or hard to undo (e.g. reopen vs. new ticket; ship partial vs. block).
>    `escalation_type:"decision"`.
> 4. **Authority/credential you lack** — `--admin` bypass, a missing OAuth scope/token, a human
>    reviewer's explicit change request, an action outside your granted tools. `escalation_type:"authorization"`.
>
> NOT a reason to escalate: a merge conflict you can resolve; a red CI with a deterministic cause; a
> BEHIND branch; a green PR awaiting merge; a phantom merged-PR ticket whose plan is fully delivered.
> Those you finish yourself.
>
> **The curated 6-field escalation brief.** Every escalation authors these six fields (via
> `escalation-explain.mjs` in Step 4 below — the field → flag map is in parentheses), and they MUST be
> CONCRETE, never tautological:
>
> - `escalation_type` (`--type`) — `decision | authorization | manual`. Prefer the first two when you
>   have a recommendation; bare `manual`/"needs a human" is the anti-pattern.
> - `call_to_action` (`--call-to-action`) — the specific question/action for the operator (NEVER
>   tautological, never "review this ticket").
> - `problem` (`--problem`) — what is stuck and why, ticket-specific (name the files/PRs/tickets).
> - `why_you` (`--why-you`) — why THIS stuck state needs a human: the authorization/credential/
>   value-judgment YOU lack (the senior-engineer default is to fix it yourself, so justify the exception).
> - `why_not_auto` (`--why-not-auto`) — the concrete capability boundary you hit (NEVER "requires
>   human judgment"; name the `--admin` bypass / missing token / ADR clause / coexisting-contract that
>   stopped you).
> - `what_to_do` (`--instructions`, numbered) + `outcome` (`--remediation-then-retry`) — numbered
>   concrete steps for the human, and what happens once they resolve it (the next scheduler tick
>   re-evaluates and re-dispatches).
>
> For a `decision` escalation also pass `--options '[{"label":…,"tradeoff":…}, …]'`. This is the same
> payload the router's curated-brief writer renders into the Needs-You inbox card + the matching Linear
> comment, so a CTL-1157 Gherkin "genuine human decision" row reads as the *decision needed* — never
> "go rebase this".

## Filing a delegate finding (the compounding loop)

Everything you do feeds the **Self-Healing Delegate** Linear project so the system
learns and the wedge-class disappears over time. Two kinds:

- **Intervention record** — "here's something I had to do" — `recovery-emit.mjs fixed
  --ticket <T> --reason "<plain past-tense changelog>"` (audit trail + pattern
  detection).
- **Automation gap** — "here's a Catalyst code change we should make" — file a Gherkin
  ticket (`gherkin-ticket` skill: outcome title `<actor> should <outcome> so that
  <benefit>` + Given/When/Then AC) into the **Self-Healing Delegate** project,
  **Backlog** (never Todo — Todo auto-dispatches), with a component label + estimate.
  ALWAYS file one when you hit Tier 2/3, or any "this shouldn't have been necessary."

## Phase-specific work — the senior-engineer unstick loop

Think hard. You are a senior engineer; the operator is your executive product manager.
Default to ACTING. For each stuck item, walk the decision checklist top-to-bottom;
first match wins. Print a per-item resolution line for every item (your own
self-checked record of the goal — see the /goal condition section).

**Every item ends in exactly ONE of three verdicts, and every verdict is EMITTED
(CTL-1439):** `FIX` (`recovery-emit.mjs fixed`), `LEAVE-ALONE`
(`recovery-emit.mjs leave-alone` — Step 2.5), or `ESCALATE`
(`recovery-emit.mjs escalated` — Step 4). A conclusion that lives only in your
transcript does not exist: the audit found 7/7 sessions reached correct verdicts
and discarded them. Emit the verdict for the ticket you were DISPATCHED for
(`CATALYST_TICKET`); if you also acted on other tickets along the way, emit a
verdict for each of those separately — never tag ticket A's verdict onto ticket B.

### Step 0 — Consume the eyes + hands output (do NOT redo it)

Read the brief's `diagnosis` (the diagnostician evidence) and
`deterministicSeamsTried` (which seams the hands already ran and that did NOT
clear it). You are picking up where the narrow passes failed — do NOT re-run the
diagnostician and do NOT re-run a seam that is listed as already-tried. If a seam
ran and didn't clear it, the mechanical fix wasn't enough; that's your cue to do
the harder, judgment-bearing move.

**PICKUP comment (enforce-only, once per item).** Right after you have the
one-line diagnosis and BEFORE you act, post a soft claim-signal comment on the
ticket so another agent/host does not double-grab it (complements HRW ownership):

```bash
_rp_comment "$TICKET" "🔧 **recovery-pass** is working this — <one-line diagnosis of what's stuck>. Resolving autonomously or escalating."
```

`_rp_comment` is no-op outside enforce and fail-open (a comment failure never
aborts the unstick). Post it exactly ONCE per item — the router's cooldown /
act-once bound already prevents spam.

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
escalate them. **For a stuck PR, follow RUBRIC TWO** (the rc=0/1/2/3 decision over
`rebase_onto_base_classified` + `draft_pr_push_verify`) — it is the authoritative
version of the bullets below. **For a PR-state / phantom merged-PR ticket you think
is "done", do NOT mechanically Done it — run RUBRIC ONE first** (enumerate ALL the
ticket's PRs, reason about and remediate EACH open one yourself — finish/merge the
needed, close the abandoned — read the plan via `thoughts-locator`/`thoughts-analyzer`,
then declare Done autonomously via `declare --by recovery-pass`, which now just writes).

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
  `gh pr merge <n> --squash --delete-branch`. **For a cross-repo PR the enumerator
  printed as `owner/repo#n`, pass `-R <owner/repo>` on both** (`gh pr merge <n> -R
  <owner/repo> …`) — a bare merge targets the ticket's repo and would land the wrong
  same-numbered PR while the attached one stays open.

> **NEVER `--admin` / force-merge past a failing or pending check.** You may merge
> a PR ONLY when its required checks are genuinely GREEN (`gh pr checks <n>` all
> pass). A failing CI check — GitHub Actions, tests, quality, typecheck, lint — is
> a problem to FIX (the "CI failure" bullet above: `gh run view --log-failed`, fix
> the root cause, push, let CI re-run), NOT to bypass. Do NOT pass `--admin` to
> `gh pr merge`, and do not use any other mechanism to override a red or pending
> required check. If CI keeps failing and you genuinely cannot get it green after
> trying, that is a Step-3 escalation ("genuinely cannot do it autonomously after
> trying") — hand it to the operator with what's failing and why; it is NOT a force-merge.
> Bringing the branch to green is the job; overriding the gate never is.

- **A stalled phase that died mid-flight** → re-dispatch it
  (`phase-agent-dispatch --phase <phase> --ticket <T> --orch-dir <ORCH_DIR>`),
  or re-arm its signal (failed→pending) and wake the scheduler.
- **bun install / cannot find package** → `bun install` in the affected package,
  retry.
- **TypeScript / lint error** → fix it (`/catalyst-dev:validate-type-safety`
  scoped to the diff), retry the phase.

After each action, PRINT the action + its success signal (the `exit 0`, the
`mergeable: "MERGEABLE"`, the merged SHA, the re-dispatch event id) as the
per-item resolution line you check the goal against. Use `gh` and `git`
directly; delegate a deeper code fix to
`/catalyst-dev:phase-remediate` or `/catalyst-dev:merge-pr` via the Task tool
when one fits, but YOU own the cross-pipeline moves.

**UNSTUCK comment (enforce-only, once per item).** After a successful FIX, post an
audit + move-it-along comment so downstream agents see the lane is flowing again:

```bash
_rp_comment "$TICKET" "✅ **recovery-pass** unstuck this — <what I did, plain language> → <moved to phase X / merged #Y / re-dispatched>."
```

(Pairs with the INFO `recovery-emit.mjs fixed` audit event below — the comment is
the ticket-visible signal, the event is the log record.)

### Step 2.5 — Nothing is actually wrong? LEAVE ALONE (a verdict, not a skip)

Sometimes the honest conclusion is that **no action is needed**: the flag is
stale (the label survived a state the ticket has left), a false positive, or the
ticket is **actively human-driven** (clearing the label or "fixing" the branch
would be actively harmful — the human is hand-driving that worktree). That is a
real verdict, not a reason to silently move on. Record it:

```bash
node "${EXEC_CORE}/recovery-emit.mjs" leave-alone \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" \
  --reason "<one line: why no action is needed — e.g. 'needs-human label is stale; the human is actively driving this worktree'>"
```

One call writes all three surfaces: the `recovery.verdict` event (the log
record), the ledger verdict `decision:"leave-alone"` — which **refunds the
dispatch attempt** (a reviewed-healthy pass must not burn a fix attempt) and
suppresses re-review for the leave-alone window (default 24h) — and the
ticket-visible 🔍 comment (do NOT post a separate `_rp_comment` for this; the
shim posts it). Without this call the router re-dispatches the same review every
cooldown until the 2-strike latch silently freezes the ticket — the exact
act-and-discard failure this verdict exists to close.

LEAVE-ALONE is for "the SYSTEM is wrong about this ticket," never for "I
couldn't figure it out" — that is Step 2 (keep trying) or Step 3 (escalate).

### Step 3 — Escalate ONLY IF one of these is genuinely true

**This is RUBRIC THREE** — the checklist below is its concrete form. Walk it; if NONE
are checked, it is NOT an escalation — go back to Step 1/2 and FIX it. When one IS
genuinely true, Step 4 authors the curated 6-field brief (Rubric Three) for the human.

```
[ ] Value judgment — a product / priority / UX call only the operator can make
    (which of two valid behaviors is "right", whether it's worth doing at all).
[ ] Affects / removes / degrades other functionality — the fix would delete,
    break, or regress another ticket's already-merged feature; delivering X
    means undelivering Y.
[ ] Real cost-benefit trade-off — a genuine functionality / performance / cost
    trade only the operator can own.
[ ] Serious architecture change — a load-bearing API boundary or structural
    decision, not a local edit.
[ ] Flies in the face of an ADR — the only-correct path contradicts an accepted
    ADR, or is something we've explicitly decided NOT to do autonomously.
[ ] Genuinely cannot do it autonomously after trying — I cannot determine the
    correct resolution, or an external approval/credential I do not hold is
    required. (A persistently-red CI you genuinely cannot get green after trying
    is THIS case — a legitimate escalation, NOT a license to `--admin`-bypass.)
```

**EXPLICIT RULE (the operator's direction).** Do NOT escalate a mere merge conflict. A
conflict in a file, a CI failure after rebase, a stale branch, a lockfile drift,
or "the PR is just sitting there mergeable" are NEVER escalations. You ARE allowed
and EXPECTED to resolve conflicts, rebase, merge PRs, and re-trigger CI
autonomously. Bring the operator only the genuine value / architecture / trade-off / ADR
decisions. If the message you would write to the operator describes a *mechanical state*
(conflict, failed check, stale branch, unmerged PR) rather than a *decision the operator
owns*, that is the tell that it belongs in the FIX path — re-check Step 2. The ONE
CI-related exception is a persistently-red check you genuinely cannot get green
after trying: escalate it (with what's failing and why) — never `--admin`-bypass
it. Bringing the branch to green is the job; overriding the gate never is.

### Step 4 — On a legitimate escalation: AUTHOR the two operator messages

This is the part that genuinely differs from phase-remediate. You author what the operator
sees in the Needs-You inbox AND in the push notification. Two surfaces, ONE
payload, executive-voiced (you are the senior engineer reporting up to the PM).

> **Required on escalation:** the inbox row (summary / ask / options / blocker)
> AND the push notification CTA are BOTH authored via `recovery-emit.mjs` (one
> `escalated` call writes both surfaces off the one payload). An escalation
> without both is INCOMPLETE — the item is not yet terminal and the goal stays
> FALSE.

**Voice (from the `writing:ryan-writing-style` skill — Mode 1 / Mode 2):**
answer-first (lead with the decision needed), plain language (NO stack traces,
seam_ids, signal paths, exit codes, "bg job" in the operator text — translate
mechanics into consequences), name specific things ("CTL-1188 and CTL-1190 both
rewrote `eligible-set.mjs`" beats "a conflict in a shared file"), and STATE WHY
you're asking and not just doing it (the senior-engineer default is to resolve
conflicts/rebases/merges yourself, so justify the exception).

**Pick the escalation type:**

- `decision` — two+ coexisting valid paths; the operator picks. REQUIRES `options[]`.
- `authorization` — you have a recommendation, but the action removes/degrades
  functionality or carries a real risk the operator must approve.
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
payload so the monitor's `notification-composer.ts` (in
`scripts/orch-monitor/lib/`, NOT `${EXEC_CORE}` — the skill never invokes it; the
curation layer does) derives the push `short_text` (≤140) + the inbox
`full_briefing`; merges the payload as the `explanation` block on your signal
(→ `deriveAttention` flips `needs-human` → the inbox row + nav dot + the push gate
`shouldNotify`); and latches the host-local escalated intent (terminal — the
router stops re-acting and hands off to the operator):

```bash
node "${EXEC_CORE}/recovery-emit.mjs" escalated \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" --phase "recovery-pass" \
  --escalation "$EXPL_JSON"
```

You do NOT call web-push yourself — the curation layer
(`deriveAttention`/`deriveNavSignal` → `shouldNotify` → `/api/notifications/stream`)
gates the push off the `needs-human` + WARN signals you just wrote. The native/PWA
app is a thin transport over that same shared filter; there is no second filter to
satisfy. Print that both the event and the signal explanation were written — that
printed line is your record that the escalation landed (the goal's branch (b)).

**ESCALATE comment — posted by the shim (CTL-1439).** `recovery-emit.mjs
escalated` posts the one-line 🔼 ticket comment itself (from the payload's
`call_to_action`), so agents see the item is awaiting a human decision and stop
re-grabbing it. Do NOT post a separate `_rp_comment` for the escalation — that
would double-comment. The full briefing lives in the inbox, not the comment.

**On an autonomous FIX, record the win for the audit trail** (INFO, no push — the
recovered lane, not a needs-you row). Write a plain past-tense changelog, NOT
engineer chatter:

```bash
node "${EXEC_CORE}/recovery-emit.mjs" fixed \
  --ticket "$TICKET" --orch-dir "$ORCH_DIR" \
  --reason "Resolved the rebase conflict in eligible-set.mjs by keeping both additions; force-pushed; CI green; merged #2163."
```

(`--orch-dir` lets the shim record the ledger verdict `decision:"fixed"` —
CTL-1439; without it only the event is written.)

### Iterate

In sweep mode, repeat Steps 0–4 for every `STUCK YOURS <ticket>` item the context
script printed (skip CONTEXT items — those are another host's, awareness only),
printing a resolution line each. **Bind `TICKET` to the CURRENT item's ticket at
the top of each iteration** (it is NOT the dispatcher var — that is empty in the
sweep) and re-resolve `SIGNAL_FILE` /the per-item brief from it, so Step 4's
`escalation-explain.mjs --ticket "$TICKET"` and `recovery-emit.mjs escalated
--ticket "$TICKET"` carry the real ticket — an empty `--ticket` is rejected (exit
2) and would leave the item neither FIXED nor ESCALATED, so the goal would never
go TRUE. The goal stays FALSE while any YOURS item is "still stuck, not yet
escalated", so keep going. Stop only when every YOURS item is UNSTUCK,
LEAVE-ALONE-verdicted, or legitimately ESCALATED.

## Mid-flight inbox check (CTL-749)

Before each item and after long actions, read
`${ORCH_DIR}/workers/${TICKET}/inbox.jsonl` (when present): a `directive` answers a
prior question (use it and proceed); a `pause`/`abort` halts you (emit complete
with what's done, or failed on abort). Archive what you absorb.

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
- **Cooldown + escalated-latch + leave-alone TTL** — the host-local intent ledger
  (`shouldSkipItem` / `recordIntent`, 30-min cooldown, max-attempts 2, escalated
  terminal; a leave-alone verdict suppresses re-review for
  `RECOVERY_LEAVE_ALONE_TTL_MS`, default 24h, and refunds the dispatch attempt).
  Your Step-4 escalation and Step-2.5 leave-alone both latch it via `recovery-emit.mjs`.
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
skill is both the router's bounded-LLM worker AND the operator's standalone sweep.
