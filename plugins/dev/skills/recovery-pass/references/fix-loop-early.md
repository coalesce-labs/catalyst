# Filing Findings and Steps 0–2

## Filing a delegate finding (the compounding loop)

Everything you do feeds the **Self-Healing Delegate** Linear project so the system
learns and the wedge-class disappears over time. Two kinds:

- **Intervention record** — "here's something I had to do" — `recovery-emit.mjs fixed
  --ticket <T> --reason "<plain past-tense changelog>"` (audit trail + pattern
  detection).
- **Automation gap** — "here's a Catalyst code change we should make" — file a Gherkin
  ticket (`gherkin-ticket` skill: outcome title `<actor> should <outcome> so that
  <benefit>` + Given/When/Then AC) into the **Self-Healing Delegate** project,
  **Backlog** (never Todo — Todo auto-dispatches), with a component label + estimate.
  ALWAYS file one when you hit Tier 2/3, or any "this shouldn't have been necessary."

## Phase-specific work — the senior-engineer unstick loop

Think hard. You are a senior engineer; the operator is your executive product manager.
Default to ACTING. For each stuck item, walk the decision checklist top-to-bottom;
first match wins. Print a per-item resolution line for every item.

**Every item ends in exactly ONE of three verdicts, and every verdict is EMITTED
(CTL-1439):** `FIX` (`recovery-emit.mjs fixed`), `LEAVE-ALONE`
(`recovery-emit.mjs leave-alone` — Step 2.5), or `ESCALATE`
(`recovery-emit.mjs escalated` — Step 4). A conclusion that lives only in your
transcript does not exist. Emit the verdict for the ticket you were DISPATCHED for
(`CATALYST_TICKET`); if you also acted on other tickets along the way, emit a
verdict for each of those separately.

### Step 0 — Consume the eyes + hands output (do NOT redo it)

Read the brief's `diagnosis` (the diagnostician evidence) and
`deterministicSeamsTried` (which seams the hands already ran and that did NOT
clear it). You are picking up where the narrow passes failed — do NOT re-run the
diagnostician and do NOT re-run a seam that is listed as already-tried.

**PICKUP comment (enforce-only, once per item).** Right after you have the
one-line diagnosis and BEFORE you act, post a soft claim-signal comment:

```bash
_rp_comment "$TICKET" "🔧 **recovery-pass** is working this — <one-line diagnosis of what's stuck>. Resolving autonomously or escalating."
```

`_rp_comment` is no-op outside enforce and fail-open. Post it exactly ONCE per item.

### Step 1 — Can a REGISTERED SEAM clear it? (deterministic → FIX, no further work)

If the brief shows a typed mechanical case that did NOT already run its seam,
let the seam handle it. (Orphan PR / stale-sweep → orphan-reconcile; push rejected
no workflow scope → workflow-token-redispatch; sibling conflict CTL-855; orphan/
duplicate PR CTL-1175/1159/1160; ADR-024 hygiene cleaners.) Do not duplicate a
seam that is in `deterministicSeamsTried`.

> **`deterministicSeamsTried` is NOT exhaustive.** It is reconstructed from the
> three on-disk unstuck markers only — `dirty-tree`, `source-conflict`,
> `orphan-stale`. Seams WITHOUT a marker will NEVER appear there even if they ran,
> so do not read an absence as "this seam has not been tried." For those, judge from
> the diagnosis + the live git/gh state whether the mechanical action already took
> effect before re-firing.

### Step 2 — Resolve it MYSELF with bounded engineering (BOUNDED-LLM → FIX)

You have full tool access. These are ALL things you do autonomously — never
escalate them. **For a stuck PR, follow RUBRIC TWO** (the rc=0/1/2/3 decision over
`rebase_onto_base_classified` + `draft_pr_push_verify`). **For a PR-state / phantom
merged-PR ticket you think is "done", do NOT mechanically Done it — run RUBRIC ONE
first** (enumerate ALL the ticket's PRs, reason about and remediate EACH open one
yourself, then declare Done autonomously via `declare --by recovery-pass`).

- **Merge / rebase conflict** → read BOTH sides (`git log --merge`,
  `git diff`, the two conflicting hunks). Pick the resolution consistent with this
  ticket's stated goal. If the conflict is purely additive (both sides add
  different things), keep both. `git add`, `git rebase --continue` (or
  `git commit`), then push.
- **Stale / diverged branch** → `git fetch origin && git rebase --autostash
  origin/main`; if it conflicts, treat as the conflict case above; force-push.
- **CI failure after rebase/push** → `gh run view --log-failed`, fix the root
  cause (type error / lint / test), commit, push to re-trigger.
- **A green PR just sitting there** → verify it is CLEAN
  (`gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`), capture the head ref
  (`gh api repos/<owner/repo>/pulls/<n> --jq '.head.ref'`), then `gh pr merge <n> --squash`
  (CTL-56: worktree-safe). **For a cross-repo PR the enumerator printed as `owner/repo#n`,
  pass `-R <owner/repo>` on both** — a bare merge targets the ticket's repo and would land
  the wrong same-numbered PR while the attached one stays open. After REST-confirm, delete
  the remote head ref checkout-free: `gh api --method DELETE repos/<owner/repo>/git/refs/heads/<head_ref>`
  — but ONLY when the head branch lives in that repo (`.head.repo.full_name == <owner/repo>`);
  a fork PR's head ref lives in the fork, so deleting it from the base repo could hit an
  unrelated same-named branch (CTL-56). URL-encode `<head_ref>` (preserve `/`) first.
  Idempotent + best-effort.

> **NEVER `--admin` / force-merge past a failing or pending check.** You may merge
> a PR ONLY when its required checks are genuinely GREEN. A failing CI check is a
> problem to FIX (`gh run view --log-failed`, fix, push, re-run), NOT to bypass.
> If CI keeps failing and you genuinely cannot get it green after trying, that is a
> Step-3 escalation — hand it to the operator with what's failing and why; it is
> NOT a force-merge. Bringing the branch to green is the job; overriding the gate
> never is.

- **A stalled phase that died mid-flight** → re-dispatch it
  (`phase-agent-dispatch --phase <phase> --ticket <T> --orch-dir <ORCH_DIR> --worktree ~/catalyst/wt/<project>/<T>`),
  or re-arm its signal (failed→pending) and wake the scheduler.
- **bun install / cannot find package** → `bun install` in the affected package, retry.
- **TypeScript / lint error** → fix it (`/catalyst-dev:validate-type-safety`
  scoped to the diff), retry the phase.

After each action, PRINT the action + its success signal (the `exit 0`, the
`mergeable: "MERGEABLE"`, the merged SHA, the re-dispatch event id) as the
per-item resolution line.

**UNSTUCK comment (enforce-only, once per item).** After a successful FIX:

```bash
_rp_comment "$TICKET" "✅ **recovery-pass** unstuck this — <what I did, plain language> → <moved to phase X / merged #Y / re-dispatched>."
```
