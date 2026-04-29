---
name: fix-typescript
description: "Fix TypeScript errors with strict anti-reward-hacking rules. **ALWAYS use when** the user says 'fix type errors', 'fix typescript', 'type-check is failing', or when TypeScript compilation errors need to be resolved. Ensures runtime type safety — fixes root causes instead of silencing errors with casts."
disable-model-invocation: false
allowed-tools: Read, Edit, Bash, Grep
version: 1.0.0
---

# Fix TypeScript Errors

You are fixing TypeScript type errors. This command embeds strict rules to prevent "reward hacking" - patterns that make linters pass without actually fixing type safety issues.

## CRITICAL: Read Before Starting

**Your goal is RUNTIME TYPE SAFETY, not just passing linters.**

If your fix would make the linter happy but could still crash at runtime, it's wrong.

## Forbidden Patterns

These patterns are EXPLICITLY FORBIDDEN. Using them will require rework:

| Pattern                                   | Why Forbidden                            | What To Do Instead                    |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------- |
| `as unknown as Type` (undocumented)       | Erases all type info, defeats TypeScript | Fix the source to return correct type |
| `as any`                                  | Disables type checking entirely          | Use proper typing or Zod validation   |
| `void (0 as unknown as Type)`             | Tricks linter into thinking type is used | Delete the unused type                |
| `const _var = ...` (local variable)       | Suppresses unused warning                | Delete the unused variable            |
| `export type Foo` (when unused elsewhere) | Suppresses unused warning                | Remove `export` or delete the type    |
| `// @ts-ignore` or `// @ts-expect-error`  | Hides real type problems                 | Fix the actual type error             |
| Commenting out code                       | Dead code clutters codebase              | Delete it (git has history)           |
| Excluding files from tsconfig             | Hides errors in those files              | Include files, fix errors             |

## Required Approach

### For Internal Code (services, models, aggregations)

Fix the SOURCE to return the correct type:

```typescript
// WRONG - Casting a query result
const users = (await db.from("users").select("*")) as unknown as User[];

// CORRECT - Use the query builder's generic typing
const { data: users } = await db.from("users").select("*").returns<User[]>();
```

```typescript
// WRONG - Casting a service result
const account = (await accountService.findById(id)) as Account;

// CORRECT - Fix the service to return the right type
const account = await accountService.findById(id); // Returns Account | null
if (account === null) throw new NotFoundError();
```

### For External Data (API requests, webhooks, file uploads)

Validate with Zod at the boundary:

```typescript
// WRONG - Trust external data
const webhook = req.body as WebhookPayload;

// CORRECT - Validate at boundary
const webhook = WebhookPayloadSchema.parse(req.body);
```

## When Type Assertions ARE Acceptable

Type assertions are ONLY acceptable for **third-party library limitations** with full documentation:

```typescript
// ACCEPTABLE - Third-party library type gap with documentation
// LIBRARY TYPE LIMITATION: The thirdPartyWrapper() function returns a type
// that TypeScript can't verify implements the expected interface.
// Verified at runtime that the object has the required methods.
// TODO: Remove when library updates types (tracked in TICKET-XXX)
const wrapped = thirdPartyResult as unknown as ExpectedInterface;
```

**Requirements for acceptable assertions:**

1. The type error is from a THIRD-PARTY LIBRARY we don't control
2. There's a detailed comment explaining WHY
3. The comment explains what was verified at runtime
4. There's a TODO with a tracking ticket

## Process

1. **Understand the error**: Read the TypeScript error message carefully
2. **Find the root cause**: Why doesn't the type already match?
3. **Fix at the source**: Change the source function/type, not the consumer
4. **Verify the fix**: Detect the package manager and run type-check (see below)
5. **Run validation**: Execute `/scan-reward-hacking` before marking complete

## Detecting Package Manager and Type-Check Script

First, check `package.json` for a `type-check` script. Then detect the package manager by looking for lock files:

- `bun.lockb` -> `bun run type-check`
- `pnpm-lock.yaml` -> `pnpm type-check`
- `yarn.lock` -> `yarn type-check`
- `package-lock.json` -> `npm run type-check`

If no lock file is found, fall back to `npx tsc --noEmit`.

## Before Marking Complete

You MUST run these checks:

```bash
# Type check must pass (use the detected package manager)
# e.g., npm run type-check / yarn type-check / bun run type-check / pnpm type-check

# Scan for forbidden patterns (run /scan-reward-hacking command)
grep -r "as unknown as" [files-you-changed]
grep -r "void (0" [files-you-changed]
grep -r "as any" [files-you-changed]
```

If ANY forbidden pattern exists in your changes without proper documentation, your work is not complete.

## The Golden Rule

**If you need `as`, ask "Why doesn't the type already match?" and fix THAT.**

Type assertions are a code smell. They mean either:

1. The source function has wrong types (fix the source)
2. External data wasn't validated (add Zod validation)
3. A library has incomplete types (document and track)

Never use assertions to silence errors - fix the underlying type mismatch.
