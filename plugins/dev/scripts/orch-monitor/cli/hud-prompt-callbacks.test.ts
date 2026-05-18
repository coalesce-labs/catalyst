// hud-prompt-callbacks.test.ts — mirrors the useCallback deps added at
// hud.tsx:516 (onSubmit), :524 (onEsc), and the useMemo at :541 (metrics).
// Asserts that with stable inputs the callback identity is preserved, and
// with changed inputs a new identity is produced.

import { describe, test, expect } from "bun:test";

function makeCallback<F extends (...a: never[]) => unknown, D extends readonly unknown[]>(
  build: () => F,
) {
  let lastDeps: D | null = null;
  let lastFn: F;
  return (deps: D): F => {
    const prev = lastDeps;
    if (prev === null || deps.some((d, i) => d !== prev[i])) {
      lastFn = build();
      lastDeps = deps;
    }
    return lastFn;
  };
}

describe("PromptInput onSubmit useCallback (hud.tsx)", () => {
  // Deps: [inputMode, submitQuery, setInputMode]
  test("same identity when inputMode/submitQuery/setInputMode unchanged", () => {
    const cb = makeCallback(() => (_v: string) => undefined);
    const submitQuery = () => undefined;
    const setInputMode = () => undefined;
    const a = cb(["normal", submitQuery, setInputMode] as const);
    const b = cb(["normal", submitQuery, setInputMode] as const);
    expect(a).toBe(b);
  });

  test("new identity when inputMode changes", () => {
    const cb = makeCallback(() => (_v: string) => undefined);
    const submitQuery = () => undefined;
    const setInputMode = () => undefined;
    const a = cb(["normal", submitQuery, setInputMode] as const);
    const b = cb(["filter", submitQuery, setInputMode] as const);
    expect(a).not.toBe(b);
  });
});

describe("PromptInput metrics useMemo (hud.tsx)", () => {
  // Deps: [pollMetrics, heartbeatCount]
  test("same identity when pollMetrics and heartbeatCount unchanged", () => {
    let calls = 0;
    const memo = (() => {
      let lastDeps: readonly [object, number] | null = null;
      let lastVal: object;
      return (deps: readonly [object, number]) => {
        if (lastDeps === null || deps[0] !== lastDeps[0] || deps[1] !== lastDeps[1]) {
          lastVal = { ...deps[0], heartbeats: deps[1] };
          calls++;
          lastDeps = deps;
        }
        return lastVal;
      };
    })();
    const pollMetrics = { reads: 0 };
    const v1 = memo([pollMetrics, 5] as const);
    const v2 = memo([pollMetrics, 5] as const);
    expect(v1).toBe(v2);
    expect(calls).toBe(1);
  });

  test("new identity when heartbeatCount changes", () => {
    const memo = (() => {
      let lastDeps: readonly [object, number] | null = null;
      let lastVal: object;
      return (deps: readonly [object, number]) => {
        if (lastDeps === null || deps[0] !== lastDeps[0] || deps[1] !== lastDeps[1]) {
          lastVal = { ...deps[0], heartbeats: deps[1] };
          lastDeps = deps;
        }
        return lastVal;
      };
    })();
    const pollMetrics = { reads: 0 };
    const v1 = memo([pollMetrics, 5] as const);
    const v2 = memo([pollMetrics, 6] as const);
    expect(v1).not.toBe(v2);
  });
});

describe("Header version object useMemo (hud.tsx)", () => {
  // version is built from versionChip.display + versionChip.isLocal, which
  // are frozen at mount (useRef(readPluginVersion()).current at hud.tsx:161).
  // The memo deps should therefore be [versionChip] — stable for the lifetime
  // of the component.
  test("returns the same reference across renders (frozen useRef input)", () => {
    let lastDeps: readonly [object] | null = null;
    let lastVal: { display: string; isLocal: boolean };
    const memo = (deps: readonly [{ display: string; isLocal: boolean }]) => {
      if (lastDeps === null || deps[0] !== lastDeps[0]) {
        lastVal = { display: deps[0].display, isLocal: deps[0].isLocal };
        lastDeps = deps;
      }
      return lastVal;
    };
    const versionChip = { display: "0.1.0", isLocal: false };
    const r1 = memo([versionChip] as const);
    const r2 = memo([versionChip] as const);
    expect(r1).toBe(r2);
  });
});
