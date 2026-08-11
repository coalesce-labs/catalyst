import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetAnchorCacheForTests,
  isLivenessAnchorTicket,
  resolveAnchorIssueCached,
} from "./dispatch-exclusions.mjs";

afterEach(() => _resetAnchorCacheForTests());

describe("liveness-anchor dispatch exclusion (CAT-159)", () => {
  test("matches the configured issue exactly", () => {
    expect(isLivenessAnchorTicket("CAT-1", { anchorIssue: "CAT-1" })).toBe(true);
    expect(isLivenessAnchorTicket("CAT-2", { anchorIssue: "CAT-1" })).toBe(false);
  });
  test("is case-insensitive and whitespace-tolerant", () => {
    expect(isLivenessAnchorTicket("cat-1", { anchorIssue: "CAT-1" })).toBe(true);
    expect(isLivenessAnchorTicket(" CAT-1 ", { anchorIssue: "CAT-1" })).toBe(true);
  });
  test("fails open when the anchor is unresolved", () => {
    for (const anchorIssue of [null, "", undefined]) {
      expect(isLivenessAnchorTicket("CAT-1", { anchorIssue })).toBe(false);
      expect(isLivenessAnchorTicket("", { anchorIssue })).toBe(false);
    }
  });
  test("is null-safe on the candidate", () => {
    expect(isLivenessAnchorTicket(null, { anchorIssue: "CAT-1" })).toBe(false);
  });
  test("does not match prefixes or substrings", () => {
    for (const ticket of ["CAT-10", "CAT-159", "XCAT-1"]) {
      expect(isLivenessAnchorTicket(ticket, { anchorIssue: "CAT-1" })).toBe(false);
    }
  });
  test("memoizes the resolver for 60 seconds", () => {
    let reads = 0;
    const reader = () => { reads += 1; return "CAT-1"; };
    expect(resolveAnchorIssueCached(100, { reader })).toBe("CAT-1");
    expect(resolveAnchorIssueCached(200, { reader })).toBe("CAT-1");
    expect(reads).toBe(1);
  });
  test("reset forces re-resolution", () => {
    let reads = 0;
    const reader = () => `CAT-${++reads}`;
    expect(resolveAnchorIssueCached(100, { reader })).toBe("CAT-1");
    _resetAnchorCacheForTests();
    expect(resolveAnchorIssueCached(100, { reader })).toBe("CAT-2");
  });
  test("resolver never throws", () => {
    expect(resolveAnchorIssueCached(100, { reader: () => { throw new Error("bad config"); } })).toBeNull();
  });
});
