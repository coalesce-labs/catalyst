---
title: Post-Merge Verification (Anti-Reward-Hacking)
description: How the orchestrator verifies worker output independently of the worker's own claims, after the PR is merged.
sidebar:
  order: 2
---

Autonomous workers have an incentive to declare victory. If you let them self-report success, they'll cheerfully mark tasks "done" while types are widened to `any`, tests are marked `.skip`, and silent failures are caught by `catch(e){}`. The orchestrator defends against this with **adversarial verification** — a separate agent that re-reads the merged commit from scratch and challenges the worker's claims.

## When verification runs

Workers merge their own PRs via `gh pr merge --squash --delete-branch`. After the merge is observed, the orchestrator runs `orchestrate-verify.sh` on the merged commit as a surface-gaps step. Verification does **not** gate the merge — it runs post-merge and files a remediation ticket when it finds gaps.

```
Worker: "I wrote tests, types check, security review passed" → merges own PR
  │
  v
Orchestrator (post-merge): runs orchestrate-verify.sh on merged commit
  │
  ├─ verified → advance wave, mark ticket done
  └─ failed   → file remediation ticket; wave advancement blocked until ticket filed
                 (or unblocked if allowSelfReportedCompletion is true)
```

## What verification checks

The verifier runs the `orchestrate-verify.sh` script (in `plugins/dev/scripts/`) plus a dedicated LLM pass. The combined checks:

| Check | What it looks for |
|-------|-------------------|
| **Test existence** | `.test.ts` / `_test.go` / `test_*.py` files for new functions/endpoints |
| **Test execution** | Runs the project's test command; demands green |
| **Type safety** | Runs the typecheck command; fails on any new errors |
| **Reward-hacking patterns** | `as any`, `@ts-ignore`, `// eslint-disable`, `any` return types, `.skip` tests, empty catches |
| **Silent failure hunter** | Catch blocks that swallow without logging/rethrowing |
| **PR description vs reality** | Does the PR description match the diff? Any undocumented changes? |
| **Linear ticket AC vs diff** | Do the acceptance criteria from the ticket appear to be addressed? |

The LLM pass is done by a **different model** than the worker used (if the worker was Opus, verification uses Sonnet; and vice versa) so the two aren't making identical mistakes.

## Verification outcomes

Two possible outcomes per verification run:

### 1. Pass

The orchestrator records `verification-passed` in the event log. The wave advances normally and the ticket moves to Done.

### 2. Fail — remediation ticket filed

Verification found gaps in the merged commit (missing tests, reward-hacking patterns, or a discrepancy between the PR description and the diff). The orchestrator files a new remediation ticket with specific findings:

```
Verification found issues in CTL-48 (merged):
1. Added function `validateEmail` at src/auth.ts:42 has no unit tests
2. Used `as any` at src/api.ts:88 — should be a proper type guard
3. Test file src/auth.test.ts:112 is `.skip`'d without explanation
```

The remediation ticket enters the backlog and can be scheduled in a future wave. Whether the current wave **waits** for the remediation ticket to be filed before advancing is controlled by `allowSelfReportedCompletion`:

- `allowSelfReportedCompletion: false` (default) — wave blocks until the remediation ticket is filed
- `allowSelfReportedCompletion: true` — verification failures are advisory; wave advances immediately

Note: blocking wave advancement waits for the **ticket to be filed**, not for the issues to be resolved. The remediation work itself happens separately.

## Why worker-side checks aren't enough

Every worker already runs its own quality gates (typecheck, lint, test, build, security review, code review) during Phase 4. Verification is different because:

| Worker-side (Phase 4) | Verification (orchestrator) |
|-----------------------|-----------------------------|
| Same agent that wrote the code | Different agent with fresh context |
| Trusts its own claims | Adversarial — assumes nothing |
| Runs inside worker context budget | Runs inside orchestrator context — can read full diff + ticket + history |
| Can be fooled by its own rationalizations | Has no priors about what should be there |

Worker Phase 4 is necessary but not sufficient. The orchestrator's verification is the thing that catches "I wrote a test that calls `expect(true).toBe(true)` and shipped it."

## Event log integration

Each verification run emits events:

```
verification-started   detail: { ticket, round, verifier-model }
verification-passed    detail: { ticket, round }
verification-failed    detail: { ticket, round, findings: [...] }
```

These appear in the dashboard and the `/events` SSE stream, so you can watch verification run live on the same screen as phase progress.

## Configuration

Controlled via `catalyst.orchestration` in `.catalyst/config.json`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verifyBeforeMerge` | boolean | `true` | Run adversarial verification on merged commits (post-merge) |
| `allowSelfReportedCompletion` | boolean | `false` | When `true`, verification failures are advisory — wave advances without waiting for a remediation ticket to be filed |

To disable verification (not recommended):

```json
{
  "catalyst": {
    "orchestration": {
      "verifyBeforeMerge": false
    }
  }
}
```

To allow waves to advance even when verification finds gaps:

```json
{
  "catalyst": {
    "orchestration": {
      "allowSelfReportedCompletion": true
    }
  }
}
```

## Verification for manual Level 2 work

Running `/catalyst-dev:oneshot` standalone (no orchestrator)? You don't get verification — it's orchestrator-only. The standalone path runs Phase 4 gates and that's it. If you want adversarial verification without full orchestration, the workaround is to open the PR, then manually run the `code-reviewer` agent and `silent-failure-hunter` agent against it. Or just wrap the oneshot in a single-worker orchestrator — verification will run.
