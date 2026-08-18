# Dispatch — Todo is the verb

## Moving a ticket to Todo IS the dispatch

You do not spawn anything. You change one ticket's state to **Todo**, and the fleet's existing pull-based
scheduler picks it up. This is measured, not theoretical: on 2026-08-18 the fleet pulled two tickets
**19 s and 36 s** after they were moved.

⛔ **Never dispatch a worker directly** — no worktree, no `claude -p`, no phase agent, no `orchestrate`.
Keeping dispatch pull-based is the architectural point of the role, not an implementation detail. If you
find yourself wanting to spawn something, the thing you actually want is a ready ticket.

## Cap at free slots

Dispatch in **priority order**, capped at the fleet's free slots. Dispatching twenty tickets into nine
slots does not make them go faster; it makes the queue unreadable and the holds invisible.

## ⛔ A cap is never silent

**Every ticket that was ready and was not dispatched is named, with the reason.** This is the single rule
most likely to be skipped under time pressure, and it is the one that matters most, because:

> a silent truncation reads as "we covered everything" when it did not.

The reader of your plan comment cannot tell the difference between *held deliberately* and *never looked
at*. Only you can, and only in the moment. Write it down.

Good holds look like this — each names the ticket and gives a reason a reader can disagree with:

| held | why |
| -- | -- |
| CTC-438 | largest new surface on the provisioning path the rehearsal walks today; ready in substance, wrong day |
| CTC-55 | ⛔ its ACs target a retired app — needs re-scoping; I did not rewrite someone else's ticket unasked |
| CTC-439 | first scenario stalls on a copy decision that is the human's; the deliverability half could split out |

## Announce the dispatch on the ticket

A top-level comment on each dispatched ticket: that it was dispatched, by whom, why it was judged ready,
the trap in its ACs if there is one, and an explicit **"ask me in this thread, do not stall silently"**.

⚠️ **Say "moved by `steward/<scope>` via linearis"** while state moves still write with the host's
personal token — otherwise Linear's history records the move as the human's. See the threading reference.

## State what you cannot enforce

If your dispatch note asks workers to hold something — a merge, a surface, an ordering — and you have no
gate that enforces it, **say that in the same breath**. "I have no merge gate and cannot enforce this"
turns a false guarantee into an honest request, and lets whoever depends on it plan for the miss.
