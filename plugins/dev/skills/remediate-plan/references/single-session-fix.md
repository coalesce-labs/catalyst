# Single-session fix — reading validate-plan's actual output

## Why there is no verify.json here

`phase-remediate` (daemon-era) reads `${ORCH_DIR}/workers/<ticket>/verify.json`,
a structured file written by `phase-verify` (`allowed-tools` include Write).
`validate-plan` is a different skill with a different contract: its
`allowed-tools` are `Read, Grep, Glob, Bash, Task` (`plugins/dev/skills/validate-plan/SKILL.md:5`)
— no Write, no Edit. It cannot persist a report to disk even if it wanted to.
Its "Step 3: Generate Validation Report" (`validate-plan/SKILL.md:116-201`) ends
in a markdown block the skill renders as its response — that block, sitting in
the conversation, is the artifact. Any remediate step for validate-plan has to
consume that in-session text, not a file, which is why this skill has to run in
the same session: the report does not outlive the conversation that produced it.

## Anchors to read out of the report

validate-plan's report template (`validate-plan/SKILL.md:156-201`) has three
sections worth extracting mechanically:

- `### Automated Verification Results` — lines starting `✗` are gate failures
  (e.g. `✗ Linting issues: \`make lint\` (3 warnings)`). Each names the command
  that failed; re-run it after your fix.
- `### Code Review Findings` → `#### Deviations from Plan:` and
  `#### Potential Issues:` — free-text bullets, usually with a `file:line`
  pointer. Not every deviation is a defect (validate-plan itself calls some
  "(improvement)") — only fix what would keep the report off PASS.
- `### Manual Testing Required:` — usually out of scope for an automated fix
  pass, unless a checklist item is actually something you can script (e.g. "run
  the migration and confirm the new column exists").

## Worked example

A validate-plan run reports:

```
### Automated Verification Results
✓ Build passes: `bun run build`
✗ Tests fail: `bun run test` (2 failing in packages/schema)

### Code Review Findings
#### Potential Issues:
- Missing index on the new foreign key could impact performance
  (packages/schema/src/migrations/0031.sql:14)
```

`remediate-plan`'s pass:

1. Triage: the failing tests are must-fix (they keep the verdict off PASS); the
   missing index is a real finding with a named file:line, also must-fix.
2. Edit `packages/schema/src/migrations/0031.sql` to add the index; fix whatever
   the two failing tests in `packages/schema` actually assert.
3. Re-run the targeted gate: `bun run test --filter=schema` (not the full
   monorepo suite — that is the re-run validate-plan's job, step 6 of SKILL.md).
   Print its `exit 0`.
4. Commit: `fix(schema): CTL-NNNN remediate validate-plan findings (missing
   index, 2 failing tests)`.
5. Re-run `/catalyst-dev:validate-plan` against the same plan. A clean report
   (no more `✗`, the two bullets gone) is the only evidence the fix worked —
   this skill's own transcript claiming so is not.

## Relation to relay-ticket's phase list

`relay-ticket`'s phase list includes `(→ remediate)` after `validate`. Until a
`/relay-ticket` session's validate phase exists to invoke this automatically,
invoke it explicitly: `/catalyst-dev:remediate-plan`, in the same session as the
validate-plan run whose report you are fixing. There is no background dispatch
path — a relay worker cannot hand off this fix to a `claude --bg` job the way
`phase-agent-dispatch` handed work to `phase-remediate`, and it cannot self-
sustain a wait for one to finish, so the whole read → fix → re-verify cycle has
to complete in this one invocation.
