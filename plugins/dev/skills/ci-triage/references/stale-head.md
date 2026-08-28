# Stale-head detection — do this before reading a single log line

A GitHub Actions run is bound to a commit SHA at the moment it was **triggered**. If you push again
after that trigger, the earlier run's failure is a statement about a commit that no longer exists
on the branch — reading its log and fixing "the failure" is diagnosing a ghost. This is why the
skill exists at all: CTL-2269 records exactly this misdiagnosis happening once, alongside two
first-touch-timeout occurrences (see `flake-classes.md`), in one day of ad-hoc coordinator triage
with no shared reference to check against. Do this check FIRST, before step 2 (log extraction) or
step 3 (classification) — a stale run has no log worth pulling.

## The check

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# The run's own commit (what it actually tested).
RUN_SHA=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}" --jq '.head_sha')

# The PR's CURRENT head (what's actually on the branch right now).
CURRENT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha')

if [[ "$RUN_SHA" != "$CURRENT_SHA" ]]; then
  echo "STALE: run ${RUN_ID} tested ${RUN_SHA}, current head is ${CURRENT_SHA}"
fi
```

If `RUN_ID` isn't already known (you were only handed a PR number), list the check-runs for the
_current_ head directly instead of guessing which historical run to compare:

```bash
gh api "repos/${REPO}/commits/${CURRENT_SHA}/check-runs" --jq '.check_runs[] | {name, status, conclusion, html_url}'
```

If that query already shows the check green, or still in progress, there is nothing to triage —
the failure you were told about was the stale one. Report that plainly and stop; do not re-run the
stale run (`gh run rerun`) — it would just retest a commit nobody cares about anymore. Point at the
current head's own run/check instead, and if it hasn't started or finished yet, that's a `PENDING`
report (see `wait-for-github`'s bounded-poll), not a triage verdict.

## A second, distinct trap: same head SHA, different tree

Even when `RUN_SHA == CURRENT_SHA`, GitHub's `pull_request` trigger by default checks out
`refs/pull/<N>/merge` — a synthetic merge of your branch onto whatever `main` was **at run time**,
not your branch's bare commit. If `main` moved between when the run started and now (a routine
merge from someone else), an old run on the right head SHA can still have tested a tree that no
longer matches `origin/main`. This is a different mechanism from a stale head SHA — the run is
current for the _branch_, but its merge base is not current for the _repo_ — and it explains a
narrower symptom: a failure in a file your diff never touches, at a value owned by something
external (a generated marker, a version string, a lockfile-derived constant). Diagnose it in this
order, fastest-to-rule-out first:

```bash
git fetch origin main
git log HEAD..origin/main --oneline          # did main move since you branched?
git diff HEAD...origin/main -- <suspect file>  # did anything you didn't author actually change?
```

If step 2 shows a real diff in a file the failure touches and your own PR diff doesn't touch that
file, the fix is usually "rebase and let CI re-run" (see `merge-pr`'s
`references/ci-fixup-and-behind.md` BEHIND handling), not a code fix on your side.

## What NOT to do

- Don't average or combine a stale run's result with the current head's — they answer different
  questions and mixing them produces a classification that's wrong for either.
- Don't treat "the check hasn't re-run yet on the new head" as a failure to fix. It's `PENDING`.
