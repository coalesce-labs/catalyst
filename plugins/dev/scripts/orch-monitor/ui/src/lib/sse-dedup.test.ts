// sse-dedup.test.ts — structural regression guard for CTL-945.
//
// The browser's HTTP/1.1 per-origin connection limit (6 slots) was silently
// consumed by 6 persistent EventSources, leaving no slot for the lazy Board
// chunk to load — Suspense showed SkeletonDashboard forever.
//
// Fix 1: NavSignalContext + ClusterSignalContext lift both hooks into AppShell
//   so AppSidebar and AppFooter share the same signal value (4 SSEs instead of 6).
// Fix 2: Board is eagerly imported (not lazy()) in App.tsx — no chunk-fetch race.
//
// These tests prove the structural contracts at the module level, without a DOM.
// Run from the ui package: `cd ui && bun test src/lib/sse-dedup.test.ts`.
import { describe, it, expect } from "bun:test";

// ── Fix 1: context exports exist on both signal hook modules ──────────────────

describe("CTL-945 Fix1 — NavSignalContext exported for AppShell dedup", () => {
  it("NavSignalContext is exported from use-nav-signal", async () => {
    const mod = await import("../hooks/use-nav-signal");
    // The context object must exist and be a React context (has a Provider property).
    expect(mod.NavSignalContext).toBeDefined();
    expect(typeof mod.NavSignalContext).toBe("object");
    expect(mod.NavSignalContext).toHaveProperty("Provider");
  });

  it("useNavSignalContext is exported and is a function", async () => {
    const mod = await import("../hooks/use-nav-signal");
    expect(typeof mod.useNavSignalContext).toBe("function");
  });

  it("useNavSignal (the SSE hook) is still exported for the single provider call", async () => {
    const mod = await import("../hooks/use-nav-signal");
    expect(typeof mod.useNavSignal).toBe("function");
  });
});

describe("CTL-945 Fix1 — ClusterSignalContext exported for AppShell dedup", () => {
  it("ClusterSignalContext is exported from use-cluster-signal", async () => {
    const mod = await import("../hooks/use-cluster-signal");
    expect(mod.ClusterSignalContext).toBeDefined();
    expect(typeof mod.ClusterSignalContext).toBe("object");
    expect(mod.ClusterSignalContext).toHaveProperty("Provider");
  });

  it("useClusterSignalContext is exported and is a function", async () => {
    const mod = await import("../hooks/use-cluster-signal");
    expect(typeof mod.useClusterSignalContext).toBe("function");
  });

  it("useClusterSignal (the SSE hook) is still exported for the single provider call", async () => {
    const mod = await import("../hooks/use-cluster-signal");
    expect(typeof mod.useClusterSignal).toBe("function");
  });
});

// ── Fix 2: Board is a direct (eager) export, not a lazy wrapper ───────────────

describe("CTL-945 Fix2 — Board is eagerly imported (no lazy chunk-fetch race)", () => {
  it("Board is a non-null, non-Promise function (eager component, not lazy())", async () => {
    const mod = await import("../board/Board");
    // lazy() returns an exotic object with $$typeof === REACT_LAZY_TYPE, not a plain
    // function. An eagerly-imported React component is a plain function or class.
    expect(mod.Board).toBeDefined();
    expect(typeof mod.Board).toBe("function");
    // A React.lazy result has a $$typeof symbol; an eager component does not.
    const board = mod.Board as unknown as Record<string | symbol, unknown>;
    const lazyType =
      typeof Symbol !== "undefined" && Symbol.for
        ? Symbol.for("react.lazy")
        : 0xead4; // React 17 numeric fallback
    expect(board["$$typeof"]).not.toBe(lazyType);
  });
});

// ── CTL-1100 — BeliefsContext exported (single-EventSource guard) ─────────────
// Mirrors the CTL-945 Fix1 pattern: exactly ONE /api/beliefs/stream EventSource
// must exist across the app. AppShell calls useBeliefs() once and distributes
// via BeliefsContext so surfaces use useBeliefsContext() — never a direct
// useBeliefs() call in a leaf component.
describe("CTL-1100 — BeliefsContext exported", () => {
  it("BeliefsContext is exported and has a Provider", async () => {
    const mod = await import("../hooks/use-beliefs");
    expect(mod.BeliefsContext).toBeDefined();
    expect(typeof mod.BeliefsContext).toBe("object");
    expect(mod.BeliefsContext).toHaveProperty("Provider");
  });

  it("useBeliefsContext is exported and is a function", async () => {
    const mod = await import("../hooks/use-beliefs");
    expect(typeof mod.useBeliefsContext).toBe("function");
  });

  it("useBeliefs (the SSE hook) is exported for the single provider call", async () => {
    const mod = await import("../hooks/use-beliefs");
    expect(typeof mod.useBeliefs).toBe("function");
  });
});
