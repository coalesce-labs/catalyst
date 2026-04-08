---
name: scan-reward-hacking
description: "Scan for reward hacking patterns in recent changes. **ALWAYS use when** verifying TypeScript fixes before marking work complete, after /fix-typescript, or when the user says 'scan for hacks', 'check for type cheats', 'verify no reward hacking'. Detects forbidden patterns like `as any`, `as unknown as`, `@ts-ignore`."
disable-model-invocation: true
allowed-tools: Bash, Read, Grep
version: 1.0.0
---

# Scan for Reward Hacking Patterns

You are scanning for "reward hacking" patterns - code that makes linters pass without actually fixing type safety issues. This is a verification step that MUST be run before marking TypeScript work complete.

## What to Scan

Scan the project structure and look for `src/`, `apps/`, `packages/`, `lib/` directories. If arguments are provided, scan those paths instead.

## Forbidden Patterns to Detect

Use the **Grep tool** (not bash grep) to search for each pattern in `*.ts` and `*.tsx` files. Run all searches and report ALL matches:

1. **Undocumented double-casts** (HIGH SEVERITY): pattern `as unknown as`
2. **Direct any casts** (HIGH SEVERITY): pattern `as any`
3. **Void tricks** (CRITICAL): patterns `void (0` and `void _`
4. **Underscore-prefixed local variables** (MEDIUM): patterns `const _[a-zA-Z]` and `let _[a-zA-Z]` (not function parameters)
5. **TypeScript directive comments** (HIGH): patterns `@ts-ignore` and `@ts-expect-error`
6. **Exported unused types** (LOW — informational): patterns `^export type [A-Z]` and `^export interface [A-Z]`

Use glob `*.{ts,tsx}` to filter to TypeScript files only.

## How to Evaluate Matches

### `as unknown as` - Check for Documentation

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

### `as any` - Almost Always Wrong

**ACCEPTABLE** (rare - only in test mocks):

```typescript
// In test file only
const mockDb = { query: vi.fn() } as any as Database;
```

**NOT ACCEPTABLE** (production code):

```typescript
const data = response.data as any;
```

### `void` Patterns - Always Wrong

**NEVER ACCEPTABLE**:

```typescript
void (0 as unknown as _Type); // Lint suppression trick
void _schemaCheck; // Unused variable suppression
```

### Underscore Variables - Context Matters

**ACCEPTABLE** (function parameters):

```typescript
function handleEvent(_event: Event, data: Data) {
  // _event intentionally unused
  return process(data);
}
```

**NOT ACCEPTABLE** (local variables):

```typescript
const _user = useUser(); // Keep for future use  <- DELETE THIS
```

## Output Format

Present findings in this format:

```markdown
## Reward Hacking Scan Results

### CRITICAL (Must Fix Immediately)

- `file.ts:123` - `void (0 as unknown as Type)` - Lint suppression trick

### HIGH SEVERITY (Must Fix Before Merge)

- `file.ts:456` - `as unknown as Campaign[]` - Missing documentation
- `file.ts:789` - `as any` in production code

### MEDIUM SEVERITY (Should Fix)

- `file.ts:101` - `const _user = ...` - Unused local variable

### ACCEPTABLE (No Action Needed)

- `file.test.ts:50` - `as any` in test mock - Standard test practice
- `file.ts:200` - `as unknown as` with full documentation - Third-party limitation

### Summary

- Critical: X issues
- High: Y issues
- Medium: Z issues
- Total requiring action: X + Y + Z
```

## Verdict

After scanning, provide a clear verdict:

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
```

The agent must address ALL issues before marking their work complete.
