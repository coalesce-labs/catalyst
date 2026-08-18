# Routing — who answers, and who never does

The default answer to *"who replies to this?"* is **the steward of that scope**, in-thread, tagged,
within 15 minutes while the scope is active. **Not you, and never the human.**

## The table

| the comment landed on | who replies | you |
| -- | -- | -- |
| a ticket inside a scope a steward owns | that **steward** | route it; stay out of the thread |
| a steward's own plan thread | that **steward**, same root | stay out |
| a worker's ticket, mid-phase | the **steward**; the worker may add a tagged note in the same thread | stay out |
| an initiative or project with **no** steward | **you** — then scaffold one (`scaffold.md`) | reply, then hand over |
| the **board** document | **you** | reply |
| the human's `Concierge — <human>` ticket | **you** | reply |
| a human's comment that contains a **decision** | the scope's steward files it as an **ask** under their comment | surface it on the board |

⛔ **The human never answers their own note.** If a reply would be "yes, as you said" — that is still the
steward's reply to post, not the human's to write. A thread where the human is the last speaker for more
than 15 minutes on an active scope is an SLA miss, not a resolved thread.

## Escalation — inward only

```
instrument  →  steward of the scope  →  concierge  →  human (as an ask)
```

- ⛔ **An instrument that reaches the human directly is a defect.** Board-health, the stalled-PR sweep and
  the comment watcher page the **steward**, threaded, tagged `instrument/<name>`. They never label, and
  they never post into a human's queue.
- **Two silences from the same steward on the same item** (≈ 90 min) → the instrument pages **you** on the
  channel and the doctor goes red. Your call then is **ask vs relaunch** — say which, and why, in a
  channel turn. Relaunching is usually right; an ask is right when the *work* is ambiguous, not the role.
- **You** reach the human only as an **ask**, with Options and a Default.

## Backstopping the backstop

⚠️ **"The concierge posts a holding reply" cannot backstop the concierge.** A 529 wave takes stewards and
concierge together — measured twice on 2026-08-18. So two mechanisms live **outside** the fleet:

- the launchd-live **sentinel** posts the tagged holding reply *"steward/<slug> is being restarted"* at the
  15-minute mark, and the supervisor restarts the role;
- the out-of-fleet **dead-man alarm** fires when there is no concierge heartbeat **and** no channel turn
  for 30 minutes; it pushes the human once and posts on the channel.

Neither is yours to run, and that is the point — you cannot be the thing that notices you are dead.

## Pushes to the human

**P1 asks any hour.** Everything else is batched into the next **07:00–22:00 CT** window. A push is for a
decision; a push that resolves to "just so you know" trains the human to ignore the next one.
