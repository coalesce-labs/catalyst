# Threading and identity in Linear — the canonical copy

Every Catalyst agent that writes anything a human can see follows this file. It is the single source: the `steward`, `concierge` and `phase-*` skills link here and must not restate these rules in their own words. Two copies of a rule is how they drift.

## Threads are one level deep

Linear threads have exactly one level (measured, CTL-1891). `parentId` must be the **root** of a thread, never another reply. So:

- Replying to a reply → target that thread's **root**.
- A new topic → a **new top-level comment**. Burying a new question inside an old thread still gets it
  answered, but under the old root.
- Default target when picking up a human message: the **root of the most recent human comment**.

## Who the comment is from

- Author every human-visible write as the app actor **"Catalyst Cloud"**, tagged with the role via
  `createAsUser=<role>`.
- ⛔ **Never post under the human's identity.** `linearis issues discuss` uses the personal token and
  posts *as* the human — and a human-identity comment is what the fleet reads as "the human decided", which clears the escalation hold (CTL-1567). It is not a style preference; it corrupts state.
- ⛔ **An agent never answers the human's own note as the human.** If a human comment needs a decision
  only that human can make, it comes back as an ask ticket, not as a reply written in their voice.

### Tag grammar

| role | tag |
| -- | -- |
| tier 1 — the one agent the human talks to | `concierge` |
| tier 2 — one per initiative/project | `steward/<scope-slug>` |
| tier 3 — per ticket, per phase | `worker/<phase>` |
| an instrument (pages a role, never a human) | `instrument/<name>` |

The tag is what appears in `botActor.userDisplayName`, so **the tag is the vocabulary** — it is recorded as an ADR before it ships, because history cannot be re-tagged.

## The helper (do not hand-roll the write)

```bash
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" CTL-NNNN --as <ROLE> --body-file <path>
#   --body-file <path>  post the FILE'S CONTENTS (preferred for anything multi-line)
#   --body "<markdown>" post a literal string
#   --body -            read the body from stdin
#   --parent <id>       thread under a specific comment (its ROOT is used)
#   --top               start a new top-level comment
```

⛔ **Write the body to a file, then pass it with `--body-file` — never with `--body`.** This guard exists because the file-first habit produced 23 published comments whose entire body was a tmp path, across 16 tickets, before CTL-2204.

⚠️ **The guard is a backstop, not the guarantee — `--body-file` is.** `--body` refuses (exit 2) only a string that is *provably* the mistake: **absolute or `~/`-rooted**, **whitespace-free**, and **naming a file that exists** (an existence probe that cannot answer — EACCES, ELOOP — also refuses, since refusing a path-shaped string is recoverable and posting one is not). That narrowness is deliberate: it is what keeps a real one-word markdown body from ever tripping the guard, and every one of the 23 measured incidents had that shape. So a **relative** path (`tmp/reply.md`), a path that does **not exist**, or one **containing a space** is accepted as the literal body and published verbatim. Do not treat "`--body` would have caught it" as a reason to reach for `--body`; reach for `--body-file`.

The helper posts through the cloud write proxy as the app actor and needs no client credentials of its own (CTL-1958); it requires `CATALYST_LINEAR_WRITE_PROXY=enforce` plus a cloud token, and refuses under any other resolution.

## Acknowledging with 👀

The human is looking at the **last message they wrote**, not the top of the thread.

- **On pickup** — the moment you start reading a human comment — react `eyes` on that human's **latest**
  comment: `node "$CLAUDE_PLUGIN_ROOT/scripts/linear-ack.mjs" <ISSUE>` (app actor). It means "read, working on it", not "resolved".
- **On reply** — `linear-reply.mjs` removes the eyes automatically when the reply posts (`--keep-eyes`
  to leave it).

⚠️ **Linear returns comments newest-first.** Sort explicitly before choosing "the latest human comment". Both helpers do; anything you write yourself must too — acking the oldest message has already happened. Only the human's own comments count (`ASK_HUMAN_ID`, default Ryan); the decision trigger's replies carry a `user` field too and will fool a naive check.

## What a reply says

Three parts, always, so a human can skim:

1. **what was done**,
2. **the outcome as applied** — not proposed, not "will do",
3. **where the artifact lives** (PR / file / route / ticket).

A reply that says "will do" is not a reply. Post it when the artifact exists, threaded under the same root.

## Claiming

Before starting work on a scope: set the assignee on the tracking ticket **and** 👀 the human's latest comment. A claim that is only in your own head is invisible to every other agent.

## Reads and writes

- **Reads → the local replica behind a freshness gate on the `-wal` mtime**, never the Linear API. The
  `.db` mtime lags under WAL mode, so gating on it reads a live replica as stale. See the `linearis` skill.
- **Writes → `linearis` / the cloud proxy.** Under the CTL-1961 gate every host write rides the proxy.

| proxy route | status |
| -- | -- |
| `issue-comment`, `issue-state`, `issue-label`, `me/ask-answer` | exists |
| `reaction`, general `issue-create` | ⚠️ not yet — FLEET-30 / COORD-173 |

⚠️ **Until the routes land, state moves via `linearis` attribute to the human**, because the CLI writes with the host's personal token. Two consequences, both required:

1. Say **"moved by `<role>` via linearis"** in the accompanying comment, so the history reads honestly
   (COORD-179).
2. Treat this as a known attribution defect, not as license — it is exactly why the proxy routes exist.

## Cite only what exists

File the ticket, read the identifier back out of the create call, **then** cite it. Citing a number you have not created yet is not a harmless placeholder: identifiers are dense, so a guessed one is usually a real, unrelated ticket, and the pointer looks plausible while being wrong.
