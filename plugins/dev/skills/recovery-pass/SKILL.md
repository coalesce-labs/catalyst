---
name: recovery-pass
description: |
  Goal-driven senior-engineer pipeline-unstick sweep (CTL-1176 rung 3). Given the
  stuck/failed/needs-human set (or ONE ticket handed by the recovery router), its
  GOAL is to get the pipeline MOVING again — not to fix one ticket's review
  findings (that is phase-remediate). It runs AFTER the eyes (diagnostician
  evidence) and the hands (deterministic unstuck-sweep seams) have already tried,
  and it CONSUMES their output from a recovery-pass.json brief rather than
  re-diagnosing or redoing their narrow work. It acts like a senior engineer with
  full tool access — it resolves merge conflicts, rebases, force-pushes, merges
  green PRs, and re-dispatches stalled phases AUTONOMOUSLY — and escalates to the operator
  ONLY for a genuine value judgment / something that degrades other functionality
  / a real cost-benefit trade-off / a serious architecture change / an ADR
  conflict. On escalation it AUTHORS the operator inbox row + the push
  notification (executive-voiced). Dispatched as a `claude --bg` job by
  phase-agent-dispatch via slash command, AND invocable bare by the operator as a sweep —
  hence `user-invocable: true`. Ships behind CATALYST_RECOVERY_PASS (off by
  default — no live behavior change until shadow/enforce).
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task  # spawns thoughts-locator / thoughts-analyzer subagents for Rubric One (plan-deliverable read)
---

# recovery-pass

The agentic top rung of the self-healing recovery ladder (ADR-025 / CTL-1176).
Below it: the diagnostician (eyes, no action) + unstuck-sweep.mjs (hands,
mechanical). **recovery-pass acts when the mechanical passes were insufficient.**

> **This is NOT phase-remediate.** phase-remediate fixes ONE ticket whose
> `verify` verdict failed, editing source files in place. recovery-pass keeps the
> WHOLE pipeline moving — its scope is the stuck/failed/needs-human set, its input
> is the diagnostician + unstuck output, and its actions are git/gh/dispatch, not
> just Edit/Write. Do not narrow yourself to one ticket's review findings.

> **Consistency with the code (CTL-1157 — THE REVERSAL).** Rubric One's autonomous
> Done write goes through `linear-reconcile-cli.mjs declare` which **now just WRITES
> the Done declaration — there is NO refuse-gate.** `open-pr-gate.mjs` is an
> open-PR **ENUMERATOR** (facts source), not a gate. Done-safety is YOUR judgment.

## Load on demand

| Situation | Reference |
|---|---|
| Context on what you are walking into, two invocation modes, holistic board scan (Step -1) | [orientation.md](references/orientation.md) |
| Bash prelude (resolve runtime, mode, comment shim, phase-agent envelope) | [prelude.md](references/prelude.md) |
| /goal condition (self-evaluated) + sweep SOP (diagnose Catalyst yourself without a brief) | [goal-sweep.md](references/goal-sweep.md) |
| 3-tier rope + Rubric Two (stuck PR: finish vs escalate) + Rubric Three (when human needed) | [three-tiers-rubrics.md](references/three-tiers-rubrics.md) |
| Rubric One — Done-judgment over a PR-state ticket (Steps PR-1 to PR-7) | [rubric-one.md](references/rubric-one.md) |
| PR-not-merged sub-playbook (CI branch, review branch, merge, escalate) | [pr-not-merged.md](references/pr-not-merged.md) |
| Filing findings (compounding loop) + Steps 0–2 (seams → bounded engineering) | [fix-loop-early.md](references/fix-loop-early.md) |
| Steps 2.5–3 (leave-alone + escalation checklist) + iterate + inbox + router guardrails | [fix-loop-late.md](references/fix-loop-late.md) |
| Step 4 (authoring escalation payload) + end block + failure handling | [escalation.md](references/escalation.md) |
