# 3-Tier Rope, Rubric Two, and Rubric Three

## The 3-tier rope — how much you may do on your own

The line is simple: **does this change the SYSTEM, or just unstick a stuck THING?**

- **Tier 1 — Just fix it (act silently, log it).** Rebases, merge conflicts, a green
  PR sitting unmerged, re-dispatch a dead phase, clear a stale cache row/label, CI
  fixups. Record the win via `recovery-emit.mjs fixed` (INFO, no push).
- **Tier 2 — Fix it, but FILE a finding.** A **daemon restart** is the canonical case:
  do it autonomously (you ARE allowed to restart a broker / execution-core / monitor),
  but needing a manual restart is the tell we're missing a supervisor — so file an
  automation-gap finding (below). The restart is the band-aid; the finding is the fix.
- **Tier 3 — Ask first (executive briefing → the operator decides → becomes a setting).** Any
  system-wide change: overriding the liveness hold, a global config flip, taking a node
  out of the roster. Escalate via Step 4 with a briefing that REFRESHES the operator on *what
  it is, why we have it, why it's failing, your recommendation* — plain language, no
  jargon. He decides; the decision becomes a durable setting so next time it's Tier 1/2.

## The three delegate rubrics — the senior-engineer judgment gates

The 3-tier rope says *how much* you may do. These three rubrics say *exactly how to
judge* the three hardest cases the delegate faces, and they are the **gating
heuristics you MUST satisfy before any autonomous action** of that kind.

- **Rubric One** governs moving a PR-state ticket to Done — see [rubric-one.md](rubric-one.md).
- **Rubric Two** governs finishing a stuck PR yourself vs. escalating (below).
- **Rubric Three** governs deciding a human is genuinely needed and authoring the brief (below).

### RUBRIC TWO — Finish-the-PR vs. escalate

> When you anchor on a stuck PR, you are the senior engineer who unsticks it. Default to FINISHING it.
> Source the lib primitives once: `source "${PLUGIN_ROOT}/scripts/lib/worktree-rebase.sh"` and
> `source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"`. `$BASE` is `origin/<the PR's base branch>`.
>
> **FINISH (do it yourself), bounded engineering:**
> - BEHIND/DIRTY worktree → `rebase_onto_base_classified "$BASE"`, then branch on the rc:
>   - rc=0 (clean/additive) → `draft_pr_push_verify`, re-arm the failed monitor-merge signal to
>     `status:"pending"` (atomic tmp+mv) so the scheduler re-queues it, `recovery-emit fixed`.
>   - rc=1 (fetch fail) → proceed un-rebased; log; NOT an escalation.
>   - rc=2 (source conflict — the ctl708 auto-resolver stub always returns rc=2 for ANY real source
>     conflict) → **resolve it yourself**: `git log --merge`, `git diff`, pick the resolution
>     consistent with the ticket goal, `git add`, `git rebase --continue`, `draft_pr_push_verify`.
>     This is bounded-LLM engineering, NOT an automatic escalation.
> - Green PR just sitting there → `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`,
>   then run the cluster fence guard (`"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase
>   recovery-pass --ticket <T>`), then capture the head ref
>   (`gh api repos/<owner/repo>/pulls/<n> --jq '.head.ref'`) and
>   `gh pr merge <n> --squash` (CTL-56: worktree-safe — no local branch-cleanup side effect). **When
>   the open-PR enumerator printed this PR as `owner/repo#n` (a cross-repo Linear attachment, a
>   DIFFERENT repo than the ticket's), you MUST pass `-R <owner/repo>` on the view AND the merge
>   (`gh pr merge <n> -R <owner/repo> …`)** — a bare `gh pr merge <n>` runs against the ticket's
>   repo and would merge the wrong same-numbered PR while the attached one stays open. Verify via REST
>   (`gh api repos/<owner/repo>/pulls/<n> --jq '.merged'`), then delete the remote head ref
>   checkout-free: `gh api --method DELETE repos/<owner/repo>/git/refs/heads/<head_ref>` against the
>   same `<owner/repo>` — but ONLY when the head branch lives in that repo
>   (`.head.repo.full_name == <owner/repo>`); a fork PR's `.head.ref` lives in the fork, so deleting
>   it from the base repo could hit an unrelated same-named branch (CTL-56). URL-encode `<head_ref>`
>   (preserve `/`) first so a metacharacter like `#` can't truncate the endpoint. Idempotent +
>   best-effort — a 404/422 means already gone or protected.
> - Red CI with a deterministic cause (type error, lint, a flaky test) → fix it, push, re-check
>   (bounded by the attempts cap of 2 — after honest attempts that still fail on a *genuine design
>   incompatibility*, it becomes an escalation, below).
>
> **ESCALATE instead of finishing (→ Rubric Three) when:**
> - rc=3 (thoughts/ symlink conflict) → always escalate (symlink safety; never auto-resolve).
> - `draft_pr_push_verify` rc=3 (workflow-scope OAuth missing, no `CATALYST_WORKFLOW_GITHUB_TOKEN`) →
>   authorization escalate: "add CATALYST_WORKFLOW_GITHUB_TOKEN to claude-accounts.env and re-run".
> - Human reviewer (not a bot) left CHANGES_REQUESTED → authorization escalate with the reviewer's ask.
> - Source conflict spans a load-bearing API boundary → decision escalate with both options.
> - CI persistently red after 3+ honest fix attempts where the root cause is a genuine design
>   incompatibility (not a type/lint error) → authorization escalate. **NEVER `--admin` / force-merge
>   past a failing or pending check.** This is the load-bearing safety property.

### RUBRIC THREE — When a human is GENUINELY needed

> Escalate ONLY when you decide one of these is true. Otherwise you keep the board moving yourself.
> Every escalation writes the curated 6-field brief (below) authored FOR the human.
>
> 1. **ADR / principle conflict** — the fix would violate a documented architectural decision or a
>    stated principle. `escalation_type:"decision"`. Name the ADR/principle and the two shapes.
> 2. **Real regression risk** — the only way forward changes a shipped, load-bearing contract another
>    ticket depends on, and you cannot prove the change is safe. `escalation_type:"decision"`.
> 3. **Un-contemplated decision** — the plan/description does not cover the situation and choosing
>    wrong is expensive or hard to undo. `escalation_type:"decision"`.
> 4. **Authority/credential you lack** — `--admin` bypass, a missing OAuth scope/token, a human
>    reviewer's explicit change request, an action outside your granted tools. `escalation_type:"authorization"`.
>
> NOT a reason to escalate: a merge conflict you can resolve; a red CI with a deterministic cause; a
> BEHIND branch; a green PR awaiting merge; a phantom merged-PR ticket whose plan is fully delivered.
> Those you finish yourself.
>
> **The curated 6-field escalation brief.** Every escalation authors these six fields (via
> `escalation-explain.mjs` in Step 4 — the field → flag map is in parentheses):
>
> - `escalation_type` (`--type`) — `decision | authorization | manual`. Prefer the first two.
> - `call_to_action` (`--call-to-action`) — the specific question/action for the operator.
> - `problem` (`--problem`) — what is stuck and why, ticket-specific (name the files/PRs/tickets).
> - `why_you` (`--why-you`) — why THIS stuck state needs a human.
> - `why_not_auto` (`--why-not-auto`) — the concrete capability boundary you hit.
> - `what_to_do` (`--instructions`, numbered) + `outcome` (`--remediation-then-retry`).
>
> For a `decision` escalation also pass `--options '[{"label":…,"tradeoff":…}, …]'`.
