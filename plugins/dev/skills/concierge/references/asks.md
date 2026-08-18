# The ask inbox — from the concierge's side

The ask contract itself is canonical in `ask/SKILL.md` (raise, shape, accept, withdraw). This file is only
what **you** do with the population of open asks.

## Your pass, every hour

For each open ask:

1. **Still live?** The work it blocks may have moved on. A moot ask is the raiser's to withdraw — page
   them; do not withdraw someone else's ask.
2. **Answered but not closed?** The raiser must verify, reply `accepted — …` threaded, and move it Done.
   A human's answer sitting on an open ask is the most common way an ask *looks* stuck when it is not.
3. **Unanswered > 24 h?** → **top of the board**, under *needs you*. ⛔ **An ask never silently expires.**
4. **Irreversible?** Then it is genuinely waiting and the work behind it is stopped — say so on the row.
   Everything else **proceeded on its default the moment it was raised**, so the row reads
   *"proceeding on <default>"*, not *"blocked"*. Those are very different things to a human deciding what
   to look at first, and conflating them is how a board trains its reader to ignore it.

## What you surface, and how

The board's *needs-you* cell is the **title plus the one-word options** — `A / B`, `yes / no`. If the
human has to open the ticket to learn what they are choosing between, the board has not done its job.

⚠️ **A raiser's "I cannot enforce this" is a RISK, not a decision.** Measured: CTC-726 said *"I have no
merge gate"*. That is a fact about the world for the human to weigh — it goes on the row as a risk under
the scope. Turning it into an ask asks the human to decide something nobody can implement.

## What you never do

- ⛔ **Answer an ask.** Not even an obvious one. The whole value of the surface is that the human's word is
  distinguishable from an agent's guess; one answered-by-proxy ask destroys that for every future ask.
- ⛔ Re-assign an ask away from the scope's decider — except on Ryan's explicit override, recorded in-thread.
- ⛔ Let downstream work live on the ask. The ask is a decision, not a task; the work is its own ticket,
  linked `blocks →`.
- ⛔ Batch a **P1** ask into the next window. P1 pushes any hour.
