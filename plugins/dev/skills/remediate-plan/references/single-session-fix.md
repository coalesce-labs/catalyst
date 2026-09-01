# Single-session fix — reading validate-plan's actual output

## Why there is no verify.json here

`phase-remediate` (daemon-era) reads `${ORCH_DIR}/workers/<ticket>/verify.json`, a structured file written by `phase-verify` (`allowed-tools` include Write). `validate-plan` is a different skill with a different contract — read `plugins/dev/skills/validate-plan/SKILL.md` for its `allowed-tools` and its "Step 3: Generate Validation Report" section, which ends in a markdown block the skill renders as its own response rather than a file it writes. In a laptop session that block, sitting in the conversation, is the artifact — which is why the same-session mode reads it from context. The cloud runner is the exception that makes the fresh-session mode possible: when a cloud validate phase fails, the runner persists the session's `validation.md` to the R2 artifact store and a later remediate dispatch materializes it back to a real local file whose path the dispatch prompt names (CTC-1384). Either way, do not re-derive validate-plan's report schema here; read it from the owning skill so this file never goes stale against it.

## Worked example (same-session mode)

A validate-plan run reports a failing test suite in `packages/schema` and a missing index on a new foreign key, with a `file:line` pointer. `remediate-plan`'s pass:

1. Triage: the failing tests are must-fix (they keep the verdict off PASS); the missing index is a real finding with a named file:line, also must-fix.
2. Edit the migration file to add the index; fix whatever the failing tests actually assert.
3. Re-run the targeted gate for the touched workspace only (not the full monorepo suite — that is the re-run validate-plan's job, SKILL.md step 6). Print its `exit 0`.
4. Commit: `fix(schema): CTL-NNNN remediate validate-plan findings (missing index, failing tests)`.
5. Re-run `/catalyst-dev:validate-plan` against the same plan. A clean report — no more failing gates, the bullets gone — is the only evidence the fix worked; this skill's own transcript claiming so is not.

The fresh-session (cloud) mode runs the same pass; the only difference is step 0 — the report is read from the materialized prior-artifact file the dispatch prompt names instead of from the conversation.

## Relation to relay-ticket's phase list

`relay-ticket`'s phase list includes `(→ remediate)` after `validate`. In a laptop `/relay-ticket` session, invoke this skill explicitly — `/catalyst-dev:remediate-plan` — in the same session as the validate-plan run whose report you are fixing: a laptop relay worker has no persisted report to hand to a background job and cannot self-sustain a wait for one, so its read → fix → re-verify cycle completes in this one invocation. A cloud remediate session is the dispatched fresh-session mode instead: it starts with the persisted report already materialized on disk and runs the same cycle from that file.
