# Log extraction — find the actual failing test, not the first grep hit

`gh run view <run_id> --log-failed` dumps every failed step across every failed job as one blob.
In a turbo/bun monorepo that single blob still interleaves output from every package the step ran
— `bun run check` fans out to dozens of workspace tasks concurrently, so a `grep -i fail` over the
raw dump routinely returns a line from a package that has nothing to do with the actual failure.
Confirmed CI-repro CTC-928 (run 33180922045): the step "Test + coverage" failed with a top-level
`error: script "test:coverage" exited with code 1` for one package, while the real failing
assertion — `Error: Test timed out in 150000ms` inside one specific test file — sat several hundred
lines further down, under interleaved output from unrelated packages that finished cleanly.

## Step 1 — resolve job → step, structurally, before touching raw text

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq \
  '.jobs[] | select(.conclusion == "failure") | {id, name, steps: [.steps[] | select(.conclusion == "failure") | .name]}'
```

This tells you the job id and the exact step NAME that failed (e.g. `"Test + coverage"`) before you
read a single line of log — you now know what you're looking for, not just that something failed.

## Step 2 — pull the log scoped to that job, strip ANSI before matching anything

```bash
strip_ansi() { sed -e $'s/\x1b\\[[0-9;]*[a-zA-Z]//g'; }
gh run view "$RUN_ID" --log-failed --job "$JOB_ID" | strip_ansi > /tmp/ci-triage-job.log
```

bun/vitest color their pass/fail counts with ANSI escapes. An unstripped `grep -E '[0-9]+ (pass|
fail)'` matches nothing and reads as "no failures" — a silent false-clean in the very instrument
you're using to judge correctness. Strip first, always, before any pattern match — including the
ones in `flake-classes.md`.

## Step 3 — find the real failure inside the step, not the summary line

The step-level summary (`error: script "X" exited with code 1`, or turbo's own
`ERROR  run failed: command exited (1)`) tells you WHICH package/task failed, not WHY. Use it to
scope your search, then search _within_ that scope for the actual assertion:

```bash
# The turbo summary names the failing package/task — use it to anchor the search window.
grep -n '# exited with code\|ERROR  run failed' /tmp/ci-triage-job.log

# Then search for the real failure markers near/after that anchor, not the first hit in the file:
grep -n -E 'FAIL |✕ |× |Error: Test timed out|AssertionError|Expected:|TypeError|ReferenceError' \
  /tmp/ci-triage-job.log
```

Read enough context around each candidate hit (`grep -n -B5 -A30`) to find the one that names a
real test file and assertion, not a log line that merely contains the word "fail" as prose (a test
description, a variable name, a comment). If multiple packages' output is interleaved in the
window around the anchor, the failing one is the one whose own summary line matches the job's
overall exit code — cross-reference by package name, not by proximity alone.

## Step 4 — record what you found, precisely

Before moving to classification, you should be able to state: the exact test/file name, the exact
error type and message, and the line range in the raw log where you found it. `flake-classes.md`
and `act-and-report.md` both expect this — a classification that can't cite a specific failing
test name is not a classification, it's a guess dressed up as one.
