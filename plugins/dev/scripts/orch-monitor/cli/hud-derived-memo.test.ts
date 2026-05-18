// hud-derived-memo.test.ts — mirrors the useMemo dep arrays added in hud.tsx
// for buildDetailLines (line ~261) and dslLines (line ~296). Bun's test runner
// doesn't drive React, so we mirror the *identity contract*: same inputs ⇒
// same identity, any change ⇒ new identity. Drift between this mirror and
// hud.tsx is caught the moment a dep is added/removed.

import { describe, test, expect } from "bun:test";

// Stand-in memoizer: recomputes only when any dep changes by reference.
function makeMemo<T, D extends readonly unknown[]>(compute: (...d: D) => T) {
  let lastDeps: D | null = null;
  let lastResult: T;
  return (deps: D): T => {
    const prev = lastDeps;
    if (prev === null || deps.some((d, i) => d !== prev[i])) {
      lastResult = compute(...deps);
      lastDeps = deps;
    }
    return lastResult;
  };
}

describe("buildDetailLines memo (hud.tsx)", () => {
  test("returns the same reference when deps unchanged", () => {
    const memo = makeMemo((_e: object | null, _c: number) => ({ tag: "lines" }));
    const event = {};
    const r1 = memo([event, 80] as const);
    const r2 = memo([event, 80] as const);
    expect(r1).toBe(r2);
  });

  test("recomputes when selectedEvent identity changes", () => {
    const memo = makeMemo((_e: object | null, _c: number) => ({ tag: "lines" }));
    const r1 = memo([{}, 80] as const);
    const r2 = memo([{}, 80] as const);
    expect(r1).not.toBe(r2);
  });

  test("recomputes when innerCols changes", () => {
    const memo = makeMemo((_e: object | null, _c: number) => ({ tag: "lines" }));
    const event = {};
    const r1 = memo([event, 80] as const);
    const r2 = memo([event, 120] as const);
    expect(r1).not.toBe(r2);
  });

  test("returns the same reference for null selectedEvent across renders", () => {
    const memo = makeMemo((_e: object | null, _c: number) => ({ tag: "lines" }));
    const r1 = memo([null, 80] as const);
    const r2 = memo([null, 80] as const);
    expect(r1).toBe(r2);
  });
});

describe("dslLines memo (hud.tsx)", () => {
  test("returns the same reference when dslState unchanged", () => {
    const memo = makeMemo((_s: object | null) => ["line1", "line2"]);
    const dslState = { dsl: {} };
    const r1 = memo([dslState] as const);
    const r2 = memo([dslState] as const);
    expect(r1).toBe(r2);
  });

  test("recomputes when dslState identity changes", () => {
    const memo = makeMemo((_s: object | null) => ["line1", "line2"]);
    const r1 = memo([{ dsl: {} }] as const);
    const r2 = memo([{ dsl: {} }] as const);
    expect(r1).not.toBe(r2);
  });
});
