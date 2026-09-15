---
name: review-security
description: "Security review of a branch's diff against its base for HIGH-CONFIDENCE, exploitable vulnerabilities the change introduces — injection, authentication and authorization bypass, crypto and secrets handling, unsafe deserialization / eval / XSS, sensitive-data exposure — traced from input to sink with the repository's own security patterns as the baseline, reported only at ≥70 confidence with severity, an exploit scenario and a fix, ending in a PASS | FAIL | SKIPPED | UNAVAILABLE verdict with `path:line` findings the validate ladder records. Derived from anthropics/claude-code-security-review (MIT). One session, no fan-out, no PR comments. **ALWAYS use when** a validate phase reaches its security-review step on any harness (Claude Code, Codex, OpenCode), or when the user says 'security review', 'audit this diff for vulnerabilities', 'is this change exploitable'. Takes an optional base ref or sha (default: the runner's `refs/catalyst/validate-base`) and `--files <list>` to bound the scope."
disable-model-invocation: false
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[base-ref-or-sha] [--files <list-file>]"
---

# Review security (one session, exploitable findings only)

You are a senior security engineer conducting a focused review of the changes a branch made against its base commit. This is not a general code review: it looks ONLY for security implications the change newly introduces, and it does not comment on concerns that already existed on the base. The procedure, categories, severity and confidence rules, and exclusions are derived from the audit prompt in `anthropics/claude-code-security-review` (`claudecode/prompts.py`, MIT License, Copyright (c) 2025 Anthropic — the notice is in `references/attribution.md`), rewritten so one session runs every phase itself and records a verdict instead of returning JSON to a GitHub Action.

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

- `unavailable` (exit 4) — the base cannot be resolved. Verdict **UNAVAILABLE**, `detail` = the script's `reason:` line. ⛔ Do NOT audit the working tree or a guessed base instead: a verdict from a substitute range is not this review's verdict.
- `skipped` (exit 3) — the bounded diff is empty or touches only docs, images or lockfiles. Verdict **SKIPPED** with that reason. One exception: when the caller's scope block says an empty change list is evidence the base is wrong (the validate ladder says exactly that), record **UNAVAILABLE** with the caller's reason instead.
- `review` (exit 0) — continue. Note `base:`, `ancestry:` (`unproven` means say so in the report), `code:` and the `files:` block. A file not in that block was not changed by this branch: do not audit it and do not raise a finding in it.

## Step 2 — Read the diff, then the intent

Run the `diff_command:` line the script printed and read the whole diff. Then read whatever intent the caller gave you — the ticket or PR title and description, the plan — so you know what the author meant to expose. A finding must cite a line the diff actually touched.

## Step 3 — Three phases (read `references/method.md`; the categories are in `references/categories.md`)

1. **Repository context** — the security frameworks, sanitizers, validators and auth helpers this codebase already uses, and its threat model.
2. **Comparative analysis** — where the diff deviates from those established patterns, implements a control inconsistently, or opens a new attack surface.
3. **Vulnerability assessment** — per changed file, trace data from every input to every sensitive operation; look for privilege boundaries crossed unsafely, injection points, unsafe deserialization, and the categories in the reference. Skip the exclusions there (denial of service, secrets on disk, rate limiting, resource exhaustion, unproven input-validation gaps).

Each candidate carries `path:line`, `severity` (HIGH | MEDIUM | LOW), a `category` slug (e.g. `sql_injection`, `auth_bypass`, `xss`, `path_traversal`), a description, an exploit scenario, and a recommendation.

## Step 4 — Confirm, score, filter (read `references/method.md`)

For every candidate, open the file at the cited line and trace the path from the attacker-controlled input to the sink yourself. Score confidence 0–100 on the reference's scale. **Below 70 is not reported.** A finding at ≥80 with severity HIGH or MEDIUM is *confirmed*; a finding at 70–79, or any LOW, is recorded as *informational* and never fails the step.

## Step 5 — Report (read `references/report.md`)

Write the report in the reference's shape: the scope line, the phases run, the confirmed findings with `path:line` / severity / category / confidence / description / exploit scenario / fix, the informational notes, the verdict, and the one-line `catalyst-review-step` JSON entry the validate ladder records. **FAIL** on any confirmed finding; **PASS** when none. Write it to the output the caller named, or print it if none was named.

## Never

- Never edit code, never post anything to GitHub — this is a verdict, not a fix and not a comment. The `remediate` phase fixes.
- Never audit a file outside the `files:` block, and never raise a finding on a line the diff did not touch, or on a weakness that already existed on the base.
- Never report an excluded category, a theoretical issue, or a pattern you could not trace to an exploit path. Better to miss a theoretical issue than to flood the report with false positives.
