---
name: migrate-dual-harness
description:
  "Migrate a single-harness repo to the dual-harness layout so both Claude Code and Codex load
  the same instructions and skills — AGENTS.md as the portable canonical doc, a thin CLAUDE.md
  `@AGENTS.md` bridge, and a `.agents/skills` dir with a `.claude/skills` symlink onto it. Use
  when asked to migrate to dual-harness, make this repo work in both Claude and Codex, or for
  agent metadata cleanup. Ends with a quality review: canonical-form convergence and
  checkup-clean are applied mechanically; conciseness / progressive-disclosure findings are
  reported, with editorial changes confirmed with the user first."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Migrate Dual-Harness

Converge a single-harness repo (Claude-only monolithic `CLAUDE.md`, or Codex-only `AGENTS.md`
with no bridge) onto the target dual-harness layout, applying every mechanical fix automatically
and only asking the model to do the one thing a script can't: split a monolithic `CLAUDE.md`
into its portable core and its Claude-specific remainder.

**User-invoked only.** This skill sets `disable-model-invocation: true`, so nothing can
auto-trigger it as a handoff — not `catalyst-foundry:setup-catalyst` (which hits this exact
case at its rc `11` row) and not `check-project-setup.sh`'s §10 checkup warning. Both merely
*reference* `/catalyst-foundry:migrate-dual-harness` and tell the user to run it themselves;
invoke this skill directly (`/catalyst-foundry:migrate-dual-harness`) to perform the split.

## Target layout

- `AGENTS.md` — portable, tool-agnostic instructions (canonical).
- `CLAUDE.md` — thin bridge: literal line 1 is `@AGENTS.md`, then only Claude-specific notes.
- `.agents/skills/` — canonical skills dir.
- `.claude/skills` — committed **relative** symlink → `../.agents/skills`.
- `AGENTS.md` carries a `## Skills` pointer section when the repo has skills.
- No `.codex/` dir needed — Codex reads `AGENTS.md` and `.agents/skills/` natively.

## Phase 1: Resolve

Locate the backing script (lives in `catalyst-dev`, the shared framework core):

```bash
source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
SCRIPT="${CATALYST_DEV_SCRIPTS}/migrate-dual-harness.sh"
```

## Phase 2: Diagnose

Dry-run the classifier — it writes nothing:

```bash
bash "$SCRIPT" --repo . 2>&1
```

Branch on the exit code:

| rc | Meaning | Next step |
|----|---------|-----------|
| `0` | already `dual-ok`, or `no-harness` (out of scope for this skill) | Phase 5 (house rules) — for `no-harness`, re-run the mechanical fix per Phase 5's note — then Phase 6 |
| `10` | mechanical changes needed (bridge / skills wiring / pointer) — no monolithic problem | Phase 3 |
| `11` | `CLAUDE.md` is monolithic — needs the intelligent split | Phase 3 (mechanical parts only), then Phase 4 |
| `2` | bad usage (`--repo` not a dir, unknown flag) | fix the invocation and re-run |
| `4` | ambiguous skills state (message says exactly what conflicts) | ONE sanctioned exception, else STOP. Exception (the per-skill symlink farm): applies only when the diagnostic is the symlink-inside-the-trees refusal AND all three pre-checks pass BEFORE touching anything — (a) every entry of `.claude/skills` is a symlink resolving into `../../.agents/skills/<name>` (one real file or foreign link disqualifies), (b) neither `.claude` nor `.agents` is itself a symlink, (c) `git check-ignore --stdin` over `.agents/skills` + every `.agents/skills/<name>` + `.claude/skills` reports nothing ignored (a masked hard-stop must surface BEFORE deletion, not after). All pass → converge (delete the per-entry links — links, not content — `rmdir .claude/skills`, `ln -s '../.agents/skills' .claude/skills`), re-run the dry-run, and dispatch the NEW rc through this same table (a coexisting monolithic CLAUDE.md legitimately yields rc `11` next — continue the flow; rc `0` only when nothing else is pending). ANY pre-check failing, or any other rc-4 diagnostic → STOP: surface the script's stderr verbatim; never modify either skills tree yourself; present the conflict and ask the human operator, then re-run the classifier to verify |
| `5` | I/O error | inspect the printed message |

## Phase 3: Mechanical fix

Applies to rc `10` and rc `11` alike (rc `11` still gets the skills/pointer wiring — only the
`CLAUDE.md` split itself is deferred to Phase 4):

```bash
bash "$SCRIPT" --repo . --fix 2>&1
```

- After fixing from rc `10`, re-run the Phase 2 dry-run and require rc `0`.
- After fixing from rc `11`, re-run the Phase 2 dry-run and expect rc `11` again (the monolithic
  split is still outstanding) — proceed to Phase 4.
- rc `4` at any point: dispatch through the Phase 2 table's rc-4 row — it is the single
  authoritative statement of the one sanctioned exception (the pre-validated per-skill symlink
  farm convergence) and the hard stop for everything else.

## Phase 3.5: Cross-agent invocation safety

Runs whenever the repo has a skills tree (`.agents/skills/`), independent of rc — a mechanical
safety gate, not part of the monolithic-split judgment call in Phase 4.

**The sidecar convention (CTL-1536).** A skill dir MAY carry two plain declarative sidecar files
alongside its `SKILL.md`:

- `agents/openai.yaml` — Codex policy (e.g. `policy.allow_implicit_invocation`).
- `agents/portability.yaml` — portability metadata (e.g. `mutating: true`).

Both are read natively by whatever consumes them; **no build step or generator produces or
consumes either file.** This is explicitly *not* the catalyst-cloud CTL-1446 generated-copy
mechanism (a `tools/agent-skills/{build,check,clean}.mjs` pipeline that produced hashed, drift-
checked `.claude/skills` copies) — CTL-1536 retired that pipeline in favor of these plain sidecars
plus the single canonical symlink this skill already converges repos onto.

**The MUTATING-PAIR RULE.** Any skill that performs an external write — a financial/ledger
mutation, an email send, a third-party API write, browser automation that changes remote state, a
`git push`, or similar — MUST have BOTH of the following, never just one:

1. `disable-model-invocation: true` in its own `SKILL.md` frontmatter, AND
2. `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

This is fail-or-omit, never silent degrade: a mutating skill with only the Claude-side gate is
still silently auto-invocable by Codex, and vice versa.

**Applying it.** Classifying a skill as "mutating" takes model judgment (the same kind of call
Phase 4 makes when splitting prose) — a script can't grep its way to "this writes external
state." For every skill dir under `.agents/skills/`, read its `SKILL.md` body in full and decide
whether it performs an external write per the rule above. Wherever a gap exists (missing either
half of the pair, or both), add the missing piece(s) directly:

- Add `disable-model-invocation: true` to `SKILL.md` frontmatter if absent (or flip an explicit
  `false` to `true`).
- Create or update `agents/openai.yaml` with `policy.allow_implicit_invocation: false` if absent.

This check is **mechanical**, not editorial — unlike Phase 7's conciseness/progressive-disclosure
gates, it is a safety gate closing a real invocation-gating hole, not a style preference, so apply
the fix directly rather than only reporting it (see Phase 7 gate 5).

## Phase 4: Intelligent split (rc 11 only)

This is the one step a script cannot do — reconciling prose requires model judgment.

1. **Read `CLAUDE.md` IN FULL.** Not a partial read — every line needs a classification
   decision below.
2. **Partition every line/section** into:
   - **Claude-specific** — `.claude/` paths, Claude Code plugin/marketplace/session mechanics,
     `claude` CLI invocations, MCP registration commands that are Claude-scoped.
   - **Portable** — everything else (architecture, conventions, workflow rules, anything that
     applies regardless of which agent is driving).
   - **`@`-import lines are classified by their TARGET, not by their syntax** (the `@` mechanism
     is Claude-only, but what it imports usually isn't): read the imported file; if its content
     is portable guidance (e.g. `@docs/development.md`), reference it from `AGENTS.md` as a
     plain read-this path (like the Reference Docs pattern) so Codex sees it too, and the
     `@`-import may stay in the bridge for Claude's auto-load. Only an import whose target is
     genuinely Claude-specific stays bridge-only. Never let portable guidance survive solely
     behind an `@`-import Codex cannot interpret.
3. **Merge the portable content into `AGENTS.md`**:
   - If `AGENTS.md` doesn't exist, create it from the portable content.
   - If `AGENTS.md` already exists, merge without duplicating — **existing `AGENTS.md` sections
     stay authoritative on conflict**; note any discrepancy to the user rather than silently
     overwriting it.
4. **Rewrite `CLAUDE.md`** as: line 1 `@AGENTS.md`, a blank line, then only the Claude-specific
   remainder under clear headings.
5. **Conservation check**: every H2/H3 heading and every non-blank line of the *original*
   `CLAUDE.md` must appear — verbatim or explicitly merged — in exactly one of the two files.
   List anything dropped and why (this should be nothing; if something doesn't fit either
   bucket cleanly, default to portable rather than dropping it).
6. Re-run the mechanical fix and require rc `0`:

   ```bash
   bash "$SCRIPT" --repo . --fix 2>&1
   ```

## Phase 5: House rules

Run the seeder so the repo also carries the "Working the Loop" reflexes (independent of the
dual-harness layout, but always worth syncing while touching the agent docs):

```bash
bash "${CATALYST_DEV_SCRIPTS}/ensure-agent-house-rules.sh" --repo . --fix 2>&1
```

- **`no-harness` repos:** the seeder creates the `AGENTS.md`/`CLAUDE.md` pair from scratch (the
  doc-pair itself is out of scope for `migrate-dual-harness.sh` — see Phase 2's `no-harness` note),
  even when Phase 3 already wired the skills tree. The freshly created `AGENTS.md` can't yet carry
  the `## Skills` pointer, so re-run the mechanical fix to pick it up (and the `@AGENTS.md` bridge,
  if still missing) **before** the final verification:

  ```bash
  bash "$SCRIPT" --repo . --fix 2>&1
  ```

## Phase 6: Verify

Re-run the classifier and confirm rc `0`:

```bash
bash "$SCRIPT" --repo . 2>&1
```

Print a summary table **rendered from the OBSERVED state, never from this template's example
values** — check each artifact and report what actually exists (a repo with no skills tree
legitimately reaches rc 0 with no `.agents/skills`, no symlink, and no pointer; those rows must
say `none`, not claim artifacts that don't exist):

```
── Dual-Harness Migration ──────────────────────
  Docs:        <e.g. AGENTS.md canonical, CLAUDE.md → @AGENTS.md bridge>
  Skills:      <.agents/skills/ (.claude/skills → symlink) | none>
  Pointer:     <## Skills section present in AGENTS.md | n/a (no skills)>
  House rules: <Working the Loop block current | absent>
  Status:      <rc 0 classification>
```

## Phase 7: Quality review (always — even when Phases 3-5 were no-ops)

The migration is not done when the classifier passes; the docs must also be GOOD. This review
phase always RUNS (it is part of the skill's contract — the frontmatter description discloses
it), but its WRITE authority is tiered. Start by reading the FINAL `AGENTS.md` and `CLAUDE.md`
IN FULL (Phases 5-6 may have changed them since any earlier read; a "no findings" verdict from
stale or unread files is invalid): gates 1, 4, and 5 (canonical form, checkup-clean,
mutating-pair invocation safety) are mechanical and applied directly; gates 2 and 3
(conciseness, progressive disclosure) are editorial — REPORT findings always, but apply only
trivially-safe fixes directly (exact duplicates from the merge, dead boilerplate the split
itself created) and **ask the user before any other editorial change or relocation**. Never
silently rewrite prose the user authored:

1. **Canonical form, not merely functional.** Variants that happen to work still get converged.
   The one **sanctioned rc-4 exception** (recognized and executed in Phase 2, where rc 4 first surfaces — restated here as the canonical-form rule): when the classifier's rc-4 diagnostic is the
   symlink-inside-the-trees refusal AND inspection proves `.claude/skills/` is a pure per-skill
   symlink farm (EVERY entry is a symlink resolving into `../../.agents/skills/<name>` — one
   real file or foreign link disqualifies it), converge it: delete the per-entry links (links,
   not content), `rmdir .claude/skills`, `ln -s '../.agents/skills' .claude/skills`. Every OTHER
   rc-4 remains a hard stop per Phase 2. Also converge: a prose "see AGENTS.md" pointer becomes
   the literal `@AGENTS.md` line 1; the bridge's Claude-specific notes live under one clear
   heading. Re-run the classifier after converging — rc 0 required.
2. **Concise.** The bridge carries ONLY what is genuinely Claude-specific — no restated
   AGENTS.md content, no filler ("this file provides guidance to…" boilerplate dies here).
   AGENTS.md states each rule once; duplicated guidance introduced by the merge is collapsed to
   the single authoritative statement.
3. **Progressive disclosure.** AGENTS.md is the always-loaded top layer: it should carry the
   rules an agent needs on every task, and POINT at everything else — deep reference material
   belongs in `docs/` (or the repo's equivalent) behind a short "read on demand" pointer, and
   skill knowledge belongs in the skill files, referenced by path, never inlined. If the merge
   produced a wall of detail, move the detail out to a referenced doc and leave the pointer —
   content is RELOCATED, never dropped — and the Phase 4 conservation check widens accordingly:
   a line is "accounted for" when it lives in `AGENTS.md`, `CLAUDE.md`, **or a doc that one of
   them references by path**; list every relocation (source heading → target file) in the
   summary.
4. **Checkup-clean.** The satisfiable gate: the classifier dry-run exits `0`, AND — when the
   repo is Catalyst-configured — running `check-project-setup.sh` produces NO §3 snippet
   warning and NO §10 dual-harness warning (§10's green line, when it prints, confirms it).
   Warnings from unrelated sections (webhooks, thoughts, config keys) do NOT count against
   this gate — report them as observations only.
5. **Mutating-pair invocation safety (mechanical, not editorial).** Re-check the Phase 3.5
   sidecar/mutating-pair rule against the FINAL skills tree: every skill whose `SKILL.md` body
   performs an external write must have BOTH `disable-model-invocation: true` in its frontmatter
   AND `agents/openai.yaml` with `policy.allow_implicit_invocation: false`. Unlike gates 2 and 3,
   a gap here is applied directly, not merely reported — it's a safety gate closing a real
   invocation-gating hole, not a style preference the user should be consulted on.

Report what the review changed (or "no findings") in the final summary.

## Important

- **Never commit.** After verifying, report the changed files and suggest a commit message
  (e.g. `chore(meta): migrate <repo> to dual-harness layout`) — the user commits.
- **Never delete or overwrite instruction content.** The only case that removes a tree is
  `.claude/skills` and `.agents/skills` both existing as real, byte-identical directories — the
  script collapses that to a symlink, guarded by `diff -r`.
  The TWO sanctioned tree-removal cases: (1) a duplicate `.claude/skills` proven byte-identical
  to `.agents/skills` (script-guarded by `diff -r` + mode compare), and (2) the pre-validated
  per-skill symlink FARM (Phase 2 rc-4 exception) — where only symlinks and the then-empty
  directory are removed, never file content.
- **Idempotent.** Re-running any phase against an already-converged repo is a no-op.
- **rc `4` is a stop sign, not a retry loop** — except the single Phase-2-sanctioned
  per-skill-symlink-farm convergence (see Phase 2 and Phase 7 rule 1). Every other ambiguous
  state (two real trees with different content, a symlink pointing somewhere unexpected) means
  the agent must never modify either skills tree itself — surface the script's stderr
  diagnostic verbatim and present the conflict to the human operator; resolving it is their
  decision, not the agent's. Re-run the classifier (Phase 2) to verify only after they've
  resolved it.
