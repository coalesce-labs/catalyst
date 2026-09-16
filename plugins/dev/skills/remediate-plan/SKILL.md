---
name: remediate-plan
description: "Fixes what /catalyst-dev:validate-plan found, verifying each finding before touching code. Consumes validate-plan's Validation Report from either of two places — the report rendered into this conversation by a same-session validate-plan run (validate-plan has no Write tool and produces no verify.json), or a persisted report handed to a fresh session as a materialized prior-artifact file whose path the dispatch prompt names (the cloud runner's path — CTC-1384). Classifies every finding (valid, invalid, already-fixed, pre-existing/out-of-scope, needs-decision) against the shared resolving-review-findings reference, fixes only valid findings on steps the report FAILED with the smallest diff, answers invalid ones with evidence and no code change, and raises an ask instead of looping. Use right after validate-plan reports FAIL or PARTIAL, or when dispatched as a remediate session with a validation report on disk, especially inside a /relay-ticket session: relay-ticket's phase list names '(→ remediate)' but the only other remediation-shaped skill, phase-remediate, is bound to the daemon-era verify.json contract relay-ticket does not produce — this is the relay-native replacement (CTL-2243). Not for a fresh implementation pass, and never a chase of a report's PASS-step notes."
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Task
version: 1.2.0
---

# Remediate Plan

**Paths.** This skill reads a file inside its own directory as `${CLAUDE_SKILL_DIR}/…`. Claude Code fills that in. On any other harness, set CLAUDE_SKILL_DIR to the absolute directory that contains this SKILL.md before reading it. If you cannot, stop and report `skill_dir_unresolved`.

## What it consumes

Load the `validate-plan` skill (`/catalyst-dev:validate-plan`; in a skills-CLI install, its SKILL.md sits in the sibling `validate-plan` skill directory) for the schema this skill reads — its `allowed-tools`, and the exact headings its "Validation Report" renders into the conversation. That report is this skill's entire input; do not re-derive or copy its contract here, since `validate-plan` is the owning skill and the only source that stays current when its report shape changes. See `references/single-session-fix.md` for a worked example of turning that report into fixes.

## When to run it

Two modes, same report, same steps:

- **Same-session (laptop):** right after a `/catalyst-dev:validate-plan` run in this session reported FAIL or PARTIAL — its Validation Report is sitting in the conversation.
- **Fresh session (cloud dispatch):** the session was dispatched to remediate a validate failure and the persisted Validation Report is a real file on disk — primarily a materialized prior-artifact file (the runner fetches the failed validate phase's `validation.md` from the R2 artifact store and your dispatch prompt names its local path); failing that, a thoughts doc or Linear attachment the prompt points at.

If no Validation Report is in context and no report file is named in your prompt, run `/catalyst-dev:validate-plan` first, in this session, before invoking this skill.

## Steps

0. **Read `${CLAUDE_SKILL_DIR}/assets/references/resolving-review-findings.md`** and follow it for every finding. It owns the classification, verification, scope, reply and escalation rules; the steps below only apply them to a Validation Report.
1. **Read the Validation Report** — from the conversation if a same-session validate-plan run produced one, otherwise from the prior-artifact path (or fallback location) named in your prompt. Note which ladder steps it marked FAIL and which it marked PASS, and give each finding an id (`F1`, `F2`, …). If neither source exists, stop and run `/catalyst-dev:validate-plan` first.
2. **Classify every finding** as `valid`, `invalid`, `already-fixed`, `pre-existing/out-of-scope` or `needs-decision` (reference rules 2 and 3): read the cited code at HEAD, and reproduce a behaviour claim with a failing test or command before calling it `valid`. Then scope:
   - **Fix only `valid` findings on steps the report FAILED.** Those are what keep its verdict off PASS.
   - **Never chase a PASS step's notes.** That includes plan-only deviations, findings marked `materiality:"plan-only"`, and type-safety entries marked `preexisting`. They are not this round's work.
   - **Never revert a deviation the report accepted.**
   - **`invalid`:** record the evidence (file:line, test name or command output) and change no code.
   - **`already-fixed`:** cite the SHA. **`pre-existing/out-of-scope`:** name the follow-up it belongs in.
3. **Apply fixes** via Edit/Write with the smallest diff that closes each `valid` finding (reference rules 4–6): every hunk maps to a finding id, with one regression test per finding that fails before the fix, every instance inside this branch's diff fixed, and no refactors, renames or cleanup. This is a fix pass, not a redesign.
4. **Re-run a targeted gate** (this repo's `bun run check`, or the touched workspace's slice of it) and print the real `exit 0` to the transcript. Self-review the diff first (reference rule 11).
5. **Commit** the remediation as its own commit, e.g. `fix(<scope>): <TICKET> remediate validate-plan findings (F1)`. In a cloud round the dispatch prompt's commit rule wins: the runner commits.
6. **Local only: re-run `/catalyst-dev:validate-plan`** against the same plan to confirm the verdict actually moved — a claim that fixes landed is not evidence they worked. A cloud round never runs this step: re-validation is the pipeline's job, and it dispatches validate itself.

**No code change is a valid outcome** when every finding is non-`valid`. Locally, reply with the per-finding evidence. In a cloud round, follow the reference's "Cloud rounds" section: a validate-report finding has no manifest entry, so write `remediation.json` as `[]` and put the per-finding evidence in `adjudication.json`'s `reasoning` with `next_stage: "advance"`. Never leave the tree untouched without that evidence.

**Escalate instead of looping** (reference rule 12): when a finding recurs after a fix aimed at it, needs an architecture, contract or migration change, contradicts the plan or an ADR, or cannot be verified, raise an ask — `$CATALYST_ARTIFACT_DIR/decisions.json` in a cloud round, `catalyst-dev:ask` locally — and do not start another round.

## Phase-completion evidence

Report what you did in the shape a coordinator can check, per D1's phase-completion-evidence model (the `steward` skill's `references/dispatch.md`, "Phase-completion evidence"): the fix commit visible in `git log`, the gate's real exit code, the re-run validate-plan verdict (local only), and the classification table — not a summary of any of those:

| Finding | Report step (FAIL/PASS) | Class   | Action     | Evidence                                                        |
| ------- | ----------------------- | ------- | ---------- | --------------------------------------------------------------- |
| F1      | code-review (FAIL)      | valid   | fixed      | `abc1234` src/x.ts:42; `x.test.ts` "rejects empty id" red→green |
| F2      | code-review (FAIL)      | invalid | none       | src/y.ts:17 already guards null; `bun test y.test.ts` passes    |
| F3      | plan-conformance (PASS) | —       | not chased | plan-only note on a PASS step                                   |

## Not this skill

`phase-remediate` (daemon-era: reads `${ORCH_DIR}/workers/<ticket>/verify.json`, dispatched by `phase-agent-dispatch`) is a different contract for a retired pipeline. Do not mix the two, and do not wait on anything `phase-remediate` would have waited on.
