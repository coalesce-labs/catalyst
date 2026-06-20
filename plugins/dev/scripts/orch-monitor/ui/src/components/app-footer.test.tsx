// app-footer.test.tsx — CTL-1172 Phase 4. Tree-walk smoke tests (no DOM render).
// Follows the process-rail.test.tsx pattern; mocks the four hooks so we can call
// AppFooter() directly and assert on the returned React element tree.
import { describe, it, expect, mock, afterAll } from "bun:test";
import type { ReactNode, ReactElement } from "react";
import type { NavSignal } from "@/lib/nav-signal";
import type { ClusterSignal } from "@/lib/cluster-signal";
import type { ServiceStatusView } from "@/components/observe/service-health-kit";
import { severityDotColor } from "@/components/observe/service-health-kit";

// ── mutable state the mock factories close over ────────────────────────────────

let navState: NavSignal | null = {
  daemon: "healthy",
  workerCount: 2,
  queueDepth: 0,
  anomaly: false,
  generatedAt: "",
};

let clusterState: ClusterSignal | null = {
  singleHost: true,
  nodes: [{ host: "mac-mini", status: "live" }],
  generatedAt: "",
};

let serviceHealthState: { services: ServiceStatusView[] | null; unavailable: boolean } = {
  services: [],
  unavailable: false,
};

let boardStatus: string = "connected";
let boardWorkers: unknown[] = [];

function svc(partial: Partial<ServiceStatusView> & { id: string }): ServiceStatusView {
  return {
    label: partial.id,
    severity: "up",
    lastCheckedAt: null,
    lastOkAt: null,
    consecutiveFailures: 0,
    latencyMs: null,
    detail: null,
    target: "http://x",
    configSource: "src",
    downSince: null,
    ...partial,
  };
}

// ── module mocks (must be registered before the component is imported) ─────────
// Include all exports of each real module so other test files in the same
// bun worker thread don't break when they import these modules after us.

// Minimal React-context stub: has .Provider so existing source-shape tests that
// check `ClusterSignalContext.Provider` (sse-dedup.test.ts) still pass.
const stubContext = { Provider: () => null, Consumer: () => null } as unknown;

mock.module("@/hooks/use-nav-signal", () => ({
  NavSignalContext: stubContext,
  useNavSignalContext: () => navState,
  useNavSignal: () => navState,
}));

mock.module("@/hooks/use-cluster-signal", () => ({
  ClusterSignalContext: stubContext,
  useClusterSignalContext: () => clusterState,
  useClusterSignal: () => clusterState,
}));

mock.module("@/hooks/use-service-health", () => ({
  ServiceHealthContext: stubContext,
  SERVICE_HEALTH_DEFAULT: { services: null, unavailable: false },
  SERVICE_HEALTH_POLL_MS: 30_000,
  useServiceHealthContext: () => serviceHealthState,
  useServiceHealth: () => serviceHealthState,
}));

mock.module("@/hooks/use-board-snapshot", () => ({
  useBoardSnapshot: () => ({
    payload: {
      generatedAt: "",
      config: { maxParallel: 4, inFlight: 0, freeSlots: 4, active: 0, working: 0, stuck: 0 },
      repos: [],
      workers: boardWorkers,
      tickets: [],
      queue: [],
    },
    status: boardStatus,
  }),
}));

// Pass-through so collectText sees tooltip content; include TooltipProvider
// so any module that re-imports @/components/ui/tooltip still finds it.
const passThrough = ({ children }: { children: ReactNode }) => children;
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: passThrough,
  TooltipTrigger: passThrough,
  TooltipContent: passThrough,
  TooltipProvider: passThrough,
}));

// CTL-1167: push subscription hook — stub usePushSubscription so AppFooter()
// doesn't call useState (no React dispatcher in direct-call tests). Re-export
// the real base64UrlToUint8Array so use-push-subscription.test.ts is unaffected
// when bun runs both files in the same worker thread (mock.module persists in the
// module registry until afterAll → mock.restore() fires).
mock.module("@/hooks/use-push-subscription", () => {
  function base64UrlToUint8Array(base64UrlString: string): Uint8Array {
    const base64 = base64UrlString.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
  return {
    PUSH_SUPPORTED: false,
    base64UrlToUint8Array,
    usePushSubscription: () => ({
      supported: false,
      permission: "default" as "default",
      subscribed: false,
      enable: async () => {},
      error: null,
    }),
  };
});

// Restore module mocks after the file finishes — prevents mock.module from
// leaking into other test files running in the same bun worker thread.
afterAll(() => { mock.restore(); });

// ── load component after mocks ─────────────────────────────────────────────────
const { AppFooter } = await import("./app-footer");

// ── tree-walk helpers ──────────────────────────────────────────────────────────

function isReactElement(node: unknown): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node && "type" in node;
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isReactElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }
  return "";
}

function containsText(node: ReactNode, text: string): boolean {
  return collectText(node).includes(text);
}

function findDotBackground(node: ReactNode): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findDotBackground(child);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (isReactElement(node)) {
    const props = node.props as {
      style?: { background?: string };
      "aria-hidden"?: boolean;
      children?: ReactNode;
    };
    if (props["aria-hidden"] && props.style?.background) {
      return props.style.background;
    }
    return findDotBackground(props.children);
  }
  return undefined;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("AppFooter service-health indicator (CTL-1172)", () => {
  it("all up → green dot + HEALTHY; left badge + activity summary unchanged (AC-C, AC-D)", () => {
    navState = { daemon: "healthy", workerCount: 2, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = { singleHost: true, nodes: [{ host: "mac-mini", status: "live" }], generatedAt: "" };
    serviceHealthState = {
      services: [svc({ id: "monitor" }), svc({ id: "broker" })],
      unavailable: false,
    };
    boardStatus = "connected";
    const el = AppFooter();
    expect(containsText(el, "LIVE")).toBe(true);
    expect(containsText(el, "active")).toBe(true);
    expect(containsText(el, "HEALTHY")).toBe(true);
    expect(containsText(el, "DOWN")).toBe(false);
  });

  it("a service down → DOWN + tooltip names the service (AC-A, Q3)", () => {
    serviceHealthState = {
      services: [svc({ id: "broker", label: "Broker", severity: "down" }), svc({ id: "monitor" })],
      unavailable: false,
    };
    navState = { daemon: "healthy", workerCount: 0, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = { singleHost: true, nodes: [{ host: "mac-mini", status: "live" }], generatedAt: "" };
    const el = AppFooter();
    expect(containsText(el, "DOWN")).toBe(true);
    expect(containsText(el, "Broker")).toBe(true);
  });

  it("node offline → DOWN + tooltip names the node (AC-A)", () => {
    serviceHealthState = { services: [svc({ id: "monitor" })], unavailable: false };
    navState = { daemon: "healthy", workerCount: 0, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = {
      singleHost: false,
      nodes: [{ host: "mac-mini", status: "offline" }],
      generatedAt: "",
    };
    const el = AppFooter();
    expect(containsText(el, "DOWN")).toBe(true);
    expect(containsText(el, "mac-mini offline")).toBe(true);
  });

  it("degraded service only → DEGRADED (AC-B)", () => {
    serviceHealthState = {
      services: [svc({ id: "loki", label: "Loki", severity: "degraded" })],
      unavailable: false,
    };
    navState = { daemon: "healthy", workerCount: 0, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = { singleHost: true, nodes: [{ host: "mac-mini", status: "live" }], generatedAt: "" };
    const el = AppFooter();
    expect(containsText(el, "DEGRADED")).toBe(true);
  });

  it("fetch failed → muted unknown dot + SERVICES ?; never HEALTHY (AC-E, Q3)", () => {
    serviceHealthState = { services: null, unavailable: true };
    navState = { daemon: "healthy", workerCount: 0, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = { singleHost: true, nodes: [{ host: "mac-mini", status: "live" }], generatedAt: "" };
    const el = AppFooter();
    expect(containsText(el, "HEALTHY")).toBe(false);
    expect(containsText(el, "SERVICES ?")).toBe(true);
    expect(findDotBackground(el)).toBe(severityDotColor("unknown"));
  });

  it("left LIVE badge stays regardless of a service DOWN (AC-D decoupling)", () => {
    serviceHealthState = {
      services: [svc({ id: "broker", severity: "down" })],
      unavailable: false,
    };
    navState = { daemon: "healthy", workerCount: 0, queueDepth: 0, anomaly: false, generatedAt: "" };
    clusterState = { singleHost: true, nodes: [{ host: "mac-mini", status: "live" }], generatedAt: "" };
    boardStatus = "connected";
    const el = AppFooter();
    expect(containsText(el, "LIVE")).toBe(true);
    expect(containsText(el, "DOWN")).toBe(true);
  });
});
