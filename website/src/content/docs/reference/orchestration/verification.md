---
title: Verification and reward-hacking defense
description: How the orchestrator verifies worker output independently of the worker's own claims.
sidebar:
  order: 2
---

Autonomous workers have an incentive to declare victory. If you let them self-report success, they'll cheerfully mark tasks "done" while types are widened to `any`, tests are marked `.skip`, and silent failures are caught by `catch(e){}`. The orchestrator defends against this with **adversarial verification** — a separate agent that re-reads the PR from scratch and challenges the worker's claims.

## Where verification runs

Verification runs in the orchestrator, not the worker. It executes after the worker reports `pr-created` but before the orchestrator lets the PR merge (or before it transitions Linear to Done).

```
Worker: "I wrote tests, types check, security review passed, done"
  │
  v
Orchestrator verification agent: (re-reads PR diff, runs commands, challenges)
  │
  ├─ verified → proceed to merge
  └─ failed   → raise attention, re-dispatch with remediation, block merge
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

Three possible outcomes per verification run:

### 1. Pass

The orchestrator records `verification-passed` in the event log. The PR is eligible to merge when CI passes. The worker is archived and its worktree is eventually cleaned up.

### 2. Fail — auto-remediable

Worker produced inadequate tests or has reward-hacking patterns. The orchestrator re-dispatches the same worker with **specific remediation instructions**:

```
Verification found issues:
1. Added function `validateEmail` at src/auth.ts:42 has no unit tests
2. Used `as any` at src/api.ts:88 — should be a proper type guard
3. Test file src/auth.test.ts:112 is `.skip`'d without explanation

Fix these without changing the core feature. Push when done. Do not resolve review threads until fixed.
```

The worker runs, pushes a fix commit, the orchestrator re-verifies. Up to 3 rounds by default (configurable).

### 3. Fail — needs human

Verification found something the worker is unlikely to fix on its own:

- The PR solves a different problem than the ticket describes
- The approach contradicts a codebase convention the verifier can't articulate
- Tests pass but the feature is subtly wrong (wrong columns in a SQL query, off-by-one in pagination)

The orchestrator raises an attention item and waits. The verification event includes the full finding so the human can decide: re-dispatch with guidance, close the PR, escalate the ticket.

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

Verification is on by default. To disable (not recommended):

```json
{
  "catalyst": {
    "orchestrate": {
      "verification": {
        "enabled": false
      }
    }
  }
}
```

To tune the retry budget:

```json
{
  "catalyst": {
    "orchestrate": {
      "verification": {
        "maxRemediationRounds": 3,
        "verifierModel": "sonnet"
      }
    }
  }
}
```

## Verification for manual Level 2 work

Running `/catalyst-dev:oneshot` standalone (no orchestrator)? You don't get verification — it's orchestrator-only. The standalone path runs Phase 4 gates and that's it. If you want adversarial verification without full orchestration, the workaround is to open the PR, then manually run the `code-reviewer` agent and `silent-failure-hunter` agent against it. Or just wrap the oneshot in a single-worker orchestrator — verification will run.
