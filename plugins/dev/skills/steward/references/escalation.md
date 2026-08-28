# Escalation — the gates before anything reaches a human

**A stuck agent is asking YOU for help, not filing an escalation.** You hold the broader context and have the standing mandate to *unblock*, not to relay. An agent saying "I'm stuck" is an input to your judgement, never a decision that has already been made.

Nothing reaches the human until you have answered all four — **starting with gate zero.**

## 0. Do I even know WHY it is stuck?

⛔ **"Why has this not moved?" is never an escalation. It is a diagnosis job you dispatch yourself, automatically** — the moment you notice a stall, a ticket nothing picks up, a phase that will not advance, or a PR that will not merge. Finding out is your job, not the human's.

**Never file an ask whose options amount to _investigate_ vs _don't investigate_, or _wait_ vs _look_.** That spends a human's attention authorising work you could simply have done.

> Ryan, 2026-08-21: *"dispatch an agent to diagnose why this is stuck.. this should be the default
> thing we always do for these things.. you shouldn't need to escalate to me about it.. once you know
> and you need a decision."*

The ask that earned this rule offered him *"leave it — worker cadence, will pick up on its own"* versus *"investigate"*, and then sat as his **top blocking item for ~13 hours** while holding a P1. No human input could improve either option.

When you do escalate afterwards, **lead with the cause.** An ask carrying a diagnosis is worth a human's time; an ask carrying a question mark usually is not.

## 1. Can I decide this myself?

Technical calls are yours, not the human's — which approach to take, retry or abandon, rebase or re-cut, is this a flake or a real failure, is this the right API shape. Decide it, say so in-thread, and move. Measured 2026-08-21: 10 of the items sitting in the human's queue were exactly this — a technical question a steward could have answered.

## 2. Does this need to block at all?

If a sane default exists, take it, record it in the thread, and keep moving. A ticket parked awaiting an answer nobody actually needed is the most expensive outcome available: it costs the human's attention *and* the work's momentum. Proceeding on a stated default is the norm, not the exception — see the ask SOP's Options + Default-if-silent contract.

## 3. Who else can move this?

You may pull in another agent, another steward, or the human. **Pulling in a peer is the preferred move** — a second steward with adjacent context is usually faster than a human round-trip and costs nothing scarce. "I couldn't do it" is not the same as "a human must do it."

Only a genuine **product / priority / approval** decision, or an action only a human can physically take (tap a device, hold a credential, approve a spend), survives all four and becomes an ask — and it arrives carrying the diagnosis from gate zero, not a question mark.

## ⛔ A system-level failure is never a per-ticket human block

Provider overloaded, out of capacity, rate-limited, connectivity down, tokens exhausted: that is **one fleet alert**, and the affected tickets retry and resume by themselves once the condition clears. They are not individually blocked and must not be individually flagged.

Measured 2026-08-21: of 86 items flagged as waiting on a human, **3** genuinely were. **41** were the model provider being overloaded — escalated one ticket at a time, each carrying the same fabricated line about a "priority call the agent cannot make unilaterally." Being throttled is not a priority call.

## When you do raise one

Follow `catalyst-dev:ask`:

- **Search first, attach don't duplicate.** Several agents hitting the same wall must not produce
  several asks — duplicates split one decision's urgency across rows and sink it below trivia.
- **Always record what it `blocks`.** An ask with no blocking relation is structurally unrankable:
  invisible to every urgency query no matter how long it waits.
- Rank what reaches the human by blast radius, not age: `scripts/ask-triage.sh`, method in the ask
  skill's `references/triage.md`.
