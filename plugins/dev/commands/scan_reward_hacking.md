---
description: Scan for reward hacking patterns in recent changes
model: sonnet
---

# Scan for Reward Hacking Patterns

You are scanning for "reward hacking" patterns - code that makes linters pass without actually fixing type safety issues. This is a verification step that MUST be run before marking TypeScript work complete.

## What to Scan

Scan the project structure and look for `src/`, `apps/`, `packages/`, `lib/` directories. If `$ARGUMENTS` is provided, scan those paths instead.

Store the detected scan targets in a variable (e.g., `SCAN_DIRS`) and use them in all grep commands below.

## Forbidden Patterns to Detect

Run these grep commands against the detected directories and report ALL matches:

```bash
# 1. Undocumented double-casts (HIGH SEVERITY)
grep -rn "as unknown as" $SCAN_DIRS --include="*.ts" --include="*.tsx"

# 2. Direct any casts (HIGH SEVERITY)
grep -rn "as any" $SCAN_DIRS --include="*.ts" --include="*.tsx"

# 3. Void tricks to suppress unused warnings (CRITICAL - IMMEDIATE FIX)
grep -rn "void (0" $SCAN_DIRS --include="*.ts" --include="*.tsx"
grep -rn "void _" $SCAN_DIRS --include="*.ts" --include="*.tsx"

# 4. Underscore-prefixed local variables (MEDIUM SEVERITY)
# Look for const _varName = or let _varName = that aren't function parameters
grep -rn "const _[a-zA-Z]" $SCAN_DIRS --include="*.ts" --include="*.tsx"
grep -rn "let _[a-zA-Z]" $SCAN_DIRS --include="*.ts" --include="*.tsx"

# 5. TypeScript directive comments (HIGH SEVERITY)
grep -rn "@ts-ignore" $SCAN_DIRS --include="*.ts" --include="*.tsx"
grep -rn "@ts-expect-error" $SCAN_DIRS --include="*.ts" --include="*.tsx"

# 6. Exported but potentially unused types (LOW SEVERITY - informational)
# This requires more analysis - flag for manual review
grep -rn "^export type [A-Z]" $SCAN_DIRS --include="*.ts" --include="*.tsx"
grep -rn "^export interface [A-Z]" $SCAN_DIRS --include="*.ts" --include="*.tsx"
```

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
