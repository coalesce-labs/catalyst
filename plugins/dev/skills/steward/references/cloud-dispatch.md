# Dispatch on a CLOUD tenant — you move the card, the cloud runs the phase

`references/dispatch.md` describes the **local** shape: you launch `/relay-ticket <TICKET>` yourself, in a session on this machine. On a Catalyst Cloud tenant that shape is wrong in its first sentence — the phases run in the tenant's runner containers, dispatched by the tenant's own scheduler. **Read this file instead of `dispatch.md` whenever cloud-detection says you are on a cloud tenant** (`references/cloud-detection.md` — a fresh replica *and* a `.catalyst/config.json` marker; both, or you are not).

The difference matters because the two failure modes are opposite. Launch a local session on a cloud tenant and you get two workers on one ticket, racing on the same branch. Wait for a local session on a cloud tenant and you wait forever for a session nobody started.

## The dispatch verb: move the card to Todo, through the write proxy

Your dispatch is a **state move**, not a launch. The tenant's scheduler picks up eligible cards in its Todo state and claims them into a runner container; there is nothing for you to spawn and no PID for you to watch.

Write it through the cloud **write proxy**, never with a personal Linear credential — a proxied write carries the tenant's app actor, which is what keeps your dispatch from reading as the human typing (`ask/references/threading.md` on why that matters, and `linear-write-proxy.mjs` for the client):

```
POST /api/v1/agent/issue-state   {issueId, stateId, hostId}
```

Two things that route deliberately does **not** do for you:

- **It does not resolve a state NAME.** It forwards a `stateId` and nothing else. You resolve the id from this tenant's own `catalyst.linear.stateMap` (`.catalyst/config.json` → the `todo` entry) against the team's workflow states — the replica's `workflow_states` table is the lookup. A name you guessed is how a dispatch lands in another team's Todo.
- **It does not tell you the card was eligible.** The scheduler applies its own gates after your move — ask-shape, scope overlap, a park, a hold. A `succeeded` write is proof the card moved, never proof that work started.

⛔ **Do not launch `/relay-ticket` on a cloud tenant**, and do not open a worktree to "just check something" on a ticket the cloud is running. The container has the branch; your checkout does not.

## Phase-completion evidence: read the record, not a session's word

There is no RELAY REPORT here — no session reports to you at all. The evidence is what the tenant wrote down, and you read all of it from the **replica**, gated for freshness the same way every other read is:

| what you are asking | where the answer is |
| -- | -- |
| did a phase run, and how did it end | the phase-outcome record on the ticket: a `phase.<phase>.complete` / `phase.<phase>.failed` comment written by the app actor (`comments`, `is_bot = 1`) |
| what the phase produced | the artifact projection — the Linear document/attachment the projection layer posts for `research` / `plan` / `validate` (ADR-0060) |
| where the card is now | `issues.state` plus the transition in `issue_history` — a failed phase moves the card to Remediate rather than leaving it where it was |
| is a session narrating right now | `agent_sessions` / `agent_activities` for that ticket |

Two readings that have actually misled a steward here:

- **A ledger row that says `complete` is the phase's own verdict, not a merge.** Read the artifact it names before you treat the phase as done — the same artifact-beats-claim rule `dispatch.md` states for the local path, with the ledger row playing the part the RELAY REPORT plays there.
- **Silence is not a stall.** A container that has claimed the ticket but not yet published writes nothing at all for the length of a phase. Before you nudge, check the card's state and the newest ledger row; `references/stalls.md` is what you do once you have actually established that nothing moved.

## What stays exactly the same

- **A cap is never silent.** Every ticket you could have moved to Todo and did not is named in your plan comment, with the reason.
- **Announce the dispatch on the ticket** — a top-level comment saying it was queued, by whom, and why it was judged ready, with the same explicit "ask me in this thread, do not stall silently."
- **Say `steward/<scope>`**, and post as the app actor. The write path differs; the attribution rule does not.
- **State what you cannot enforce.** You have fewer levers here, not more: the scheduler owns ordering, retries and parks, so a hold you want is a request unless you can point at the gate that holds it.

## Which file governs

| this host | dispatch verb | evidence |
| -- | -- | -- |
| cloud tenant (fresh replica + `.catalyst` marker) | move the card to Todo via the write proxy — **this file** | ledger rows + artifact projections, read from the replica |
| no cloud mirror | launch `/relay-ticket <TICKET>` — `references/dispatch.md` | the RELAY REPORT, confirmed against the artifact it cites |

When you cannot tell which you are on, you have not run cloud-detection yet. Run it; do not pick by feel.
