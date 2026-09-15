---
name: review-code
description: "Review a branch's diff against its base for REAL defects only — bugs the diff makes certain, quoted CLAUDE.md/AGENTS.md violations, contradictions of recent git history, unaddressed prior-PR review comments, and in-code guidance the change ignores — each scored 0–100 and reported only at ≥80 confidence, ending in a PASS | FAIL | SKIPPED | UNAVAILABLE verdict with `path:line` findings the validate ladder records. One session, no fan-out, no PR comments. **ALWAYS use when** a validate phase reaches its code-review step on any harness (Claude Code, Codex, OpenCode), or when the user says 'review this diff', 'review the branch', 'code review against <base>'. Takes an optional base ref or sha (default: the runner's `refs/catalyst/validate-base`) and `--files <list>` to bound the scope."
disable-model-invocation: false
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[base-ref-or-sha] [--files <list-file>]"
---

# Review code (one session, high signal only)

You are reviewing the changes a branch made against its base commit, and nothing else. The criteria are the official Claude Code `code-review` plugin's (the five lenses, the confidence scale, the ≥80 filter, the false-positive list), rewritten for one session: you run every lens yourself, in order, and you confirm every candidate yourself before it is reported. False positives erode trust and waste reviewer time; a finding you are not certain of is not a finding.

**Paths.** Commands below name files inside this skill's own directory as `${CLAUDE_SKILL_DIR}/…`. Claude Code fills that in. On any other harness, set CLAUDE_SKILL_DIR to the absolute directory that contains this SKILL.md before running them. If you cannot, stop and report `skill_dir_unresolved`.

## Step 1 — Scope (computed, never guessed; never the whole tree)

```bash
# Base: the argument if one was given (Claude Code substitutes the token below; another harness
# leaves it literal, which the script treats as no argument), else refs/catalyst/validate-base,
# the ref the runner plants at the branch's base commit.
SKILL_ARGS=$(cat <<'CATALYST_SKILL_ARGS'
$ARGUMENTS
CATALYST_SKILL_ARGS
)
# If the caller listed the changed files (the validate prompt's Review scope block does), write
# them one per line to a scratch file first and append: --files <that file>
bash "${CLAUDE_SKILL_DIR}/scripts/review-scope.sh" "$SKILL_ARGS"
```

Read the `status:` line and stop early on two of them:

- `unavailable` (exit 4) — the base cannot be resolved. Verdict **UNAVAILABLE**, `detail` = the script's `reason:` line. ⛔ Do NOT substitute a scan of the working tree or a guessed base: a review with no diff names a different set of findings on every pass over unchanged code.
- `skipped` (exit 3) — the bounded diff is empty or touches only docs, images or lockfiles. Verdict **SKIPPED** with that reason. One exception: when the caller's scope block says an empty change list is evidence the base is wrong (the validate ladder says exactly that), record **UNAVAILABLE** with the caller's reason instead.
- `review` (exit 0) — continue. Note `base:`, `ancestry:` (`unproven` means say so in the report), `code:` and the `files:` block. A file not in that block was not changed by this branch: do not review it and do not raise a finding in it.

## Step 2 — Read the diff, then the intent

Run the `diff_command:` line the script printed and read the whole diff (bounded to the code files in scope). Then read whatever intent the caller gave you — the ticket or PR title and description, the plan — so a deliberate change is not mistaken for a mistake. Review THAT diff, not the current contents of each file: a finding must cite a line the diff actually touched.

## Step 3 — Five lenses, run in order (read `references/lenses.md`)

1. **Guidelines** — CLAUDE.md / AGENTS.md rules that scope to each changed file, quoted.
2. **Diff bugs** — what the diff alone proves: will not compile or parse, wrong results regardless of input.
3. **History** — the change undoes or contradicts what a recent commit did on purpose.
4. **Prior review comments** — a reviewer already asked for the opposite on these lines (only when `gh` is authenticated; otherwise the lens is recorded as not run and the verdict is unaffected).
5. **In-code guidance** — a comment near the changed code forbids or constrains exactly this.

Each lens yields *candidates*: `path:line`, category (`correctness` | `security` | `guideline`), one-sentence claim, the evidence (a quote, a commit, a comment).

## Step 4 — Confirm, score, filter (read `references/scoring.md`)

For every candidate, open the file at the cited line and check the claim against the real context, exactly as a second reviewer would. Then score confidence 0–100 on the scale in the reference and **drop everything below 80**, and everything on the false-positive list, whatever its score. What survives is the finding list.

## Step 5 — Report (read `references/report.md`)

Write the report in the reference's shape: the scope line, the lenses run, the findings with `path:line` / severity / category / confidence / reason, the dropped candidates in one line each, the verdict, and the one-line `catalyst-review-step` JSON entry the validate ladder records. **FAIL** on any surviving finding; **PASS** when none survives. Write it to the output the caller named, or print it if none was named.

## Never

- Never edit code, run a formatter or linter to "check", or post anything to GitHub — this is a verdict, not a fix and not a comment. The `remediate` phase fixes.
- Never review a file outside the `files:` block, and never raise a finding on a line the diff did not touch.
- Never report a candidate you could not confirm by reading the code, or one that only holds for specific inputs or state.
