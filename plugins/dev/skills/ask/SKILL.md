---
name: ask
description:
  Ask/decision tickets ("what needs me") — the Catalyst-wide SOP for raising a human decision as a Linear
  ticket, replying in-thread as the app actor, and closing it when the answer lands. Use whenever an agent
  needs a human to decide or click something, or for any ticket labelled `catalyst-ask` / `ask/decision`.
---

# Ask / decision tickets — SOP (Catalyst-wide)

> Rules v3 (Ryan, 2026-08-15 → 08-17). Applies to every Catalyst-managed Linear project and every agent,
> Claude or Codex. Full plugin verb: **CTL-1922**.

## 1. What an ask ticket is

A ticket that exists ONLY to obtain one human decision or action. It is **not** the work — that lives on
its own tickets, which the ask `blocks →`. Anything reaching the human as "needs you" **must be an ask**,
never a status paragraph.

## 2. Creating one (the raising agent)

**FIRST — search for an existing ask; one decision should be one ask.** When several agents hit the
same wall and each files its own, the human sees N tickets for one decision and each carries a
fraction of the true urgency, so the decision blocking the most work sorts *below* trivia. If an
open ask already covers your decision, **attach** to it (`linearis issues update <ASK> --blocks
<YOUR-TICKET>`) instead of filing a second one — that raises its measured urgency rather than
splitting it. Search query + ranking: **[`references/triage.md`](references/triage.md)**.

**⛔ ALWAYS pass `--blocks`.** An ask with no `blocks` relation is structurally unrankable — invisible
to every urgency query, no matter how long it has waited. Measured 2026-08-21: 2 of 5 open asks had
no blocking link, one of them the oldest item on the human's plate (71h). Same class of defect as an
unparseable body: looks fine on the board, cannot work.

**Then use the verb** — it builds the exact body, files the ticket, reads it BACK out of Linear, and
proves the decision trigger can parse the options. It exits **2** rather than leaving you a ticket
that can never be answered:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" create \
  --team CTL --priority 2 \
  --title "ASK: <one line>" \
  --why "<what it unblocks>" \
  --option "<option A>" --option "<option B>" \
  --default "<what happens if silent>" \
  --blocks CTL-NNNN
#   --dry-run   print the body and the parsed options without writing
```

⛔ **Why a verb, not a documented snippet:** documenting the shape was not enough. CTC-653 measured that
EVERY ask filed by hand on 2026-08-17 wrote its options inline rather than bulleted. Those parsed to
**zero** options, so no reply could ever match — structurally undecidable, while looking normal.

Full field-by-field detail, the raw `linearis` form, and the exact body grammar:
**[`references/creating.md`](references/creating.md)**.

## 3. Answering (the human)

A comment on the ticket — top-level or a threaded reply — reaches the monitor. One word is enough
("A", "yes", "flip now"). Deciding by moving state without a comment is only seen on the next sweep.

## 4. Replying (any agent) — the form

⛔ **The threading, identity and 👀 rules are not repeated here.** They are shared by every role and live
in one place: **[`references/threading.md`](references/threading.md)** — one-level threads, the app actor
+ `createAsUser` tag grammar, why `linearis issues discuss` corrupts state, the newest-first sort, and
what a reply must contain. Read it before your first reply.

```bash
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" CTL-NNNN --as <ROLE> --body "<markdown>"
```

## 5. Closing (the raising agent)

When the answer satisfies the ask, **verify that it does** (e.g. the token really carries the
permission), then:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" accept CTL-NNNN --as <ROLE> --body "accepted — …"
```

It replies in-thread as the app actor and moves the ticket to Done. Two deliberate refusals, the manual
equivalent, and what to do when the human's action surfaces a defect:
**[`references/closing.md`](references/closing.md)**.

## 6. Reporting to the human (the concierge/steward job)

Never hand over a list. **Rank by blast radius — how much open work each ask holds up, weighted by
that work's priority — then lead with the recommendation and the reason:**

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/ask-triage.sh"      # ranked + the one-line roll-up
bash "$CLAUDE_PLUGIN_ROOT/scripts/human-blocked.sh"   # genuinely blocked vs missing-link vs phantom label
```

> There are 5 things waiting on you. The two that matter: **CTL-2132 first** — it's the only one
> holding up urgent work (blocks CTC-841, P1). Then **CTL-2135**, blocking a high-priority ticket
> ready to move the moment you decide. Two others don't record what they block, so I can't tell you
> their real cost — that's a gap, not a judgment.

Age is the wrong sort key: "waiting 71h" and "blocks an urgent production bug" are different facts,
and only the second tells the human what to do first. Say what you *cannot* rank and why — silence
about a 71-hour item reads as "nothing there". Full method, weights, and the routing question
(deferred while there is one human): **[`references/triage.md`](references/triage.md)**.

## 7. Where things live

- Ask view **My decisions — what needs me** (a decided item leaves it); the board is a summary, not the record.
- Related skills: `catalyst-dev:linearis`, `catalyst-dev:create-handoff`, `catalyst-dev:steward`.
- Measured Linear facts this SOP rests on: threads are one level deep (CTL-1891) and the app actor cannot
  create states/labels/views (CTC-626) — see [`references/threading.md`](references/threading.md) and
  [`references/creating.md`](references/creating.md) (which also carries the write-path gotchas).
