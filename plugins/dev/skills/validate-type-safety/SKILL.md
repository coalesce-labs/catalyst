---
name: validate-type-safety
description: "Run the full 5-step TypeScript validation gate: type check, reward hacking scan, test inclusion, tests, and lint. This skill provides a structured multi-step pipeline that you cannot replicate on your own — it detects the project's package manager and linter automatically, checks tsconfig strictness, and invokes /scan-reward-hacking internally. **ALWAYS consult this skill when** the user mentions 'validate types', 'check type safety', 'type validation', 'type safety gate', wants to verify TypeScript changes before a PR, after completing a plan phase, or says anything about running type checks + tests + lint together. Even if you think you can run tsc yourself, use this skill — it catches issues you'd miss (tsconfig strictness, test exclusions, reward hacking patterns)."
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
version: 1.0.0
---

# Validate Type Safety

Final verification gate before marking any TypeScript work complete. Combines type checking with
reward hacking detection, test verification, and linting. ALL 5 steps must pass.

## Tooling Detection

Before running any commands, detect the project's package manager and linting tool. Do NOT
hardcode `bun`, `npm`, or `trunk` — detect from what's available.

### Package Manager

Check for lockfiles in the project root:

| Lockfile | Package Manager | Run Command |
|----------|----------------|-------------|
| `bun.lockb` or `bun.lock` | bun | `bun run` |
| `pnpm-lock.yaml` | pnpm | `pnpm run` |
| `yarn.lock` | yarn | `yarn run` |
| `package-lock.json` | npm | `npm run` |

If multiple exist, prefer in the order listed above. Store as `$PM_RUN` (e.g., `bun run`).

### Linter

Check for linting tools in this order:

| Check | Linter | Command |
|-------|--------|---------|
| `.trunk/` directory exists | Trunk | `trunk check --ci --upstream origin/main` |
| `biome.json` or `biome.jsonc` exists | Biome | `${PM_RUN} biome check .` |
| `eslint.config.*` or `.eslintrc.*` exists | ESLint | `${PM_RUN} eslint .` |

If none found, skip Step 5 and note it in the output.

### Type Check Command

Look for a `type-check` or `typecheck` script in `package.json`:
- If found: `${PM_RUN} type-check` (or `typecheck`)
- If not found: `npx tsc --noEmit` (fallback)

For monorepos, check if the root `package.json` has a workspace-level type-check script first.

## Validation Steps

### Step 0: tsconfig Strictness Check (Informational)

Read the project's `tsconfig.json` (or the tsconfig covering changed files in a monorepo). Verify:

- `"strict": true` is set — **WARN** if missing
- `"noUncheckedIndexedAccess": true` — **INFO** if missing (recommended)
- `"noImplicitReturns": true` — **INFO** if missing (recommended)
- `"exactOptionalPropertyTypes": true` — **INFO** if missing (recommended)

For monorepos: use the Glob tool to find `tsconfig.json` files, then identify which one covers the
changed files (check `include`/`exclude` paths and `references`).

This step is **informational only** — it does not cause a FAIL verdict, but findings are reported.

### Step 1: Run TypeScript Type Check

```bash
${PM_RUN} type-check  # or detected equivalent
```

**Expected**: Zero errors, exit code 0.

If errors exist, they MUST be fixed. Do not proceed to Step 2 until type-check passes.

### Step 2: Run Reward Hacking Scan

Execute the `/scan-reward-hacking` skill on the changed files.

**Expected**: PASS verdict with no unfixed CRITICAL or HIGH severity patterns.

### Step 3: Verify Test Inclusion

Check that test files are NOT excluded from type checking. Use Grep to search tsconfig files
(in changed packages for monorepos):

- Pattern: `\.test\.ts` or `\.spec\.ts` in `exclude` arrays of tsconfig files
- Pattern: test directories in `exclude` arrays

**Expected**: No tsconfig files exclude test files from type checking.

### Step 4: Run Tests

```bash
${PM_RUN} test
```

For monorepos with many packages, if the project has a `--filter` or `--scope` option, run tests
only for affected packages when possible.

**Expected**: All tests pass. Type fixes should not break functionality.

### Step 5: Lint Check

```bash
# Use detected linter command from Tooling Detection
trunk check --ci --upstream origin/main  # or biome/eslint equivalent
```

**Expected**: Zero lint errors.

If no linter was detected, skip this step and note it in the output.

### Optional: Type Coverage Metric

If `type-coverage` is available (check with `which type-coverage` or `npx type-coverage --help`),
report the numeric coverage score:

```bash
npx type-coverage --at-least 0
```

This is informational only — does not affect the verdict.

## Output Format

Present results in this format:

```markdown
## Type Safety Validation Results

### Tooling Detected
- Package manager: {bun|pnpm|yarn|npm}
- Linter: {trunk|biome|eslint|none}
- Type check command: {detected command}

### Step 0: tsconfig Strictness (Informational)
- strict: true — {YES / MISSING}
- noUncheckedIndexedAccess — {YES / missing (recommended)}
- noImplicitReturns — {YES / missing (recommended)}
- exactOptionalPropertyTypes — {YES / missing (recommended)}

### Step 1: TypeScript Type Check
- Status: PASS / FAIL
- Errors: {count} (list if any)

### Step 2: Reward Hacking Scan
- Status: PASS / FAIL
- Critical: {count}
- High: {count}
- (Details if any issues found)

### Step 3: Test File Inclusion
- Status: PASS / FAIL
- tsconfig files excluding tests: {count} (list if any)

### Step 4: Tests
- Status: PASS / FAIL
- Failed tests: {count} (list if any)

### Step 5: Lint Check
- Status: PASS / FAIL / SKIPPED (no linter detected)
- Errors: {count} (list if any)

### Type Coverage (if available)
- Coverage: {X}% ({Y}/{Z} types)

---

## Overall Verdict: PASS / FAIL

{If FAIL, list all items that must be fixed}
```

## Verdict Criteria

**PASS** requires ALL of the following:
- [ ] Type check exits with code 0
- [ ] No CRITICAL or HIGH severity reward hacking patterns
- [ ] No tsconfig files exclude test files (in changed packages)
- [ ] All tests pass
- [ ] Lint check passes (or no linter detected)

**FAIL** if ANY check fails.

## If Validation Fails

Do NOT mark the work as complete. Instead:

1. **Fix all issues** identified in the validation
2. **Re-run validation** after fixes
3. **Only mark complete** when validation passes

## Fast-Fail Mode

For efficiency, stop on the first failing step. Report which step failed and what needs fixing.
Re-run the full validation after fixes are applied.

## Integration with Other Skills

- Called by `/implement-plan` as part of quality gates
- Called by `/oneshot` Phase 4 (Validate + Quality Gates)
- Invokes `/scan-reward-hacking` internally for Step 2
