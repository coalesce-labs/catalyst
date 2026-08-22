# Orientation

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

The body handles both. Tolerate a missing dispatcher env — do NOT
`: "${CATALYST_TICKET:?}"`-hard-fail the bare sweep.

## Reading the context script banner

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
  may explain a conflict or dependency in one of your items. At N=1 every item is YOURS.

> **Sweep-mode binding.** In the sweep there is NO dispatcher `CATALYST_TICKET`.
> Each `STUCK YOURS <ticket>` line is one per-item context to act on. When you walk
> a YOURS item in Steps 0–4, FIRST bind `TICKET` (and re-resolve `BRIEF` /
> `SIGNAL_FILE` from it) to that item's ticket before authoring anything — the
> authoring shims (`escalation-explain.mjs --ticket`, `recovery-emit.mjs escalated
> --ticket`) reject an empty `--ticket`, so an escalation with `TICKET` still empty
> would silently no-op and leave the goal FALSE.

## Step -1 — Holistic board scan (the delegate's FIRST job)

You are the delegate on watch. Before you touch a single flagged item, take the
operator's-eye view: *is the board actually moving?* Walk these board-level invariants;
for each, print `BOARD <invariant> OK` or `BOARD <invariant> ANOMALY: <what> → <action>`.

> **If your brief carried an injected board context (CTL-1300 holistic dispatch),
> START FROM IT — don't re-derive cold.** The `board context` block already carries
> the scan result. Treat those as the daemon's authoritative findings — confirm and
> ACT rather than re-running the full LogQL/PromQL sweep from scratch.

> **Your eyes here are the sensing substrate.** The copy-paste LogQL/PromQL recipes,
> the silent-daemon detector, and a per-signal diagnose→unstick→file playbook live in
> the **`sensing-substrate`** skill — read `plugins/dev/skills/sensing-substrate/SKILL.md`
> FIRST when you suspect a silent freeze. Run its per-daemon silence sweep + the
> wedge-signal counts, then map any non-zero signal to its playbook row.

1. **Dispatch is live.** Open worker slots AND an eligible/waiting queue AND ~no
   dispatch happening? That's a silent wedge. Check the event log for
   `holding new-work dispatch` warnings.
2. **No worker stuck past normal.** Any worker non-terminal far longer than its phase
   typically takes? Treat it as a stuck item even if not flagged.
3. **The blocked tree is alive.** Walk the blocker tree (LIVE Linear relations — the
   cache misses relation changes entirely). Anything blocked by a ticket that is itself
   unscheduled or stuck means the chain is dead.
4. **No owned project has gone silent.** A project with no movement in expected
   cadence → a finding for the operator.
5. **Rate-limit headroom.** Recent `RATELIMITED` / 429s on the event log? Flag early.
   Read once, cache, batch; never hammer the API while diagnosing.

If the board scan is all-OK and the flagged YOURS set is empty, print `BOARD all-clear`
and stop. Otherwise continue.

> **Verify-before-act (do NOT trust the context-script snapshot).** Before you act on
> or escalate ANY ticket, read its current Linear state via direct SQL against the
> replica (see the `linearis` skill's "Reading Linear" section) — never act on the
> snapshot alone.
