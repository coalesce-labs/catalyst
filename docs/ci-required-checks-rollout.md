# CI required-checks rollout — swap `Cloudflare Pages` → `docs-gate` (CTL-670)

Operator runbook for making `docs-gate` the sole required status check on `main` and demoting the
slow `Cloudflare Pages` preview build to a non-required, build-watch-path-gated deploy.

**Why:** ~75% of PRs change nothing under `website/`, yet every PR pays the ~3-min Cloudflare Pages
build before it can merge, because `Cloudflare Pages` is the repo's *sole* required check under a
strict policy. Cloudflare posts **no** check-run/commit-status when a build is skipped (CI Skip,
build watch paths, or branch deployment controls), so we cannot simply skip the CF build on non-docs
PRs — that would leave a required check that never reports, blocking every non-docs PR forever.
Instead we introduce an in-repo `docs-gate` Action that *always* reports (honoring the invariant in
[configuration.md](https://github.com/coalesce-labs/catalyst/blob/main/website/src/content/docs/reference/configuration.md):
"only mark a check as required if it runs on every PR to `main`"), make **it** the required check,
and let Cloudflare Pages keep deploying via watch paths without being required.

**What `docs-gate` does** (`.github/workflows/docs-gate.yml`): runs on every PR with no path filter;
computes changed paths and delegates the docs-relevance decision to
`scripts/ci/docs-paths-changed.sh` (docs-relevant = anything under `website/`, or any
`plugins/*/CHANGELOG.md` — the changelog dependency in `website/astro.config.mjs`). Non-docs PRs
pass in seconds; docs PRs run `npm ci && npm run build` and must be green.

---

## ⚠️ Critical ordering invariant

**Never set the Cloudflare "Build watch paths" (step 5) before removing `Cloudflare Pages` from the
required set (step 4).** In the gap between those two actions, non-docs PRs would skip the CF build
(no status posted) while CF is still required → every non-docs PR becomes permanently unmergeable.
The ordering below keeps `main` mergeable at every step, and every step is reversible (re-add
`Cloudflare Pages` to the required set to roll back).

Read branch protection from the **ruleset** endpoint, not classic protection — the classic
`/branches/main/protection` endpoint returns **404** for this repo and reading it lies:

```bash
gh api repos/coalesce-labs/catalyst/rules/branches/main
```

---

## Rollout steps

### 1. Merge the `docs-gate` workflow (this PR)

Once merged, `docs-gate` runs on subsequent PRs but is **not yet required**. (This PR itself is
still gated by the current `Cloudflare Pages`-only requirement — that is fine.)

### 2. Empirical pre-flight (research OQ #1) — confirm the CF skip behavior

Open a **scratch non-docs PR** (e.g. touch a root file). Confirm `docs-gate` passes fast:

```bash
gh pr checks <n>           # docs-gate should complete in seconds with the
                           # "No docs-relevant changes" log line
```

At this point `Cloudflare Pages` still builds — expected, because CF watch paths are not set yet.
This step exists to confirm the vendor-documented skip behavior empirically *before* touching
branch protection.

### 3. Add `docs-gate` to the required set **alongside** `Cloudflare Pages`

Both required. Nothing skips yet, so this is safe. Verify on an open PR that `docs-gate` reports.

```bash
# Read the current ruleset and find the required_status_checks rule + the ruleset id.
gh api repos/coalesce-labs/catalyst/rules/branches/main
gh api repos/coalesce-labs/catalyst/rulesets --jq '.[] | {id, name}'

# Fetch the full ruleset, edit the required_status_checks rule to list BOTH
# "Cloudflare Pages" and "docs-gate" (keep strict_required_status_checks_policy: true),
# then PUT it back.
gh api repos/coalesce-labs/catalyst/rulesets/<RULESET_ID> > /tmp/ruleset.json
# (edit /tmp/ruleset.json: required_status_checks → [Cloudflare Pages, docs-gate], strict=true)
gh api -X PUT repos/coalesce-labs/catalyst/rulesets/<RULESET_ID> --input /tmp/ruleset.json
```

> The `docs-gate` required-context **string** is the job name. With job key `docs-gate` (and `name:`
> defaulting to it) the context is `docs-gate`. Confirm on the first PR run:
> `gh pr checks <n> --json name`.

### 4. Remove `Cloudflare Pages` from the required set

Now only `docs-gate` is required. CF still builds but no longer gates merges — harmless.

```bash
# Edit /tmp/ruleset.json: required_status_checks → [docs-gate] only, strict=true
gh api -X PUT repos/coalesce-labs/catalyst/rulesets/<RULESET_ID> --input /tmp/ruleset.json
```

### 5. Set Cloudflare "Build watch paths"

In the Cloudflare Pages dashboard: **Settings → Builds & deployments → Build watch paths**. Set
**Include paths** to mirror the Phase 1 docs-relevant set (CF `*` crosses `/`, so `website/*`
recurses):

- `website/*`
- `plugins/*/CHANGELOG.md`

Now non-docs PRs skip the CF build and are no longer blocked.

> Keep this include set in sync with `scripts/ci/docs-paths-changed.sh`'s two patterns. If they
> drift, a PR could build in CF but skip `docs-gate`'s build (or vice-versa).

### 6. Confirm the skip behavior on the scratch non-docs PR

```bash
gh pr checks <n>   # expect: docs-gate pass; NO "Cloudflare Pages" row (CF skipped, no status)
```

### 7. Confirm docs PRs still deploy

Open a scratch `website/` PR:

```bash
gh pr checks <n>   # expect: docs-gate running the build, AND a "Cloudflare Pages" deploy row
```

Optionally prove the gate blocks broken docs: push a deliberately malformed `.mdx` and confirm
`docs-gate` **fails**.

### 8. Re-verify `phase-monitor-merge` picks up `docs-gate` dynamically

The merge monitor reads the required-check set from the ruleset at runtime — it does **not**
hardcode `Cloudflare Pages`. Confirm no hardcoded required-check string regressed:

```bash
grep -rn "Cloudflare Pages" plugins/dev/scripts plugins/dev/skills | grep -iv test
```

This should return nothing that treats `Cloudflare Pages` as *the required check*. No
`phase-monitor-merge` code change is needed.

---

## End-state verification

```bash
gh api repos/coalesce-labs/catalyst/rules/branches/main \
  --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
# → lists docs-gate, NOT Cloudflare Pages; strict_required_status_checks_policy: true
```

- A real non-docs PR (e.g. the next pipeline PR) merges without waiting on CF.
- A real docs PR builds in `docs-gate` and deploys via CF.
- `phase-monitor-merge` merges a post-rollout PR without manual intervention.

## Rollback

Re-add `Cloudflare Pages` to the required set (step 3 in reverse) and/or clear the CF Build watch
paths so CF builds on every push again. Every step above is individually reversible.

## Notes / edge cases

- **CF force-builds** on 0-file, 3000+-file, or 20+-commit pushes regardless of watch paths. These
  produce a `Cloudflare Pages` status on PRs that `docs-gate` classifies non-docs — harmless (CF is
  no longer required), but worth knowing if anyone re-adds CF to the required set.
- **Hard-block on deploy vs build** is out of scope. `docs-gate` blocks docs PRs on the in-CI
  `astro build`, not the CF *deployment*. Blocking merge on the CF preview/production deploy itself
  needs a different mechanism (a job polling the CF deployment commit-status / CF API) and is a
  follow-up — it is *not* achievable by keeping CF as a required check while it skips.
- **Context-name coupling:** if the `docs-gate` job is ever renamed, the ruleset's required-context
  string must be updated in lockstep (the same coupling `Cloudflare Pages` had).

## References

- [`website/src/content/docs/reference/configuration.md`](https://github.com/coalesce-labs/catalyst/blob/main/website/src/content/docs/reference/configuration.md)
  — the required-check model and the "only require checks that run on every PR" invariant.
- `.github/workflows/docs-gate.yml` — the always-running, path-aware gate.
- `scripts/ci/docs-paths-changed.sh` — the docs-relevance decision helper (keep in sync with the CF
  watch-path include set).
