---
name: fix-typescript
description: "Fix TypeScript errors with strict anti-reward-hacking rules. **ALWAYS use when** the user says 'fix type errors', 'fix typescript', 'type-check is failing', or when TypeScript compilation errors need to be resolved. Ensures runtime type safety — fixes root causes instead of silencing errors with casts."
disable-model-invocation: false
allowed-tools: Read, Edit, Bash, Grep
version: 1.1.0
---

# Fix TypeScript Errors

Fix TypeScript type errors for **runtime type safety**, not just to satisfy the linter. If a fix would pass `tsc` but could still crash at runtime, it's wrong.

## Forbidden patterns

The canonical, exhaustive forbidden-pattern table — `as any`, `as unknown as`, `@ts-ignore` / `@ts-expect-error`, void tricks, underscore-prefixed unused locals, non-null assertions without a guard, `forEach(async`, and exported unused types, each with severity and acceptable/unacceptable examples — lives in `/catalyst-dev:scan-reward-hacking` (`plugins/dev/skills/scan-reward-hacking/SKILL.md`). Run it before marking this work complete; don't re-derive the list here.

Two more rules are process-level, not grep-able code patterns, so `/catalyst-dev:scan-reward-hacking` doesn't scan for them — they are still forbidden:

- **Commenting out code** instead of deleting it (git has history).
- **Excluding files from `tsconfig`** to hide errors instead of fixing them.

## Stricter than the canonical scan

Three cases the canonical scan accepts are not acceptable here, because you are actively fixing the error rather than auditing pre-existing code: an exported-but-unused type must be removed or unexported outright, not left as the canonical scan's informational note; `@ts-ignore` / `@ts-expect-error` are never acceptable, even with a documented reason and tracking ticket — fix the error instead of suppressing it; and a test mock's `as any` is not a license to introduce a new one while you're resolving a production type error.

## Fix at the source, not the consumer

```typescript
// WRONG - cast a query result
const users = (await db.from("users").select("*")) as unknown as User[];

// CORRECT - use the query builder's generic typing
const { data: users } = await db.from("users").select("*").returns<User[]>();
```

For **external data** (API requests, webhooks, uploads), validate with Zod at the boundary instead of casting:

```typescript
// WRONG
const webhook = req.body as WebhookPayload;
// CORRECT
const webhook = WebhookPayloadSchema.parse(req.body);
```

## When a type assertion is acceptable

Only for a **third-party library limitation**, documented with what was verified at runtime and a tracking ticket:

```typescript
// LIBRARY TYPE LIMITATION: thirdPartyWrapper() returns a type TS can't verify.
// Verified at runtime it has the required methods. TODO: remove when the library
// updates types (tracked in TICKET-XXX).
const wrapped = thirdPartyResult as unknown as ExpectedInterface;
```

## Process

1. Read the TypeScript error; find the root cause — why doesn't the type already match?
2. Fix at the source (the producing function/type), not the consumer.
3. Detect the package manager (`bun.lockb` / `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`, else `npx tsc --noEmit`) and run its `type-check` script.
4. Run `/catalyst-dev:scan-reward-hacking` on the files you changed. Work is not complete until it passes.

## The golden rule

If you reach for `as`, ask "why doesn't the type already match?" and fix that instead. A type assertion means the source has wrong types (fix the source), external data wasn't validated (add Zod), or a library has incomplete types (document and track) — never use it to silence an error.
