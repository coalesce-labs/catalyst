# Step 9 — Execute Squash Merge, catalyst-cloud queue-merge default (CTC-1219)

_Full logic for Step 9 ("Execute squash merge") in [worktree-safe-merge.md](worktree-safe-merge.md).
Split out here to stay under the skill's per-reference line budget._

```bash
# CTL-56: capture head ref + head repo BEFORE merge so we can delete checkout-free after
# a REST-confirmed merge.
head_ref=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.head.ref' 2>/dev/null || true)
head_repo=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.head.repo.full_name' 2>/dev/null || true)
already_merged=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.merged' 2>/dev/null || echo "false")

# CTC-1219: catalyst-cloud queue-merge default. In that repo, Mergify (.mergify.yml) owns
# every ELIGIBLE merge — the agent's act shrinks to applying `queue:ready` and stopping; the
# coordinator/steward treats "merged by mergify[bot]" as the terminal signal, not this
# session. Hand-step exceptions (schema/migration paths, `hold:hand-steps`) and every OTHER
# repo (this plugin repo included — that rollout is a separate ticket) keep the unchanged
# hand-merge path below. Re-entrant: if a later invocation lands here after mergify already
# merged it, `$already_merged` short-circuits straight past both branches to the REST-confirm
# retry, so post-merge (Step 9b onward — branch cleanup, Linear Done, deploy verify, compound
# close) still runs even though nobody in this session called `gh pr merge`.
if [[ "$already_merged" != "true" && "${REPO}" == "coalesce-labs/catalyst-cloud" ]]; then
  # Codex P1 (PR #4072): fail closed, not open, when either read fails — an empty
  # $labels/$changed_files from a transient `gh pr view` error must never be silently
  # interpreted as "no hold label, no schema/migration path" and auto-queued.
  if ! labels=$(gh pr view "$pr_number" --json labels -q '[.labels[].name] | join(",")'); then
    echo "❌ merge-pr: could not read labels for #$pr_number — not safe to auto-queue; retry or hand-merge." >&2
    exit 1
  fi
  if ! changed_files=$(gh pr view "$pr_number" --json files -q '[.files[].path] | join("\n")'); then
    echo "❌ merge-pr: could not read changed files for #$pr_number — not safe to auto-queue; retry or hand-merge." >&2
    exit 1
  fi
  hand_step=false
  [[ ",$labels," == *",hold:hand-steps,"* ]] && hand_step=true
  # Mirror .mergify.yml's queue_conditions path exclusions exactly: schema anchored at repo
  # root, migrations/ unanchored anywhere in the path.
  echo "$changed_files" | grep -qE '^(packages/schema/|.*migrations/)' && hand_step=true

  if [[ "$hand_step" == "false" ]]; then
    if [[ ",$labels," == *",queue:ready,"* ]]; then
      echo "⏳ #$pr_number already labeled queue:ready — still waiting on Mergify, no gh pr merge."
    else
      # Codex P2 (PR #4072): propagate a failed label edit instead of falling through to the
      # unconditional success messaging below — an unlabeled PR will never be picked up by
      # Mergify, and reporting success here would hide that.
      if ! gh pr edit "$pr_number" --add-label "queue:ready" >/dev/null; then
        echo "❌ merge-pr: failed to add queue:ready label to #$pr_number — PR NOT queued, Mergify will never see it. Retry or hand-merge." >&2
        exit 1
      fi
      echo "⏳ catalyst-cloud queue-merge default (CTC-1219): applied queue:ready — Mergify owns"
      echo "   this merge. No gh pr merge. Re-run /merge-pr on #$pr_number (or let the"
      echo "   coordinator re-dispatch the merge phase) once mergify[bot] merges it, to finish"
      echo "   post-merge: Linear Done, deploy verify, compound close."
    fi
    exit 0
  fi
  echo "merge-pr: hand-step exception (schema/migration path or hold:hand-steps) on #$pr_number — hand-merging as usual." >&2
fi

if [[ "$already_merged" == "true" ]]; then
  merged_by=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.merged_by.login // "unknown"' 2>/dev/null || echo "unknown")
  echo "merge-pr: #$pr_number already merged (by $merged_by) — skipping gh pr merge, resuming post-merge steps." >&2
else
  # Merge via REST only — no local branch-cleanup flag (CTL-56).
  gh pr merge $pr_number --squash
fi
# Codex P1 (CTL-2232, PR #4043): `gh pr merge` merges on GitHub's side and never touches this
# local checkout, so `git rev-parse HEAD` here is whatever the worktree already had checked
# out (typically the PR branch's own pre-merge tip in a linked worktree) — NOT the new squash
# commit that landed on the base branch. Read the authoritative merge commit back via REST
# instead; a merge can take a moment to report `merge_commit_sha`, so retry briefly.
merge_sha=""
for _ in 1 2 3 4 5; do
  merge_sha=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.merge_commit_sha // empty' 2>/dev/null || true)
  [[ -n "$merge_sha" ]] && break
  sleep 2
done
```

**Coordinator/steward responsibility:** for a queued-and-stopped catalyst-cloud PR, something outside this single invocation must notice the eventual `merged by mergify[bot]` and re-enter this skill (or re-dispatch the relay-ticket merge phase) so Steps 9b–15 actually run — the label alone does not transition Linear, verify the deploy, or trigger the compound sentinels. Do not assume a GitHub Action's PR-body text-convention (e.g. a `Closes CTC-NN` scan) substitutes for this: it is opt-in, silently no-ops on ordinary PR titles that don't use the magic words, and has no path to deploy verification or the compound closing ritual at all — this skill's own Step 10 `linear-transition.sh` call (and Steps 13b/14) are the reliable, repo-agnostic path and must still be the one that runs, regardless of who performed the actual merge.
