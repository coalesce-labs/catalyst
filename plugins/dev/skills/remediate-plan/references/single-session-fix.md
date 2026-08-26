# Single-session fix — reading validate-plan's actual output

## Why there is no verify.json here

`phase-remediate` (daemon-era) reads `${ORCH_DIR}/workers/<ticket>/verify.json`, a structured file written by `phase-verify` (`allowed-tools` include Write). `validate-plan` is a different skill with a different contract — read `plugins/dev/skills/validate-plan/SKILL.md` for its `allowed-tools` and its "Step 3: Generate Validation Report" section, which ends in a markdown block the skill renders as its own response rather than a file it writes. That block, sitting in the conversation, is the artifact. Any remediate step for validate-plan has to consume that in-session text, not a file — which is why this skill has to run in the same session: the report does not outlive the conversation that produced it. Do not re-derive validate-plan's report schema here; read it from the owning skill so this file never goes stale against it.

## Worked example

A validate-plan run reports a failing test suite in `packages/schema` and a missing index on a new foreign key, with a `file:line` pointer. `remediate-plan`'s pass:

1. Triage: the failing tests are must-fix (they keep the verdict off PASS); the missing index is a real finding with a named file:line, also must-fix.
2. Edit the migration file to add the index; fix whatever the failing tests actually assert.
3. Re-run the targeted gate for the touched workspace only (not the full monorepo suite — that is the re-run validate-plan's job, SKILL.md step 6). Print its `exit 0`.
4. Commit: `fix(schema): CTL-NNNN remediate validate-plan findings (missing index, failing tests)`.
5. Re-run `/catalyst-dev:validate-plan` against the same plan. A clean report — no more failing gates, the bullets gone — is the only evidence the fix worked; this skill's own transcript claiming so is not.

## Relation to relay-ticket's phase list

`relay-ticket`'s phase list includes `(→ remediate)` after `validate`. Until a `/relay-ticket` session's validate phase exists to invoke this automatically, invoke it explicitly: `/catalyst-dev:remediate-plan`, in the same session as the validate-plan run whose report you are fixing. There is no background dispatch path — a relay worker cannot hand off this fix to a `claude --bg` job the way `phase-agent-dispatch` handed work to `phase-remediate`, and it cannot self-sustain a wait for one to finish, so the whole read → fix → re-verify cycle has to complete in this one invocation.
