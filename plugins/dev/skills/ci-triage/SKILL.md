---
name: ci-triage
description:
  "Diagnose a failing GitHub Actions Check run on a PR: confirm the run isn't stale, pull the
  failing step's real log (not the first grep hit — turbo interleaves unrelated packages),
  classify flake-vs-real against the repo's documented flake classes, and act — one re-run for a
  suspected flake, a scoped fix-and-push for a real failure, or a deferral for a stale-head
  misdiagnosis. **ALWAYS use when** a Check run is red on a PR and you need to know whether to
  re-run it or fix it, when the user says 'triage this CI failure', 'is this a flake', 'why did CI
  fail', or as the CI-diagnosis step inside merge-pr's blocker loop or a relay-ticket pr/merge
  phase."
disable-model-invocation: false
allowed-tools: Bash(gh *), Bash(git *), Read, Grep, Edit, Write
version: 1.0.0
argument-hint: "[PR-number] [check-name]"
---

# CI Triage

Turn "CI is red" into either "confirmed flake, cleared on retry" or "real failure, fixed and
pushed" — with evidence, not a guess.

## Input

`$1` = PR number (default: current branch's PR via `gh pr view --json number --jq '.number'`).
`$2` = a specific check name, when several are red and you want to scope to one.

## The four steps — in this order, never skip step 1

1. **Confirm the run isn't stale.** [references/stale-head.md](references/stale-head.md). A
   failing run whose `head_sha` predates the PR's current HEAD proves nothing about the code
   sitting there now — say so and point at the current head's own run. Do not re-run a stale run.
2. **Pull the failing step's real log.** [references/log-extraction.md](references/log-extraction.md).
   Resolve job → step → the step that actually has `conclusion: "failure"`, not `gh run view
   --log-failed` blind-grepped — turbo interleaves concurrent packages' output in that one step.
   Strip ANSI before any pattern match.
3. **Classify flake vs. real.** [references/flake-classes.md](references/flake-classes.md) against
   the repo's documented flake shapes, then grep `thoughts/shared/learnings/` (tags `ci`/`flake`/
   `test`) for anything not yet in that list. State the verdict WITH evidence: which class, which
   log lines, whether the failing file is in this PR's own diff.
4. **Act.** [references/act-and-report.md](references/act-and-report.md) — suspected flake → one
   re-run; real failure → scoped fix, push, re-verify; can't fix → report exactly why, precisely.

## Non-negotiables

- Never classify off the summary line alone — a `Failed:`/`exited with code 1` line with no
  matching `FAIL`/`✕` test name nearby is itself a known false-red shape (see flake-classes.md),
  not evidence of anything. Always find the actual failing assertion first.
- One re-run per suspected flake, ever. A second failure of the **same** test/step on the same
  commit is real, not another retry candidate.
- A real fix stays scoped to the failing check — this is triage, not a refactor pass.
- Relay-compatible: no interactive prompts, foreground `gh` calls only (`wait-for-github`'s
  bounded-poll for any wait), and end with the report shape in act-and-report.md.

## Related skills

- `wait-for-github` — the bounded-poll primitive this skill's rerun-then-wait step uses.
- `merge-pr` (`references/ci-fixup-and-behind.md`, `references/blocker-loop.md`) — the usual
  caller, inside its merge-blocker loop; this skill is the detail behind its `ci-failing`/
  `UNSTABLE` row.
- `review-comments` — the equivalent skill for review-thread findings, not Check runs.
