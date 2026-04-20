import { describe, it, expect } from "bun:test";
import { derivePrVariant } from "../lib/pr-variant";

describe("derivePrVariant", () => {
  it("returns 'unknown' when state is undefined", () => {
    expect(derivePrVariant({})).toBe("unknown");
    expect(derivePrVariant({ state: null })).toBe("unknown");
  });

  it("returns 'merged' when state=MERGED regardless of draft/mergeStateStatus", () => {
    expect(derivePrVariant({ state: "MERGED" })).toBe("merged");
    expect(derivePrVariant({ state: "MERGED", isDraft: true })).toBe("merged");
    expect(
      derivePrVariant({ state: "MERGED", mergeStateStatus: "BLOCKED" }),
    ).toBe("merged");
  });

  it("returns 'closed' for CLOSED (unmerged) PRs", () => {
    expect(derivePrVariant({ state: "CLOSED" })).toBe("closed");
    expect(derivePrVariant({ state: "CLOSED", isDraft: true })).toBe("closed");
  });

  it("returns 'draft' when state=OPEN and isDraft=true", () => {
    expect(derivePrVariant({ state: "OPEN", isDraft: true })).toBe("draft");
  });

  it("draft takes precedence over merge-state for OPEN PRs", () => {
    expect(
      derivePrVariant({
        state: "OPEN",
        isDraft: true,
        mergeStateStatus: "BLOCKED",
      }),
    ).toBe("draft");
    expect(
      derivePrVariant({
        state: "OPEN",
        isDraft: true,
        mergeStateStatus: "DIRTY",
      }),
    ).toBe("draft");
  });

  it("returns 'conflict' for OPEN + DIRTY", () => {
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "DIRTY" }),
    ).toBe("conflict");
  });

  it("returns 'blocked' for OPEN + BLOCKED", () => {
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "BLOCKED" }),
    ).toBe("blocked");
  });

  it("returns 'unstable' for OPEN + UNSTABLE (CI failing)", () => {
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "UNSTABLE" }),
    ).toBe("unstable");
  });

  it("returns 'open' for OPEN + CLEAN/BEHIND/HAS_HOOKS/UNKNOWN/undefined", () => {
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "CLEAN" }),
    ).toBe("open");
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "BEHIND" }),
    ).toBe("open");
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "HAS_HOOKS" }),
    ).toBe("open");
    expect(
      derivePrVariant({ state: "OPEN", mergeStateStatus: "UNKNOWN" }),
    ).toBe("open");
    expect(derivePrVariant({ state: "OPEN" })).toBe("open");
  });

  it("handles lowercase state input defensively", () => {
    expect(derivePrVariant({ state: "merged" })).toBe("merged");
    expect(derivePrVariant({ state: "open" })).toBe("open");
    expect(derivePrVariant({ state: "closed" })).toBe("closed");
  });

  it("returns 'unknown' for unrecognized state", () => {
    expect(derivePrVariant({ state: "WEIRD" })).toBe("unknown");
  });
});
