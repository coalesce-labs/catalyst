// scope-for-ticket.test.mjs — CTL-2129 Phase 2. scopeForTicket is a pure,
// injectable mapping (ticket → project id) with a fail-open fallback to the raw
// ticket id. Run from execution-core/ under `bun test`.
//
// ⚠️ Registered in .github/workflows/execution-core-tests.yml (the allowlist is
// explicit, not a glob) — a new execution-core test file that is not listed there
// never gates CI.
import { test, expect } from "bun:test";
import { scopeForTicket } from "../scope-for-ticket.mjs";

test("resolves to the project id when the ticket has one", () => {
  expect(scopeForTicket("CTL-2129", { readProjectId: () => "proj-uuid-1" })).toBe("proj-uuid-1");
});

test("falls back to the raw ticket id when the ticket has no project (null)", () => {
  expect(scopeForTicket("CTL-2129", { readProjectId: () => null })).toBe("CTL-2129");
});

test("falls back to the ticket id for an empty-string project id", () => {
  expect(scopeForTicket("CTL-2129", { readProjectId: () => "" })).toBe("CTL-2129");
});

test("fail-open: readProjectId throwing yields the ticket-id fallback", () => {
  expect(
    scopeForTicket("CTL-2129", {
      readProjectId: () => {
        throw new Error("db locked");
      },
    }),
  ).toBe("CTL-2129");
});

test("no readProjectId dep → the ticket id (pure, never throws)", () => {
  expect(scopeForTicket("CTL-2129")).toBe("CTL-2129");
  expect(scopeForTicket("CTL-2129", {})).toBe("CTL-2129");
});

test("a non-string project id is not a scope key → ticket-id fallback", () => {
  expect(scopeForTicket("CTL-2129", { readProjectId: () => 42 })).toBe("CTL-2129");
});
