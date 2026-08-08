import { describe, test, expect } from "bun:test";
import { resolveBootDependencies, BOOT_DEPENDENCY_HOLD_REASON } from "./boot-dependency-preflight.mjs";

describe("resolveBootDependencies", () => {
  test("returns healthy without alert when every tool resolves", () => {
    let emitted = 0;
    expect(resolveBootDependencies({ resolveInPath: (t) => `/bin/${t}`, emit: () => emitted++ })).toEqual({ ok: true, missing: [], holdReason: null });
    expect(emitted).toBe(0);
  });

  test("definitive misses quarantine and emit one actionable alert", () => {
    const calls = [];
    const result = resolveBootDependencies({ env: { PATH: "/broken" }, resolveInPath: (t) => t === "node" ? "/bin/node" : null, emit: (x) => calls.push(x) });
    expect(result).toEqual({ ok: false, missing: ["linearis"], holdReason: BOOT_DEPENDENCY_HOLD_REASON });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ missing: ["linearis"], pathStr: "/broken" });
  });

  test("indeterminate probe and alert failures never throw", () => {
    expect(resolveBootDependencies({ resolveInPath: () => { throw new Error("probe"); } })).toMatchObject({ ok: true, degraded: true });
    expect(() => resolveBootDependencies({ resolveInPath: () => null, emit: () => { throw new Error("append"); } })).not.toThrow();
  });
});
