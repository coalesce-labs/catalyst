# The board — the human's one page

`Catalyst on Linear — status board`, a Linear **document**. One row per active scope. Refreshed by the
**hourly pass**, and immediately when an ask changes state.

⛔ **A stale stamp IS a stale board.** Stamp `Last updated` from `TZ=America/Chicago date`, never from
memory and never from the time you *started* the pass. A board that says 14:00 and reflects 12:30 is worse
than no board: the human stops checking the underlying scopes because the page claims to be current.

## The row

| column | source | rule |
| -- | -- | -- |
| scope | the Linear project / initiative | links to the project, not to the status doc |
| headline | the scope's `Status — <scope>` doc, first line | copied, never re-written by you |
| light | 🟢 on track · 🟡 at risk · 🔴 blocked | from the status doc; if the doc is stale, the light is 🟡 **and says the doc is stale** |
| needs you | open asks assigned to that scope's decider | the ask title + one-word options |
| decider | the Linear project's **lead** | rows carry it because a workspace can hold two humans |
| steward | `steward/<slug>` + heartbeat age | red when the heartbeat exceeds 30 min |

⚠️ **The headline is the steward's sentence, not yours.** You aggregate; you do not editorialise. If a
headline is wrong, that is a comment to the steward, not an edit by you — otherwise the board and the
status doc disagree and the human has two pages again, which is the exact failure this role exists to
prevent.

## The hourly pass

1. Read every active scope's status doc (the replica; freshness-gate the `-wal`).
2. Any doc older than **2 hours while its scope is active** → the light is 🟡 and the row says
   *"status doc N h old"*. Page that steward on the channel. Do **not** fix the doc yourself.
3. Re-read every open ask; apply `asks.md`.
4. Stamp, save, and post nothing — **the board is a pull surface**. A channel turn saying "the board is
   updated" is noise the human must read to learn nothing.

## What never goes on the board

- Agent-to-agent reasoning, peer reads, evidence — those are channel turns.
- A steward's dispatch decisions. The board says *where the scope stands*, not *how it got there*.
- Anything the human must act on that is **not** an ask. If it needs them, it is an ask with Options and
  a Default, and it appears under *needs you*. A paragraph asking for attention is not a decision surface.

## Two humans, one board

One board per workspace, one `Concierge — <human>` pinned ticket per human. Rows carry the **decider** so
each human can find their own *needs-you* items. Ryan, as workspace owner, may override anything — record
it in-thread and re-assign the ask; if two humans disagree, the ask goes to the scope's decider quoting
both, and you do not pick.
