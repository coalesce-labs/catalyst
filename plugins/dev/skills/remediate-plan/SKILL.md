---
name: remediate-plan
description:
  "Fixes what /catalyst-dev:validate-plan just found, in the same session. Consumes
  validate-plan's actual output — the Validation Report it renders into the
  conversation (validate-plan has no Write tool and produces no verify.json) —
  and applies the fixes directly via Edit/Write, re-runs a scoped gate, and
  commits. Use right after validate-plan reports FAIL or PARTIAL, especially
  inside a /relay-ticket session: relay-ticket's phase list names '(→ remediate)'
  but the only other remediation-shaped skill, phase-remediate, is bound to the
  daemon-era verify.json contract relay-ticket does not produce — this is the
  relay-native replacement (CTL-2243). Not for a fresh implementation pass; scope
  stays to what the Validation Report named."
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Task
version: 1.0.0
---

# Remediate Plan

## What it consumes

`validate-plan`'s `allowed-tools` are Read, Grep, Glob, Bash, Task — no Write. Its
"Validation Report" is therefore never a file: it is the markdown block
validate-plan renders straight into the conversation ("Validation Report: [Plan
Name]", with Automated Verification Results / Code Review Findings / Manual
Testing Required sections). That report, still present in the current context,
is this skill's entire input. See `references/single-session-fix.md` for the
exact anchors and a worked example.

## When to run it

Only in the same session as the validate-plan run that produced the report you
are fixing. There is no persisted, verify.json-equivalent artifact to hand to a
fresh session, and a relay worker cannot self-sustain a wait for one or hand off
to a background job. If no Validation Report is in context yet, run
`/catalyst-dev:validate-plan` first, in this session, before invoking this skill.

## Steps

1. **Read the Validation Report** already in context. Pull every `✗` Automated
   Verification line, every Deviations-from-Plan and Potential-Issues bullet, and
   any unchecked Manual Testing item that is actually automatable.
2. **Triage**: fix now vs. defer. Anything that would keep the report's own
   verdict off PASS is must-fix; a bullet noted as an "improvement" deviation is
   not.
3. **Apply fixes** via Edit/Write, scoped to the files the report named — this is
   a fix pass, not a redesign.
4. **Re-run a targeted gate** (this repo's `bun run check`, or the touched
   workspace's slice of it) and print the real `exit 0` to the transcript.
5. **Commit** the remediation as its own commit, e.g. `fix(<scope>): <TICKET>
   remediate validate-plan findings`.
6. **Re-run `/catalyst-dev:validate-plan`** against the same plan to confirm the
   verdict actually moved — a claim that fixes landed is not evidence they
   worked.

## Phase-completion evidence

Report what you did in the shape a coordinator can check, per D1's
phase-completion-evidence model (`steward/references/dispatch.md`,
"Phase-completion evidence"): the fix commit visible in `git log`, the gate's
real exit code, and the re-run validate-plan verdict — not a summary of any of
those.

## Not this skill

`phase-remediate` (daemon-era: reads `${ORCH_DIR}/workers/<ticket>/verify.json`,
dispatched by `phase-agent-dispatch`) is a different contract for a retired
pipeline. Do not mix the two, and do not wait on anything `phase-remediate`
would have waited on.
