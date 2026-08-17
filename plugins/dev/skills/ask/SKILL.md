---
name: ask
description:
  Ask/decision tickets ("what needs me") — the Catalyst-wide SOP for raising a human decision or action
  as a Linear ticket, replying in-thread as the app actor, and closing it when the answer lands. Use
  whenever an agent needs a human (Ryan) to decide or click something, whenever a human comments on an
  ask ticket, and for any ticket labelled `catalyst-ask` / `ask/decision`.
---

# Ask / decision tickets — SOP (Catalyst-wide)

> Source of the rules: Ryan, 2026-08-15 → 2026-08-17 (rule v3 + the 08-17 additions). Applies to every
> Catalyst-managed Linear project (catalyst, catalyst-cloud, personal-os, …) and to every worker /
> orchestrator / coordinator agent, Claude or Codex. Ticket for the full plugin verb: **CTL-1922**.

## 1. What an ask ticket is

A ticket that exists ONLY to obtain one human decision or one human action. It is **not** the work: the
work lives on its own tickets, which the ask `blocks →`. Anything that reaches the human's board or
summary as "needs you" **must be an ask ticket** — never a status paragraph.

## 2. Creating one (the raising agent)

- **Team:** the team the decision belongs to. **Assignee = the human** (Ryan:
  `c2a8cc92-cab6-4536-9500-0f24abdf702b`); no delegate.
- **Labels — both, exact names:** `catalyst-ask` + `ask/decision`. Linear labels are **team-scoped**:
  if a team lacks them, create them once (`issueLabelCreate` with the personal token — the app actor
  cannot create labels, measured CTC-626). `catalyst-ask` is what the "Waiting on me" view and the push
  trigger key on; `ask/decision` is the human-readable class.
- **Title:** starts with `ASK:` (or names the click/decision itself); one line a phone can show.
- **Body, in this order:** WHY (one paragraph — what it unblocks) · **OPTIONS** (A/B/C, one line each) ·
  **DEFAULT IF SILENT** (what happens if the human never answers — never an irreversible action; those
  wait for an explicit go) · relations: `blocks → <work ticket(s)>`.
- Priority 1 if it blocks a live customer path, else 2.

```bash
linearis issues create "ASK: <one line>" --team CTL --priority 2 \
  --assignee c2a8cc92-cab6-4536-9500-0f24abdf702b \
  --labels "catalyst-ask,ask/decision" \
  --blocks CTL-NNNN \
  --description "WHY: … OPTIONS: (A) … (B) … DEFAULT IF SILENT: …"
```

## 3. Answering (the human)

A comment on the ticket — top-level or a threaded reply — reaches the monitor. One word is enough
("A", "yes", "flip now"). Deciding by moving state without a comment is only seen on the next sweep.

## 4. Replying (any agent) — the form

- **Threaded under the human's comment.** Linear threads are **one level deep** (measured CTL-1891):
  `parentId` must be the ROOT of the thread, so a reply-to-a-reply targets the root; new topic → the
  human posts a new top-level comment.
- **Authored as the app actor ("Catalyst Cloud"), tagged with the agent** (`createAsUser=<AGENT>`).
  Never under the human's identity: `linearis issues discuss` with the personal token posts AS the
  human, and a human-identity comment is what the fleet reads as "the human decided" (it clears
  `needs-human`, CTL-1567).
- **Helper (this plugin):**
  ```bash
  direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" CTL-NNNN --as <AGENT> --body "<markdown>"
  #   --body -          read the body from stdin
  #   --parent <id>     thread under a specific comment (its root is used)
  #   --top             start a new top-level comment
  ```
  Needs `LINEAR_SYNC_CLIENT_ID` / `LINEAR_SYNC_CLIENT_SECRET` (the app's client credentials — the
  catalyst-cloud direnv profile has them); it mints the app-actor token itself.
- Content: what was done in response · the outcome **as applied** (not proposed) · where the artifact
  lives (PR / file / route).

## 5. Closing (the raising agent)

When the answer satisfies the ask: **verify** that it does (e.g. a token really carries the permission),
reply threaded **"accepted — has what it needs"** (or state exactly what is still missing), and **move
the ticket to Done yourself** (`linearis issues update <ID> --status Done`). Downstream work continues
on the work tickets. If the human's action surfaces a defect (CTC-649 → CTC-652), file the defect,
`blocks →` the ask, keep the ask open, say so in the thread.

## 6. Where things live

- Ask view: **My decisions — what needs me** — a decided item leaves it.
- Board (summary, not the record): the "Catalyst on Linear — status board" Linear doc.
- Skills: `linearis` (reads via the replica, writes via the CLI), `create-handoff`, `create-worktree`.
- Measured Linear facts this SOP relies on: threads one level deep (CTL-1891); the app actor cannot
  create states / labels / own views (CTC-626); `createAsUser` requires the app-actor token.

## Gotchas

- `linearis issues update --labels` fails with *"LabelIds for incorrect team"* when the label exists on
  another team only — create it on this team first.
- A `--relates-to` / `--blocks` list keeps only the LAST flag in some linearis versions — read the
  ticket back after a multi-relation write.
- File the ticket BEFORE citing its number anywhere; read the identifier back.
