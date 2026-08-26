# Pre-merge adversarial review — the 8-gate table

Relocated from the retired `phase-verify` daemon phase-agent (CTL-2223), with the
`${ORCH_DIR}/workers/<TICKET>/verify.json` / `phase.verify.complete` daemon plumbing stripped. Use
this checklist when a PR needs a deeper adversarial pass than this skill's own Step 3 (local
tests) before you merge it — e.g. a large or risky diff, or one a reviewer flagged as needing a
second look.

**Constraint carried over from the source skill: this is read-only.** The only files it is ever
correct to create or edit while running these gates are test files (`**/__tests__/`, `*.test.*`,
`*.spec.*`, `test/**`, `tests/**`). A finding that needs an application-code fix gets recorded and
handed to whoever owns that fix — never patched in place from inside a "verify" pass.

## The 8 gates

Run every gate; do not stop at the first failure — the pass is exhaustive, not short-circuiting.

| Gate | Tool | Skill / agent |
|---|---|---|
| Type check | `tsc --noEmit` (or project's `typecheckCommand`) | `catalyst-dev:validate-type-safety` |
| Reward-hacking scan | grep-based pattern check | `catalyst-dev:scan-reward-hacking` |
| Unit tests | project test command | `catalyst-dev:validate-type-safety` |
| Lint | project lint command | `catalyst-dev:validate-type-safety` |
| Security review | dependency + secret scan | `/security-review` (built-in) |
| Code review | style/guideline adherence | `pr-review-toolkit:code-reviewer` agent |
| Test coverage | per-file coverage on diff | `pr-review-toolkit:pr-test-analyzer` agent |
| Silent failures | unchecked try/catch + fallback hunting | `pr-review-toolkit:silent-failure-hunter` agent |

Run the CLI gates via `Bash`, the agent gates via `Task`. Capture exit code + a one-line summary per
gate.

## Scoring `regression_risk` (0–10)

A rough aggregate signal for how much this diff needs a human's eyes before it merges — not a hard
gate, but a way to decide whether to loop back for remediation first:

| Signal | Risk delta |
|---|---|
| Any required CLI gate failed (tsc/test/lint/security) | +3 each |
| Reward-hacking scan flagged a HIGH-severity pattern | +3 |
| Code reviewer flagged a structural issue | +2 |
| Test-analyzer reports < 50% diff coverage | +2 |
| Silent-failure hunter flagged an unchecked catch / fallback | +2 |
| Any agent surfaced a must-fix finding | +3 |

Clamp to `[0, 10]`. A score ≥ 5 means fix the findings before merging, not after.

## Findings shape

Record each finding with enough detail that someone acting on it later doesn't have to re-derive it:

```json
{
  "severity": "high|medium|low",
  "kind": "type|test|lint|security|review|coverage|silent-failure|reward-hacking",
  "file": "path/to/file.ts",
  "line": 42,
  "message": "Short human-readable description",
  "recommendation": "What should happen about it"
}
```
