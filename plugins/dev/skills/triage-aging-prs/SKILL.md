---
name: triage-aging-prs
description: "Drive an aging pull-request backlog to zero. Inventories every open PR, finds the STRUCTURAL blockers first (a required check that can never run, a reviewer that never fires, chronically red CI), triages every unresolved review thread in parallel and VERIFIES each finding against the code before fixing it, then merges serially. **ALWAYS use when** the user says 'burn down the PRs', 'stale PRs', 'aging PRs', 'PR backlog', 'get these PRs merged', 'clear the PR queue', or asks why PRs are not merging. Repo-agnostic — works in any repo with the gh CLI."
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task
version: 1.0.0
argument-hint: "[--repo owner/name] [--limit N]"
---

# Triage Aging PRs

Drive a stale pull-request backlog to zero without breaking `main`.

The mistake this skill exists to prevent: **grinding through review comments PR by PR while
the real blocker is structural.** Fix the gate first, or you will do a night's work and merge
nothing.

## Step 0 — Inventory before you touch anything

```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
gh pr list --repo "$REPO" --limit 60 \
  --json number,title,isDraft,mergeStateStatus,isCrossRepository,createdAt,headRefName \
  --jq '.[]|[.number,(if .isCrossRepository then "FORK" else "base" end),.mergeStateStatus,
             (if .isDraft then "DRAFT" else "-" end),(.createdAt[0:10]),(.title|.[0:50])]|@tsv' |
  sort -k2,2 -k1,1n | column -t
```

Classify every PR before doing any work. Do NOT treat the raw open count as the goal:

| Class | What it means | Action |
|---|---|---|
| **Genuinely stale** | Opened well before the current work window | The actual target |
| **Fresh** | Opened in the last day or two | Steady-state flow, not backlog |
| **Draft** | `isDraft` | Not mergeable by design — exclude |
| **Do-not-land** | The user has said to leave it | Exclude, and re-check any bulk action against this set |
| **Release PR** | e.g. release-please's `chore: release main` | Outward-facing — the user's call, never auto-merge |

**Report the split.** "18 open" is meaningless; "3 genuinely stale, 12 opened today, 4 drafts" is
a status. A backlog whose count is flat while you merge steadily is not stuck — arrivals are
matching your throughput, which is a different problem with a different fix.

## Step 1 — Find the STRUCTURAL blocker first

Before any review work, ask: *can these PRs merge at all?*

### 1a. What does the branch actually require?

```bash
gh api "repos/$REPO/rules/branches/main" --jq '.[]|"\(.type) (ruleset \(.ruleset_id))"'
for id in $(gh api "repos/$REPO/rulesets" --jq '.[].id'); do
  gh api "repos/$REPO/rulesets/$id" --jq '.rules[]|select(.type=="required_status_checks")|.parameters'
  gh api "repos/$REPO/rulesets/$id" --jq '.rules[]|select(.type=="pull_request")|.parameters'
done
```

Two traps:
- **Rulesets vs classic protection.** `branches/main/protection` returning 404 "Branch not
  protected" does NOT mean unprotected — modern repos use **Rulesets** (Settings → Rules →
  Rulesets). Query `/rules/branches/main`, which reports what actually applies.
- **Thread resolution hides inside `pull_request`.** `required_review_thread_resolution` is a
  *parameter* of the `pull_request` rule, not a rule type. Filtering by `.type` misses it and you
  will wrongly conclude threads don't block.

### 1b. Compare a fork PR's checks against a base PR's

```bash
gh pr view <BASE_PR> --repo "$REPO" --json statusCheckRollup --jq '[.statusCheckRollup[]?|(.name//.context)]|sort'
gh pr view <FORK_PR> --repo "$REPO" --json statusCheckRollup --jq '[.statusCheckRollup[]?|(.name//.context)]|sort'
```

**The fork gate.** GitHub withholds repository secrets from fork PR workflows (otherwise any
fork could exfiltrate them). So any check needing a credential — a deploy preview, a
cloud-provider integration — **never runs** on a fork. Its check is *absent*, not failing. If
such a check is `required`, every fork PR is permanently unmergeable no matter how clean.

Detect it by the check being **missing** from the fork's rollup while present on a base PR.

Remedies, in order of preference:
1. Give the contributor write access → future branches are in-repo and get the token.
2. Migrate existing heads to base-repo branches.
3. Temporarily drop that check from `required_status_checks` — **ask the user first**, back the
   ruleset up, and record how to restore it:
   ```bash
   gh api "repos/$REPO/rulesets/$ID" --jq '{name,target,enforcement,conditions,bypass_actors,rules}' > backup.json
   jq '{name,target,enforcement,conditions,bypass_actors,rules:[.rules[]|select(.type!="required_status_checks")]}' backup.json > relaxed.json
   gh api -X PUT "repos/$REPO/rulesets/$ID" --input relaxed.json   # restore: --input backup.json
   ```
   Never `--admin`-merge instead; that bypasses the gate silently and per-PR.

**Side effect worth knowing:** `strict_required_status_checks_policy` lives inside that same rule.
Dropping it also drops "must be up to date with base", which is what forces one-at-a-time
merging. Merges stop serializing — a large speedup, and a real reduction in safety. Say both.

### 1c. Is the automated reviewer actually firing?

A PR with **zero** review signal is not "reviewed and clean" — it is unreviewed.

```bash
gh api "repos/$REPO/pulls/<N>/reviews"  --jq '[.[]|select(.user.login|test("bot|codex|copilot";"i"))]|length'
gh api "repos/$REPO/issues/<N>/comments" --jq '[.[]|select(.user.login|test("bot|codex|copilot";"i"))]|length'
gh api "repos/$REPO/issues/<N>/reactions" -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
  --jq '[.[]|select(.user.login|test("bot|codex|copilot";"i"))|.content]'
```

Reviewer signals are **not all review objects** — check reviews, issue comments, AND reactions:
- **👍 (`+1`) on the PR description** = the no-findings **clean pass**.
- **👀 (`eyes`)** = acknowledged / in progress. **NOT a verdict — do not merge on it.**
- Review threads with severity badges = findings.

If a connector has been switched to request-only, nothing is reviewed until asked. Request
**once** per PR (`@codex review` or the repo's equivalent); do not re-request after each
remediation push — that is how a review↔fix treadmill starts.

### 1d. Is `main` itself green?

```bash
gh run list --repo "$REPO" --branch main --limit 8 --json conclusion,headSha --jq '.[]|"\(.headSha[0:8]) \(.conclusion)"'
```

If `main` is red, every branch inherits it and you will misattribute failures to your own diff.
Fix or ticket that first, and record the failing test names so you can recognise them later.

## Step 2 — Triage every thread in parallel, and VERIFY

With many PRs, fan out one agent per PR (Task tool, or a workflow if available). Have each agent
**read the cited code on the PR's branch** and decide whether the defect is real — not summarize
the finding.

Require per thread: `threadId`, `severity`, `is_real`, `assessment` (citing what was read),
`fix_approach` (file + function + change), `complexity` (trivial/moderate/deep).

Insist on these, because they change the plan:
- **`is_real: false` happens.** Findings get fixed by a later commit on the branch, or describe an
  unreachable path. One in ten is typical. Fixing a non-defect wastes real time.
- **Whole PRs can be superseded.** If the fix already landed via another PR, the right action is
  to **close it with evidence**, not to fix it.
- Agents must be **read-only** here: no edits, commits, pushes, or thread replies. Triage and
  remediation are separate phases.

Then rank by `complexity`, and clear whole PRs rather than skimming the easy findings across many
— a PR is only mergeable when *every* thread is resolved.

## Step 3 — Fix, honoring the severity policy

- **P0/P1: always fix**, on every round.
- **P2 and below: use judgment on round one; defer on later rounds** to a follow-up ticket, reply
  with the link, and resolve the thread. Deferral *resolves* the thread — it does not leave it open.
- Match the severity string exactly. A regex whose fallback bucket is "P3" will silently
  mislabel a **P0** as low priority. Match P0 explicitly.

While fixing:
- **Verify the finding yourself.** Reviewers are often right and occasionally wrong; say so with
  evidence either way.
- **Prefer deleting the wrong thing over patching it.** If a change contradicts a documented
  invariant, removing it and fixing the root cause beats layering a guard.
- **Mutation-test any fix whose whole value is catching a failure.** Break the code and confirm
  the new test fails. A test that passes before *and* after your fix is not covering it.

## Step 4 — Conflicts need judgment, not a flag

Never blanket `--ours`/`--theirs`. The three real cases:

| Situation | Resolution |
|---|---|
| Both sides added different items (imports, CI test lists, doc sections, test blocks) | **Union.** Dropping either side silently removes coverage. |
| One side duplicates something the other already has (a second `push:` key, a repeated block) | **Drop the duplicate** — keeping both can be invalid syntax. |
| Genuine semantic conflict | Read both, decide, and explain in the commit message. |

Always re-validate after resolving: `bash -n`, `node --check`, a YAML parse, and the file's own
test suite. A union that produces a duplicate YAML key breaks CI for everyone.

## Step 5 — Merge, and judge CI honestly

```bash
gh pr merge <N> --repo "$REPO" --squash --delete-branch
```

Before merging, check the **actual** failing checks rather than trusting the gate:

```bash
gh pr view <N> --repo "$REPO" --json statusCheckRollup \
  --jq '[.statusCheckRollup[]?|select((.conclusion//.state)|IN("FAILURE","ERROR"))|(.name//.context)]'
```

If something is red, decide deliberately:
- **Compare against `main`.** Same failure on `main` = pre-existing, not yours.
- **Stash your changes and re-run locally.** Identical failure count = pre-existing. This is the
  single most reliable check and it takes one minute.
- **Re-run the job.** Different tests failing on a re-run of the same commit = flaky suite.
- Only then merge over it — and **say in your report that you did, and why**.

If strict/up-to-date is enforced, merges serialize: bring ONE PR up to date, let it merge, then
the next. Batch-advancing wastes build slots on heads that go stale before they finish.

**Use a real push, not the API's update-branch**, if the required check is a deploy integration —
an API-created merge commit may not trigger it, leaving the PR blocked on a check that never
appears.

## Step 6 — Reconcile the tickets

A merged PR usually means its ticket should advance. After a burndown, check every ticket
referenced by a merged PR and move any that are still open. See the repo's ticket-CLI skill for
the exact commands, and prefer the local replica for reads.

## Reporting

State the split, not the raw count: how many merged, how many *stale* remain, how many arrived
during the run. Name the structural blocker you found and whether it is fixed or worked around.
List anything you merged over a red check and why. If a ruleset is still relaxed, say so loudly
with the restore command — that is a security-relevant state you are leaving behind.
