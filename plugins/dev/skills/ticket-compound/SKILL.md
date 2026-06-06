---
name: ticket-compound
description:
  Compound-engineering capture + curation for a finished ticket — the engineering feedback loop.
  Harvests the Friction sections that phase agents left in their artifacts plus the git diff, writes a
  structured entry to the shared learnings store (thoughts/shared/learnings/), prunes/amends stale
  notes there autonomously, captures new domain vocabulary to thoughts/shared/CONCEPTS.md, and PROPOSES (for
  human approval) any ADR change. Non-blocking — runs after a ticket ships or fails, never on the
  critical path. Use when the user says "compound this ticket", "capture learnings", "what did we
  learn", or run as /catalyst-dev:ticket-compound <TICKET> [mode:headless].
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Task, AskUserQuestion
---

# ticket-compound — engineering compound loop

Capture what a ticket taught us into the **shared** store (`thoughts/` + ADRs), so future agents on
any machine make better decisions. This is `research-curate` evolved from *inventory* to *action*.
Read `reference.md` (this dir) for the learnings-store schema before writing anything.

**Two authority levels (hard rule):**
- **Autonomous** — write/append/update/delete in `thoughts/shared/learnings/` and
  `thoughts/shared/CONCEPTS.md`, and prune stale notes in `thoughts/shared/{research,plans}/`.
- **Propose only (APPROVE-gated)** — any change to `docs/adrs.md`. Never edit an ADR directly; queue
  it for the morning ritual to approve.

## Invocation

```
/catalyst-dev:ticket-compound <TICKET> [mode:headless]
```

- `<TICKET>` — Linear key (e.g. `CTL-619`). If omitted, detect from the branch / `CATALYST_TICKET`.
- `mode:headless` — non-interactive: apply all unambiguous autonomous actions silently, mark
  ambiguous learnings `status: stale`, never block on a prompt, end with the sentinel line. This is
  what the morning ritual (and, later, the daemon) use. Default is interactive.

## Step 1 — Gather raw signal (the orchestrator reads; do NOT delegate writes)

For `<TICKET>`, collect:
1. **Friction** — every `## Friction` / `friction:` block the phase agents left in their artifacts:
   `thoughts/shared/{research,plans}/*<TICKET>*.md` and the worker signal files
   `~/catalyst/workers/<TICKET>/*.json`.
   - `thoughts/shared/friction/<TICKET>.md` — the dedicated per-phase friction log (primary friction source).
2. **The diff** — `git log --oneline origin/main..HEAD` and `git diff --stat origin/main..HEAD`
   (or the merged SHA from `phase-monitor-merge.json`).
3. **Ticket** — `linearis issues read <TICKET>` (title, description, final state, estimate).
4. **Event trail** (optional) — the ticket's lines in `~/catalyst/events/YYYY-MM.jsonl`.

Capture learnings from **failed/abandoned** tickets too — the dead-ends are high-signal ("what
didn't work" is a first-class section).

## Step 2 — Three TEXT-ONLY sub-agents (parallel; they return text, never write files)

Spawn via Task, all at once. Each returns text to you; **you** do the single write in Step 3 (avoids
partial-write races):

- **Context Analyzer** — from the diff + ticket + friction, pick the track (bug vs knowledge),
  `problem_type`, `category` (subdir), `component`, `severity`, and a filename slug. Returns the
  frontmatter skeleton (validate against `reference.md`).
- **Solution Extractor** — write the entry body per the track's template (bug: Problem/Symptoms/What
  Didn't Work/Solution/Why This Works/Prevention; knowledge: Context/Guidance/Why This Matters/When
  to Apply/Examples). Ground every claim in the diff/friction — no invention.
- **Related-Learnings Finder** — `rg -li "<keywords>" thoughts/shared/learnings/**/*.md`, read the
  frontmatter of hits, and score overlap (problem, root cause, component, files, prevention). Returns
  HIGH (4–5) / MODERATE (2–3) / LOW (0–1) plus the matched paths.

## Step 3 — Assemble + write ONE learnings entry (overlap routing)

- **HIGH overlap** → update the existing entry in place (merge new detail, set `last_updated:`),
  rather than creating a near-duplicate. This is the anti-bloat rule.
- **MODERATE/LOW** → create `thoughts/shared/learnings/<category>/<slug>.md`.

Then validate frontmatter (fail loud on the YAML traps in `reference.md`):

```bash
bash "${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/compound/validate-learnings.sh" "<written-path>"
```

## Step 4 — Curate the store (five outcomes, autonomous in thoughts/)

For the related entries the Finder surfaced, classify and act — **autonomously** (this is the
`thoughts/` layer):
| Outcome | When | Action |
|---|---|---|
| Keep | accurate, refs valid | none |
| Update | core correct, refs/paths drifted | targeted in-place edit |
| Consolidate | 2+ heavily overlap, both correct | merge into the canonical, delete the subsumed |
| Replace | core guidance now misleading | write successor, delete old |
| Delete | implementation gone AND domain gone AND no inbound links | remove (git history preserves) |

Same five-outcome pass applies to stale `thoughts/shared/{research,plans}/` notes this ticket
contradicted (the "off-track context that got us redirected"). In `mode:headless`, only act on
unambiguous cases; mark the rest `status: stale` + `stale_reason`.

## Step 5 — Vocabulary → CONCEPTS.md (autonomous)

Scan the diff + friction for Catalyst domain terms not yet in `thoughts/shared/CONCEPTS.md` (e.g. "reclaim",
"revive-budget", "orphan", "signal ownership"). Append concise definitions. Create the file if absent.

## Step 6 — ADR changes → PROPOSE, never apply

If a learning rises to a standing rule (something *every* agent must always do/avoid), do NOT edit
`docs/adrs.md`. Append a proposal to the approval queue:

```
thoughts/shared/compound/pending/<TICKET>.md
```

Each proposal: the target ADR (new / amend `ADR-NNN` / supersede `ADR-NNN`), the exact proposed text,
and a one-line rationale + evidence (ticket + learning path). The morning ritual surfaces these; a
human approves via `briefing-followup`'s `action-compound` handler, which is the only thing that
writes `docs/adrs.md`.

## Step 7 — Discoverability check (pointer only)

Confirm `CLAUDE.md` teaches agents that the learnings store exists, its shape, and when to grep it. If
not, propose (interactive) / apply (headless) a **minimal pointer** — never the learnings themselves:

```
thoughts/shared/learnings/ — past problem→solution entries (grep by component/tags/problem_type).
Search before implementing or debugging in a known area. Curated by /catalyst-dev:ticket-compound.
```

## Step 8 — Report

- **Interactive:** summarize entry written/updated, curation actions, CONCEPTS additions, and any
  queued ADR proposals (with the approval command).
- **Headless:** structured block ending with the grep-able sentinel:

```
✓ ticket-compound complete (headless)
ticket: CTL-619
entry: thoughts/shared/learnings/orchestrator-issues/daemon-false-dead-first-commit.md (created)
curated: 1 updated, 0 deleted ; concepts: +2 ; adr-proposals: 1 (pending approval)
ticket-compound complete
```

## Out of scope (this slice)
- The daemon firing this automatically after `monitor-deploy` (manual / morning-ritual triggered for now).
- The estimation loop (separate slice — `compound-estimate` owns estimation numbers).
- `ticket-retro` (the cross-ticket view — separate slice).
