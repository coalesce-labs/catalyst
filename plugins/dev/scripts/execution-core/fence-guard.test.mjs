// fence-guard.test.mjs — tests for the shared fenceGuard decision helper (CTL-863 Phase 4).
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard.test.mjs
import { describe, test, expect } from "bun:test";

import { fenceGuard } from "./fence-guard.mjs";

describe("fenceGuard — single decision shared by all external-write sites (CTL-863)", () => {
  test("single-host (multiHost:false) always passes without calling check", () => {
    let checked = false;
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: false },
      { check: () => { checked = true; return { current: true }; } },
    );
    expect(result).toBe(true);
    expect(checked).toBe(false);
  });

  test("multi-host + current generation → passes (true)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => 5, check: () => ({ current: true }) },
    );
    expect(result).toBe(true);
  });

  test("multi-host + stale generation → blocks the write (false)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => 5, check: () => ({ current: false }) },
    );
    expect(result).toBe(false);
  });

  test("multi-host + missing generation (null) → blocks (fail-closed)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => null, check: () => ({ current: true }) },
    );
    expect(result).toBe(false);
  });

  test("multi-host + NaN generation → blocks (fail-closed)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => NaN, check: () => ({ current: true }) },
    );
    expect(result).toBe(false);
  });

  test("check throws → blocks (fail-closed)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => 3, check: () => { throw new Error("spawn failed"); } },
    );
    expect(result).toBe(false);
  });

  test("readGen throws → blocks (fail-closed)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true },
      { readGen: () => { throw new Error("ENOENT"); }, check: () => ({ current: true }) },
    );
    expect(result).toBe(false);
  });

  test("passes the correct ticket+generation to check", () => {
    let captured = null;
    fenceGuard(
      { ticket: "CTL-999", orchDir: "/o", multiHost: true },
      { readGen: () => 42, check: (args) => { captured = args; return { current: true }; } },
    );
    expect(captured).toEqual({ ticket: "CTL-999", generation: 42 });
  });
});
