# 2026-08-19: Round-based PR review convergence policy, refined and consolidated

> **Superseded as the canonical reference**: `docs/DECISIONS/2026-08-07-pr-review-convergence-policy.md`
> is now the canonical policy doc, using the filename shared with the other 6 HagaleTechnologies
> repos that adopted this policy, for fleet-wide grep consistency. This document and that one
> converged on the same four-tier schedule independently (this one from live incidents below, the
> other from the fleet-wide rollout) on the same day. This document is retained for the
> incident-specific history (VAN-292/326/351) that motivated the update — `review-comments/SKILL.md`
> and `phase-review/SKILL.md` now point at the canonical doc for the schedule itself.

## Context

The fleet's PR/CR review-convergence policy — how an iterative bot or human reviewer's findings
get triaged across many rounds so a PR actually converges instead of chasing progressively finer
findings forever — had drifted out of sync with how it was actually being applied live:

- `review-comments`/`SKILL.md` still encoded an older, simpler 2-tier schedule (round 1: P0/P1
  mandatory-fix, P2/P3 a judgment call; round 2+: P0/P1 mandatory-fix, P2/P3 always deferred, no
  further tiers, no hard stop).
- In practice, three separate live incidents had already refined this well past that 2-tier shape:
  - **VAN-292 / PR #96** (2026-08-17/18, 13 rounds): the working rule in practice was "fix any P1s
    directly blocking the ticket's point; otherwise ticket non-critical P1s or P2s" — applied from
    round 1, not gated by a round-number threshold.
  - **VAN-326 / PR #117** (2026-08-18, 8 rounds, 13 findings): surfaced two check-in triggers that
    the pure round-count schedule doesn't capture — (a) the same code region producing a genuinely
    NEW bug shape on 3+ consecutive rounds despite each individual fix being locally correct
    (signaling the abstraction itself is wrong, not "almost done patching"), and (b) a "finding"
    that's actually a scope-expansion request in disguise, not a real defect (checked against the
    ticket's own plan/research doc, not "could this theoretically be more correct").
  - **VAN-351 / PR #124** (2026-08-19, 10 rounds): validated a concrete 1-5/6-15/16-25/25 round
    schedule live, run alongside a local `codex exec review` pass before each push so the real
    remote round usually came back clean.

None of that refinement had been written back into the shipped skill files — it existed only as
ad hoc session guidance, re-derived informally each time a new review loop ran long.

## Decision

Consolidated the current schedule into `review-comments/SKILL.md`'s Step 1.5 (the canonical
source — this is the skill that actually walks an iterative round loop) and updated
`phase-review/SKILL.md`'s one-shot severity handling to point at it instead of a stale,
never-existed-in-this-repo `docs/DECISIONS/2026-08-07-pr-review-convergence-policy.md` path
reference:

- **Rounds 1-5**: fix everything reasonable (P0/P1 and P2/P3 alike). No ticket filing yet.
- **Rounds 6-15**: P0/P1 stays mandatory-fix. New/reopened P2/P3 findings go to a single
  consolidated per-PR follow-up ticket instead of being fixed inline.
- **Rounds 16-25**: ticket P0/P1 too by default, unless the finding is critical (security,
  data-loss/corruption, broken build/tests) or blocks the PR's own stated purpose outright — those
  still get fixed inline regardless of round.
- **Round 25**: hard stop — escalate to a human rather than opening a 26th round unilaterally.
- Severity is judged by substance (what the finding actually is), not the reviewer's own label.
- Two check-in triggers (fix-strategy-must-change; finding-is-really-scope-expansion) override the
  round math at any point — they are structural red flags, not a schedule to wait out.
- Run the equivalent review locally (e.g. `codex exec review --base main`) before pushing each
  round, so the round counter's remote checks measure genuinely new signal.

`phase-review` itself isn't part of this iterative loop (it runs once per PR, before the PR even
exists), so it keeps its existing simpler rule — HIGH-severity fixed unconditionally, MEDIUM/LOW
always ticketed — and now just points at `review-comments` for the schedule that governs what
happens on every subsequent round once the PR is open.

## Outcome

`review-comments`/`SKILL.md` and `phase-review`/`SKILL.md` are the durable, teammate-visible,
version-controlled source of truth for this policy going forward, superseding informal
per-session re-derivation. See those two files for the mechanics; this document exists to capture
why the schedule looks the way it does and the incidents that shaped it.
