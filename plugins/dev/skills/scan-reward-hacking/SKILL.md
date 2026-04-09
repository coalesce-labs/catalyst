---
name: scan-reward-hacking
description: "Scan TypeScript code for reward hacking patterns — shortcuts that make linters pass without actually fixing type safety. This skill has a comprehensive checklist of 8 forbidden patterns with severity tuning (libraries vs apps) that you cannot reliably check on your own. **ALWAYS consult this skill when** the user says 'scan for hacks', 'check for type cheats', 'reward hacking', 'verify no shortcuts', wants to check for `as any`, `as unknown as`, `@ts-ignore`, non-null assertions (`value!`), `forEach(async`, or void tricks after fixing TypeScript errors. Also use after /fix-typescript completes, or when verifying TypeScript changes before marking work done. Accepts optional file/directory arguments to scope the scan."
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[files-or-directories]"
version: 1.1.0
---

# Scan for Reward Hacking Patterns

You are scanning for "reward hacking" patterns — code that makes linters pass without actually
fixing type safety issues. This is a verification step that MUST be run before marking TypeScript
work complete.

## What to Scan

**If `$ARGUMENTS` specifies files or directories**, scan those paths only.

**Otherwise**, detect scan paths automatically:
1. Use Glob to find which of these directories exist: `src/`, `apps/`, `packages/`, `lib/`
2. Scan all that exist

## Severity Tuning

Severity levels adjust based on project context:

| Pattern | Libraries/Packages (`packages/`) | Applications (`apps/`, `src/`) |
|---------|----------------------------------|-------------------------------|
| `as any` | **CRITICAL** | HIGH |
| `as unknown as` | **HIGH** | HIGH |
| `@ts-ignore` | **CRITICAL** | HIGH |
| Non-null assertion (`!`) | **HIGH** | MEDIUM |

Libraries/packages are stricter because they export types consumed by other code. Determine context
from the file path — files under `packages/` use library severity, everything else uses app severity.

## Forbidden Patterns to Detect

Use the **Grep tool** (not bash grep) to search for each pattern. Use glob `*.{ts,tsx}` to filter
to TypeScript files only. Run all searches and report ALL matches:

### 1. Undocumented Double-Casts (HIGH)

Pattern: `as unknown as`

### 2. Direct Any Casts (HIGH / CRITICAL in libraries)

Pattern: `as any`

### 3. Void Tricks (CRITICAL)

Patterns: `void (0` and `void _`

### 4. Underscore-Prefixed Local Variables (MEDIUM)

Patterns: `const _[a-zA-Z]` and `let _[a-zA-Z]`

Evaluate context: function parameters are acceptable, local variables are not.

### 5. TypeScript Directive Comments (HIGH / CRITICAL in libraries)

Patterns: `@ts-ignore` and `@ts-expect-error`

### 6. Non-Null Assertions Without Runtime Guard (HIGH / MEDIUM in apps)

Pattern: `\w+!\.` and `\w+!\[` and `\w+!;`

These match `value!.property`, `value![index]`, and `value!;` patterns.

**ACCEPTABLE** (has a preceding runtime guard):
```typescript
if (user != null) {
  return user!.name; // Guard exists above
}
```

**NOT ACCEPTABLE** (no runtime check):
```typescript
const name = user!.name; // Could be null at runtime
```

When evaluating matches, read surrounding lines (use Grep with `-B 3` context) to check for
a preceding null/undefined guard (`!= null`, `!== null`, `!== undefined`, `!= undefined`,
truthiness check, or `if` guard).

### 7. Async Correctness Issues (HIGH)

**7a. `forEach` with async callback:**

Pattern: `\.forEach\(async`

This silently drops promise results. Always use `for...of` or `Promise.all(array.map(...))`.

**NEVER ACCEPTABLE**:
```typescript
items.forEach(async (item) => {  // Promises silently dropped
  await processItem(item);
});
```

**7b. Unhandled async function calls:**

Pattern: lines that call an async function without `await`, `return`, `void`, or `.then()`.

This is harder to detect via pattern matching alone. Flag `forEach(async` reliably; for other
cases, note them as informational if spotted during the scan.

### 8. Exported Unused Types (LOW — informational)

Patterns: `^export type [A-Z]` and `^export interface [A-Z]`

These are informational only and do not affect the verdict.

## How to Evaluate Matches

### `as unknown as` — Check for Documentation

**ACCEPTABLE** (has required documentation):
```typescript
// LIBRARY TYPE LIMITATION: The thirdPartyWrapper() function returns a type
// that TypeScript can't verify implements the expected interface.
// Verified at runtime that the object has the required methods.
// TODO: Remove when library updates types (tracked in TICKET-XXX)
const wrapped = thirdPartyResult as unknown as ExpectedInterface;
```

**NOT ACCEPTABLE** (no documentation):
```typescript
const campaigns = result as unknown as Campaign[];
```

### `as any` — Almost Always Wrong

**ACCEPTABLE** (rare — only in test mocks):
```typescript
// In test file only
const mockDb = { query: vi.fn() } as any as Database;
```

**NOT ACCEPTABLE** (production code):
```typescript
const data = response.data as any;
```

### `void` Patterns — Always Wrong

**NEVER ACCEPTABLE**:
```typescript
void (0 as unknown as _Type); // Lint suppression trick
void _schemaCheck; // Unused variable suppression
```

### Underscore Variables — Context Matters

**ACCEPTABLE** (function parameters):
```typescript
function handleEvent(_event: Event, data: Data) {
  return process(data);
}
```

**NOT ACCEPTABLE** (local variables):
```typescript
const _user = useUser(); // Keep for future use  <- DELETE THIS
```

### `@ts-ignore` / `@ts-expect-error`

**ACCEPTABLE** (rare — with documented reason and tracking ticket):
```typescript
// @ts-expect-error — library types are wrong, fixed in next release (PROJ-456)
const result = brokenLib.doThing();
```

**NOT ACCEPTABLE** (no explanation):
```typescript
// @ts-ignore
const data = thing.stuff;
```

### Non-Null Assertions

**ACCEPTABLE** (runtime guard exists):
```typescript
if (map.has(key)) {
  return map.get(key)!; // Safe — has() guarantees existence
}
```

**NOT ACCEPTABLE** (no guard):
```typescript
return this.user!.email; // Could crash at runtime
```

## Output Format

Present findings in this format:

```markdown
## Reward Hacking Scan Results

**Scan scope**: {paths scanned}
**Severity mode**: {library | app | mixed}

### CRITICAL (Must Fix Immediately)
- `file.ts:123` - `void (0 as unknown as Type)` - Lint suppression trick
- `packages/core/src/index.ts:45` - `as any` in library code

### HIGH SEVERITY (Must Fix Before Merge)
- `file.ts:456` - `as unknown as Campaign[]` - Missing documentation
- `file.ts:789` - `as any` in production code
- `file.ts:55` - `user!.name` - No runtime guard
- `file.ts:100` - `.forEach(async` - Silently drops promises

### MEDIUM SEVERITY (Should Fix)
- `file.ts:101` - `const _user = ...` - Unused local variable
- `apps/web/src/page.ts:30` - `item!.id` - No runtime guard (app code)

### ACCEPTABLE (No Action Needed)
- `file.test.ts:50` - `as any` in test mock
- `file.ts:200` - `as unknown as` with full documentation
- `file.ts:300` - `map.get(key)!` after `map.has(key)` guard

### Summary
- Critical: X issues
- High: Y issues
- Medium: Z issues
- Total requiring action: X + Y + Z
```

## Verdict

**PASS**: No forbidden patterns found, or all patterns are properly documented/in tests.

**FAIL**: Forbidden patterns found that require fixes before work can be considered complete.

## If FAIL

List the specific fixes needed:

```markdown
## Required Fixes

1. `apps/api/src/services/UserService.ts:243`
   - Current: `as unknown as CreateUserRequest`
   - Fix: Fix the query return type or add Zod validation at the boundary

2. `apps/web/src/pages/Dashboard.tsx:117`
   - Current: `const _user = useUser();`
   - Fix: Delete the line entirely

3. `apps/web/src/pages/Dashboard.tsx:55`
   - Current: `items.forEach(async (item) => { ... })`
   - Fix: Use `for (const item of items) { await ... }` or `await Promise.all(items.map(...))`

4. `packages/core/src/client.ts:89`
   - Current: `this.config!.apiKey`
   - Fix: Add null check or use optional chaining (`this.config?.apiKey`)
```

The agent must address ALL issues before marking their work complete.
