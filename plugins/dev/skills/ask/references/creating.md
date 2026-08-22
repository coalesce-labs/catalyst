# Creating an ask ticket — the exact shape

The body shape below is parsed by the decision trigger (`apps/mirror/src/do/ask-decision.ts`). A body in
any other shape yields **zero** options, and then every reply the human writes is rejected.

- **Team:** the team the decision belongs to. **Assignee = the human** (Ryan:
  `c2a8cc92-cab6-4536-9500-0f24abdf702b`); no delegate.
- **Labels — both, exact names:** `catalyst-ask` + `ask/decision`. Linear labels are **team-scoped**:
  if a team lacks them, create them once (`issueLabelCreate` with the personal token — the app actor
  cannot create labels, measured CTC-626). `catalyst-ask` is what the "Waiting on me" view and the push
  trigger key on; `ask/decision` is the human-readable class.
- **Title:** starts with `ASK:` (or names the click/decision itself); one line a phone can show.
- **Body — the EXACT shape the decision trigger parses** (`apps/mirror/src/do/ask-decision.ts`; a
  body in any other shape gives the trigger ZERO options and every reply is rejected — CTC-653):
  ```markdown
  **Why:** <one paragraph — what it unblocks>

  **Options:**
  - <option A label>
  - <option B label>
  - <option C label>

  **Default if silent:** <what happens if the human never answers>
  ```
  The letters are implicit by bullet order (first bullet = A). Exactly one blank line ends the list.
  Never an irreversible default; those wait for an explicit go. Add relations: `blocks → <work ticket(s)>`.
- **⛔ The verb ENFORCES three of these (CTL-2157), refusing with exit 1 rather than filing:** at least
  **two** `--option` values, a `--default`, and at least one `--blocks`. They were documented here from
  day one and enforced nowhere, so a machine could file an ask with none of them and get exit 0. Each
  hole makes a differently-undead ask: nothing to choose between, silence with no meaning, or — the one
  this epic is named for — **an answer that wakes nobody**.
- **How the human answers so the trigger recognizes it (today's parser):** a reply that IS the letter
  (`A`, `A.`, `option A`) or the option's exact text, or `DECIDED: <free text>`. `(A)` inside a sentence
  is NOT recognized until CTC-653 lands. The trigger is deterministic — no LLM reads the reply (CTC-554).
- Priority 1 if it blocks a live customer path, else 2.

The raw form, for reference (or when you must hand-build):

```bash
linearis issues create "ASK: <one line>" --team CTL --priority 2 \
  --assignee c2a8cc92-cab6-4536-9500-0f24abdf702b \
  --labels "catalyst-ask,ask/decision" \
  --blocks CTL-NNNN \
  --description "$(printf '**Why:** …\n\n**Options:**\n- …\n- …\n\n**Default if silent:** …')"
```


## Gotchas (write path)

- `linearis issues update --labels` fails with *"LabelIds for incorrect team"* when the label exists on
  another team only — create it on this team first.
- A `--relates-to` / `--blocks` list keeps only the LAST flag in some linearis versions — read the
  ticket back after a multi-relation write. `ask.mjs create` does this for you and now **exits 2** when
  a requested relation is missing (it used to print a ⚠️ and exit 0, so an automated caller recorded
  "filed" for an ask whose relation to the work never existed).
- File the ticket BEFORE citing its number anywhere; read the identifier back.


## What an answer DOES (CTL-2157)

An ask is not a notice board: a human comment on it **wakes the agents parked on the tickets the ask
`blocks`**. The daemon's comment-wake (`execution-core/daemon.mjs` → `execution-core/ask-wake.mjs`)
resolves those targets from the local replica — the `blocks` relation **and** the body's `Blocks:` line,
because the two fail differently — and gives each one the same unpark it would have got had the human
commented on it directly.

Two consequences for the raising agent:

- **The `blocks` relation is load-bearing, not decoration.** An ask that blocks nothing answers into the
  void; its work waits forever. ADV-1374/1376 sat for DAYS on exactly that.
- **Only a HUMAN's comment fans out.** The app actor's own comments (the ask body, follow-ups) are
  suppressed — otherwise raising the ask would immediately wake everything it blocks.
