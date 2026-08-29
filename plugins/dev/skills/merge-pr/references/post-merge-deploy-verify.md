# Post-merge deploy verification (CTL-2232)

The callable check for merge-pr acceptance: confirm a squash-merged change actually **deployed** and passes a **live smoke check**, without depending on the broker/event-log `filter.wake` mechanism. Invoke after Step 13 in [post-merge.md](post-merge.md), passing the REST-confirmed `merge_commit_sha` (never a local `git rev-parse HEAD` — see the Step 9 note in [worktree-safe-merge.md](worktree-safe-merge.md)), or standalone by a coordinator given that SHA and a PR number.

⚠️ `merge-pr` is a portable skill installed across many repos, and this file documents **catalyst's own** deploy surfaces specifically (Codex P1, PR #4043). `verify_post_merge_deploy` gates on repo identity first and returns `NO_DEPLOY_CONFIG` — not `NOT_APPLICABLE` — for every other repo, so a consuming repo without an equivalent mapping gets an honest "unconfigured" answer instead of a silently wrong one.

## What "deployed" means in THIS repo — two surfaces, not one

`catalyst` is a plugin/skills repo. It has no Worker API to smoke-test. Its deploy surface splits in two, and only one of them has a live check available — say so honestly rather than fabricating a check for the other:

| Surface | Trigger | Live signal |
|---|---|---|
| Docs/marketing site (`website/**`), Astro Starlight on Cloudflare Pages | CF's **native GitHub integration** — no `.github/workflows/*.yml` for it. Build watch paths = `website/**` only (see `docs/ci-required-checks-rollout.md`). CF posts **no status at all** when a push doesn't match the watch paths — that's a documented CF behavior, not a gap in this check. | The `Cloudflare Pages` commit **status** (Statuses API, not check-runs) on the merge commit, then a live fetch of `https://catalyst.coalescelabs.ai`. |
| Everything else — `plugins/**`, `scripts/**`, non-website docs (the overwhelming majority of merges, including this ticket's own PR) | The plugin marketplace (`.claude-plugin/marketplace.json`) points `source` at `./plugins/<name>` **in this same git repo**. There is no build, publish, or CDN step — a consumer's marketplace refresh reads straight from `main`. | **None distinct from the merge itself.** Landing on `main` *is* the deploy. |

The second row is the honest answer for most merges (including CTL-2232's and CTL-2244's own PRs): there is nothing live to poll beyond the squash-merge readback `merge-pr` already does (`worktree-safe-merge.md`). Do not invent a smoke check here.

## The callable procedure

```bash
verify_post_merge_deploy() {
  local sha="$1" repo
  repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

  # 0. This reference maps CATALYST'S OWN two deploy surfaces (below). A repo that isn't
  #    catalyst has no website/** docs site or catalyst.coalescelabs.ai to check — assuming
  #    every non-website merge there is NOT_APPLICABLE would be silently wrong. Gate on repo
  #    identity; a different repo needs its own equivalent mapping (see config-safety.md's
  #    `.catalyst/config.json` as the natural place to declare one — not built here, since no
  #    second repo's mapping exists yet to design against).
  if [[ "$repo" != "coalesce-labs/catalyst" ]]; then
    echo "NO_DEPLOY_CONFIG"
    return 0
  fi

  # 1. Is this merge docs-relevant? Same predicate CF's own watch paths use.
  local files; files=$(gh api "repos/${repo}/commits/${sha}" --jq '.files[].filename' 2>/dev/null)
  if ! echo "$files" | grep -q '^website/'; then
    echo "NOT_APPLICABLE"   # marketplace is git-native — merge to main IS the deploy
    return 0
  fi

  # 2. bounded-poll (CI preset: 30s x 30 = 15min, see bounded-poll.md) on the CF Pages commit status on the MERGE commit — CF's production build runs against the new main commit, not the PR's pre-merge head SHA.
  local count=0 state
  while [ "$count" -lt 30 ]; do
    state=$(gh api "repos/${repo}/commits/${sha}/status" \
      --jq '.statuses[] | select(.context=="Cloudflare Pages") | .state' 2>/dev/null | head -1)
    [ "$state" = "success" ] && break
    [ "$state" = "failure" ] || [ "$state" = "error" ] && { echo "DEPLOY_FAILED"; return 1; }
    count=$((count + 1))
    [ "$count" -lt 30 ] && sleep 30
  done
  if [ "$state" != "success" ]; then
    echo "DEPLOY_PENDING"   # ceiling hit — explicit, not silent (bounded-poll.md's contract)
    return 1
  fi

  # 3. Live smoke check — the deployed site actually answers.
  local code; code=$(curl -sS -o /dev/null -w '%{http_code}' https://catalyst.coalescelabs.ai)
  if [ "$code" = "200" ]; then echo "DEPLOYED"; return 0; else echo "SMOKE_FAILED"; return 1; fi
}
```

Sentinels follow `bounded-poll.md`'s convention exactly: a distinct value per outcome, never a bare success-looking string, and the ceiling-hit case (`DEPLOY_PENDING`) is a documented terminal answer for this phase, not silently retried. This is the bounded-poll pattern with the predicate swapped for a commit-status read — see [bounded-poll.md](bounded-poll.md) for the mechanism this reuses (interval/ceiling table, the `ERROR` vs `PENDING` distinction) rather than re-deriving it here.

## Why the Statuses API, not check-runs

`gh pr checks` merges both check-runs and legacy commit statuses into one display, which hides which API a given context actually uses. Cloudflare's GitHub integration posts via the older **Statuses API** (`GET /commits/{sha}/status`, not `/check-runs`) — confirmed against `docs/ci-required-checks-rollout.md`'s own read recipe. Reading `/check-runs` for `Cloudflare Pages` would silently return nothing and read as "no evidence," which is a different failure than `DEPLOY_PENDING` above and should not be confused with it.

## No `filter.wake` / broker / daemon dependency

This procedure is pure `gh api` REST plus one `curl`. It does not call `catalyst-events`, `catalyst-broker`, or anything that requires the retiring daemon's event log — the loop runs foreground, in the calling session, exactly like bounded-poll.md's loop (the wait-for-github skill that documented this pattern before was removed with the daemon, CTL-2240). The PR body cites a `/usr/bin/grep` proof (with a positive control) rather than asserting this from prose alone.
