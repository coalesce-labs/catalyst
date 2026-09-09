# Creating an ask ticket — the exact shape

The body shape below is parsed by the decision trigger (`apps/mirror/src/do/ask-decision.ts`). A body in any other shape yields **zero** options, and then every reply the human writes is rejected.

- **Team and assignee come from THIS tenant's config, never from a literal you copy out of
  here (CTL-2299).** The team is `catalyst.linear.teamKey` and the assignee is `catalyst.human.linearUserId`, both read from `.catalyst/config.json` (or the per-machine `~/.config/catalyst/config.json`); `ask.mjs create` resolves both for you, and `--team` is only for the case where the decision belongs to a team other than the repo's own. There is no default human — an unconfigured tenant gets a named refusal, because an ask assigned to a user who does not exist on that workspace files cleanly and reaches nobody. No delegate: the assignee is the human.
- **Labels — both, exact names:** `catalyst-ask` + `ask/decision`. Linear labels are **team-scoped**:
  if a team lacks them, create them once (`issueLabelCreate` with the personal token — the app actor cannot create labels, measured CTC-626). `catalyst-ask` is what the "Waiting on me" view and the push trigger key on; `ask/decision` is the human-readable class.
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
  The letters are implicit by bullet order (first bullet = A). Exactly one blank line ends the list. Never an irreversible default; those wait for an explicit go. Add relations: `blocks → <work ticket(s)>`.
- **⛔ The verb ENFORCES three of these (CTL-2157), refusing with exit 1 rather than filing:** at least
  **two** `--option` values, a `--default`, and at least one `--blocks`. They were documented here from day one and enforced nowhere, so a machine could file an ask with none of them and get exit 0. Each hole makes a differently-undead ask: nothing to choose between, silence with no meaning, or — the one this epic is named for — **an answer that wakes nobody**.
- **How the human answers so the trigger recognizes it (today's parser):** a reply that IS the letter
  (`A`, `A.`, `option A`) or the option's exact text, or `DECIDED: <free text>`. `(A)` inside a sentence is NOT recognized until CTC-653 lands. The trigger is deterministic — no LLM reads the reply (CTC-554).
- Priority 1 if it blocks a live customer path, else 2.

The raw form, for reference (or when you must hand-build). Read the two identities out of the config rather than typing them — a pasted id is how a single-tenant assumption spreads:

```bash
cfg=.catalyst/config.json
team=$(jq -r '.catalyst.linear.teamKey' "$cfg")
human=$(jq -r '.catalyst.human.linearUserId' "$cfg")
# ⛔ CTL-2300: the label NAMES are the tenant's too, and they are team-scoped in Linear —
# `node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs"` resolves them to ids ON THIS TEAM. Typing them
# resolves against whichever team linearis picked, which fails loudly across teams and
# silently within one.
labels=$(node -e 'import("'"$CLAUDE_PLUGIN_ROOT"'/scripts/lib/board-vocabulary.mjs").then(m=>console.log(m.resolveAskLabelNames().names.join(",")))')
linearis issues create "ASK: <one line>" --team "$team" --priority 2 \
  --assignee "$human" \
  --labels "$labels" \
  --blocks "$team-NNNN" \
  --description "$(printf '**Why:** …\n\n**Options:**\n- …\n- …\n\n**Default if silent:** …')"
```


## Why a verb, not a documented snippet

Documenting the body shape was not enough. CTC-653 measured that EVERY ask filed by hand on 2026-08-17 wrote its options inline rather than bulleted. Those parsed to **zero** options, so no reply could ever match — structurally undecidable, while looking entirely normal. `ask.mjs create` is the shape.


## Gotchas (write path)

- `linearis issues update --labels` fails with *"LabelIds for incorrect team"* when the label exists on
  another team only — create it on this team first.
- A `--relates-to` / `--blocks` list keeps only the LAST flag in some linearis versions — read the
  ticket back after a multi-relation write. `ask.mjs create` does this for you and now **exits 2** when a requested relation is missing (it used to print a ⚠️ and exit 0, so an automated caller recorded "filed" for an ask whose relation to the work never existed).
- ⛔ **That check reads the read-back's RELATION EDGES, never its body.** Linear stores the description
  verbatim and `ask.mjs` always writes a `Blocks: <every requested id>` line into it, so a substring search over the read-back JSON finds every id whether or not the relation exists — which is how this guard sat inert. The `blocksVerified` field in the JSON output says whether the question could be answered at all; `blocksVerified: false` is also exit 2, because "I could not prove the relation landed" is not "it landed".
- File the ticket BEFORE citing its number anywhere; read the identifier back.


## What an answer DOES (CTL-2157)

An ask is not a notice board: a human comment on it **wakes the agents parked on the tickets the ask `blocks`**. The daemon's comment-wake (`execution-core/daemon.mjs` → `execution-core/ask-wake.mjs`) resolves those targets from the local replica — the `blocks` relation **and** the body's `Blocks:` line, because the two fail differently — and gives each one the same unpark it would have got had the human commented on it directly.

Two consequences for the raising agent:

- **The `blocks` relation is load-bearing, not decoration.** An ask that blocks nothing answers into the
  void; its work waits forever. ADV-1374/1376 sat for DAYS on exactly that.
- **Only a HUMAN's comment fans out.** The app actor's own comments (the ask body, follow-ups) are
  suppressed — otherwise raising the ask would immediately wake everything it blocks.
