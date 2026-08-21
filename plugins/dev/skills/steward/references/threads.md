# Threads — where a steward's words go

⛔ **The threading and identity rules are NOT restated here.** They are shared by every role and live in
one place: **`plugins/dev/skills/ask/references/threading.md`** — one-level threads, the app actor +
`createAsUser` tag grammar, why `linearis issues discuss` corrupts state, the newest-first sort, 👀 on
pickup, and what a reply must contain. Read it first. This file covers only what is specific to a steward.

## Your three surfaces, and what belongs on each

| surface | audience | what goes there |
| -- | -- | -- |
| **ticket threads** | workers, the human | the record. Decisions, answers, nudges, dispatch notes, closes |
| **the status doc** | the human | the summary. Never a decision that is not also on a ticket |
| **the channel** | other agents | roll-ups, evidence, contradictions, hand-offs. Numbered and signed |

**Precedence:** the ticket thread is the record. **A decision that is not on a ticket did not happen** —
the status doc and the channel both summarise it, neither replaces it.

## The plan comment

**ONE** top-level comment per scope, titled `Steward — <date> · <scope>`. Every later message from you
about that scope is a **threaded reply under it**. That is what makes a project's coordination readable
months later instead of being a wall of top-level comments interleaved with everyone else's.

Exception: a message that belongs to a *specific ticket* (an answer to a worker, a nudge, a close) goes
in **that ticket's** thread, not under your plan comment. The plan thread is for scope-level narration.

## Channel turns

Append-only markdown. **Re-read the tail before appending** — you are one of many writers, and the state
you are about to report on may already have been contradicted.

```
## Turn <LANE>-N — <LANE> → @addressees: <headline>
…
— <LANE>, <date> <time> CT
```

House rules that matter more than the format:

- **No agreement without an artifact.** "Sounds right" is not a turn.
- **State evidence, or state uncertainty.** Both are useful; a confident guess is not.
- `RESOLVED: <item>` closes an item you previously raised.
- `TZ=America/Chicago date`, never estimated.
- Docs are for humans; the channel is agent-to-agent. Don't write one in the other's voice.

## Answering a worker

Answer the question. **Do not re-do the worker's job** — you are not a second implementer, and a steward
who starts editing code has stopped being a steward. If the answer is "you're right, the ticket is
wrong", fix the ticket and say so in the thread with a link to the change.

## Answering a human

Under the **root of their comment**, within 15 minutes while your scope is active. Content is fixed:
what was done · the outcome as applied · where the artifact lives. If the answer needs a decision only
they can make, file the ask, link it in your reply, and say what default you are proceeding on.
