---
name: migrate-dual-harness
description:
  "Migrate a single-harness repo to the dual-harness layout so both Claude Code and Codex load
  the same instructions and skills — AGENTS.md as the portable canonical doc, a thin CLAUDE.md
  `@AGENTS.md` bridge, and a `.agents/skills` dir with a `.claude/skills` symlink onto it. Use
  when asked to migrate to dual-harness, make this repo work in both Claude and Codex, or for
  agent metadata cleanup."
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
| `4` | ambiguous skills state (message says exactly what conflicts) | STOP — surface the script's stderr diagnostic verbatim; never modify either skills tree yourself; present the conflict and ask the human operator to resolve it, then re-run the classifier (Phase 2) to verify |
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
- rc `4` (ambiguous skills state) is a STOP, not an auto-fix and not a retry loop: surface the
  script's stderr diagnostic verbatim to the user and never modify either skills tree yourself —
  resolving the conflict is a decision for the human operator. Present the conflict and ask; once
  they've resolved it, re-run the classifier (Phase 2) to verify.

## Phase 4: Intelligent split (rc 11 only)

This is the one step a script cannot do — reconciling prose requires model judgment.

1. **Read `CLAUDE.md` IN FULL.** Not a partial read — every line needs a classification
   decision below.
2. **Partition every line/section** into:
   - **Claude-specific** — `@`-import lines, `.claude/` paths, Claude Code plugin/marketplace/
     session mechanics, `claude` CLI invocations, MCP registration commands that are
     Claude-scoped.
   - **Portable** — everything else (architecture, conventions, workflow rules, anything that
     applies regardless of which agent is driving).
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

Print a summary table:

```
── Dual-Harness Migration ──────────────────────
  Docs:        AGENTS.md canonical, CLAUDE.md → @AGENTS.md bridge
  Skills:      .agents/skills/ (.claude/skills → symlink)
  Pointer:     ## Skills section present in AGENTS.md
  House rules: Working the Loop block current
  Status:      dual-ok (rc 0)
```

## Important

- **Never commit.** After verifying, report the changed files and suggest a commit message
  (e.g. `chore(meta): migrate <repo> to dual-harness layout`) — the user commits.
- **Never delete or overwrite instruction content.** The only case that removes a tree is
  `.claude/skills` and `.agents/skills` both existing as real, byte-identical directories — the
  script collapses that to a symlink, guarded by `diff -r`.
- **Idempotent.** Re-running any phase against an already-converged repo is a no-op.
- **rc `4` is a stop sign, not a retry loop.** Ambiguous skills state means two real trees with
  different content, or a symlink pointing somewhere unexpected. The agent must never modify
  either skills tree itself — surface the script's stderr diagnostic verbatim and present the
  conflict to the human operator; resolving it is their decision, not the agent's. Re-run the
  classifier (Phase 2) to verify only after they've resolved it.
