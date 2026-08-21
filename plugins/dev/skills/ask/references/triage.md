# Triage — ranking what's waiting on the human, and not duplicating it

Two jobs live here. **Before** you raise an ask: don't create a duplicate. **After** asks exist:
rank them by what they actually hold up, so the human is told what to do first rather than handed
a list.

Both depend on one thing being true: **every ask records what it blocks.** An ask with no `blocks`
relation is structurally unrankable — invisible to every query below, no matter how long it has
waited. Measured 2026-08-21: 2 of 5 open asks had no blocking link, one of them the oldest item on
the human's plate (71h). That is the same class of defect as a body the trigger cannot parse
(see [`creating.md`](creating.md)) — it looks fine on the board and cannot work.

## Before you create: search for an existing ask

One decision should be one ask. When several agents hit the same wall and each files its own, the
human sees N tickets for one decision and each carries a fraction of the true urgency — so the
decision that is actually blocking the most work sorts *below* trivia.

Search open asks before creating (replica only — never the Linear API, it is a shared fleet quota):

```bash
sqlite3 ~/catalyst/catalyst-replica.db "
SELECT i.identifier, i.state, substr(i.title,1,80)
FROM issues i
WHERE i.removed_at IS NULL
  AND i.state NOT IN ('Done','Canceled','Duplicate')
  AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes'))
              WHERE json_extract(value,'\$.name') LIKE '%ask%');"
```

**If an open ask already covers your decision, ATTACH — do not file a second one.** Add a `blocks`
edge from that ask to your work ticket:

```bash
linearis issues update <EXISTING-ASK> --blocks <YOUR-WORK-TICKET>
```

⚠️ `linearis --relates-to` / relation flags drop all but the LAST one — **one relation per
invocation**. Read it back and confirm the edge landed; a relation that silently fails to attach is
the failure this whole page exists to prevent.

Attaching is strictly better than duplicating: it *raises* the existing ask's measured urgency
instead of splitting it, which is what moves it up the human's list.

## Ranking: blast radius, not age

Age is the wrong sort key. "Waiting 71h" and "blocks an urgent production bug" are different facts,
and only the second one tells the human what to do first.

**Blast radius** = how much open work an ask holds up, weighted by that work's priority. Linear
priority is `1=Urgent 2=High 3=Medium 4=Low 0=None`; the weighting below is deliberately steep so
that blocking one urgent ticket outranks blocking three chores:

| blocked ticket priority | weight |
| -- | -- |
| 1 Urgent | 8 |
| 2 High | 4 |
| 3 Medium | 2 |
| 4 Low / none | 1 |

Ready-made:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/ask-triage.sh"      # ranked, with the one-line roll-up
bash "$CLAUDE_PLUGIN_ROOT/scripts/human-blocked.sh"   # genuinely blocked vs missing-link vs phantom label
```

`ask-triage.sh` sorts by weighted score, then by the highest priority it blocks, then by age — and
flags any ask with no blocking link, because that is a data defect to fix, not a low-priority item.

Both scripts gate on replica freshness and warn if it is stale rather than reporting yesterday's
world as today's.

## Reporting it to the human

Do not hand over the list. Lead with the recommendation and the reason, in that order:

> There are 5 things waiting on you. The two that matter: **CTL-2132 first** — it's the only one
> holding up urgent work (blocks CTC-841, P1). Then **CTL-2135**, blocking a high-priority ticket
> that's ready to move the moment you decide. Two others (CTC-709, 71h; CTC-875) don't record what
> they block, so I can't tell you their real cost — that's a gap, not a judgment.

Rules that make this land:
- **Name what to do first and why** — the *why* is the blocked work, not the ask's own age.
- **Say what you cannot rank, and why.** Silence about a 71-hour item reads as "nothing there."
- **Plain English, no internal mechanism names.** The human is deciding a product question, not
  reading a scheduler trace.

## Routing: who to send it to

Today: one human, so every ask goes to Ryan and routing is a no-op. **Deliberately deferred, not
overlooked.** When more than one human can answer, this section gains: how an ask picks its
addressee (scope owner? assignee of the blocked work? explicit `--to`?), what happens when the
addressee doesn't answer, and whether an unrouted ask is an error or falls back to a default owner.
Do not invent that scheme ad-hoc when the second human appears — extend this file.
