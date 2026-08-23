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

**Then use the verb** — it builds the body, files the ticket, reads it BACK out of Linear, and proves
the decision trigger can parse the options AND that every `--blocks` relation landed. It exits **2**
rather than leaving you an ask that can never be answered, or that answers into the void:

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

⛔ **`--option` (≥2), `--default` and `--blocks` are REQUIRED** (CTL-2157) — the verb refuses without
them. `--blocks` is the load-bearing one: an ask that blocks nothing answers into the void (§3).

Why a verb rather than a documented snippet, field-by-field detail, the raw `linearis` form, and the
exact body grammar: **[`references/creating.md`](references/creating.md)**.

## 3. Answering (the human)

A comment on the ticket — top-level or a threaded reply — reaches the monitor. One word is enough
("A", "yes", "flip now"). Deciding by moving state without a comment is only seen on the next sweep.

**The comment also WAKES the work** (CTL-2157): the daemon fans it out along the ask's `blocks`
relations and unparks each agent waiting on them. Only a human's comment does this.

## 4. Replying (any agent) — the form

⛔ **The threading, identity and 👀 rules are not repeated here.** They are shared by every role and live
in one place: **[`references/threading.md`](references/threading.md)** — one-level threads, the app actor
+ `createAsUser` tag grammar, why `linearis issues discuss` corrupts state, the newest-first sort, and
what a reply must contain. Read it before your first reply.

```bash
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" CTL-NNNN --as <ROLE> --body-file <path>
```

## 5. Closing (the raising agent)

When the answer satisfies the ask, **verify that it does** (e.g. the token really carries the
permission), then:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" accept CTL-NNNN --as <ROLE> --body "accepted — …"
```

It replies in-thread as the app actor and moves the ticket to Done. The two deliberate refusals, the
manual equivalent, and the defect case: **[`references/closing.md`](references/closing.md)**.

## 6. Where things live

- **Reporting to the human:** rank by blast radius (work held × priority), not age — [`references/triage.md`](references/triage.md), `scripts/ask-triage.sh`.
- Ask view **My decisions — what needs me** (a decided item leaves it); the board is a summary, not the record.
- Related skills: `catalyst-dev:linearis`, `catalyst-dev:create-handoff`, `catalyst-dev:steward`.
- Measured Linear facts this SOP rests on (one-level threads CTL-1891; the app actor cannot create
  states/labels/views CTC-626): `references/threading.md` and `references/creating.md`.
