// service-health-kit.test.ts — units for the CTL-1050 Fleet Ops SERVICES strip
// pure logic: severity→CSS-var token mapping, the catalyst-plane-first ordering,
// the last-checked label, and the hover text. All pure (no React render), so
// they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/service-health-kit.test.ts

import { describe, it, expect } from "bun:test";
import {
  type ServiceStatusView,
  type WorstSeverityInput,
  STRIP_ORDER,
  hoverText,
  isLabelMuted,
  lastCheckedLabel,
  orderServices,
  severityDotColor,
  severityDotGlow,
  severityDotOpacity,
  worstSeverity,
} from "./service-health-kit";

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

describe("severity → token mapping (HostMatrix vocabulary)", () => {
  it("maps each severity to the right CSS var", () => {
    expect(severityDotColor("up")).toBe("var(--chart-2)");
    expect(severityDotColor("degraded")).toBe("var(--chart-3)");
    expect(severityDotColor("down")).toBe("var(--chart-4)");
    expect(severityDotColor("unknown")).toBe("var(--muted-foreground)");
  });

  it("glows ONLY when up", () => {
    expect(severityDotGlow("up")).toContain("0 0 6px");
    expect(severityDotGlow("degraded")).toBeUndefined();
    expect(severityDotGlow("down")).toBeUndefined();
    expect(severityDotGlow("unknown")).toBeUndefined();
  });

  it("dims unknown to 50% opacity, others full", () => {
    expect(severityDotOpacity("unknown")).toBe(0.5);
    expect(severityDotOpacity("up")).toBe(1);
    expect(severityDotOpacity("down")).toBe(1);
  });

  it("mutes the label only for unknown", () => {
    expect(isLabelMuted("unknown")).toBe(true);
    expect(isLabelMuted("up")).toBe(false);
    expect(isLabelMuted("down")).toBe(false);
  });
});

describe("orderServices (catalyst plane first)", () => {
  it("sorts to monitor·broker·exec-core·webhook·collector·loki·prom·grafana", () => {
    const shuffled = [
      svc({ id: "grafana" }),
      svc({ id: "loki" }),
      svc({ id: "monitor" }),
      svc({ id: "broker" }),
      svc({ id: "prometheus" }),
      svc({ id: "webhook" }),
      svc({ id: "execution-core" }),
      svc({ id: "otel-collector" }),
    ];
    const ids = orderServices(shuffled).map((s) => s.id);
    expect(ids).toEqual([...STRIP_ORDER]);
  });

  it("does not mutate the input array", () => {
    const input = [svc({ id: "grafana" }), svc({ id: "monitor" })];
    const before = input.map((s) => s.id);
    orderServices(input);
    expect(input.map((s) => s.id)).toEqual(before);
  });

  it("unknown ids sort to the end", () => {
    const ids = orderServices([svc({ id: "mystery" }), svc({ id: "monitor" })]).map(
      (s) => s.id,
    );
    expect(ids).toEqual(["monitor", "mystery"]);
  });
});

describe("lastCheckedLabel", () => {
  const now = 1_000_000;
  it("renders seconds / minutes / hours / —", () => {
    expect(lastCheckedLabel(now - 12_000, now)).toBe("12s");
    expect(lastCheckedLabel(now - 3 * 60_000, now)).toBe("3m");
    expect(lastCheckedLabel(now - 2 * 60 * 60_000, now)).toBe("2h");
    expect(lastCheckedLabel(null, now)).toBe("—");
  });
});

describe("hoverText", () => {
  it("includes target, source, last-ok, failures, detail", () => {
    const t = hoverText(
      svc({
        id: "loki",
        label: "Loki",
        severity: "degraded",
        target: "http://loki/ready",
        configSource: "otel.lokiUrl",
        consecutiveFailures: 2,
        lastOkAt: Date.parse("2026-06-11T14:20:00"),
        detail: "probe failed",
      }),
    );
    expect(t).toContain("http://loki/ready");
    expect(t).toContain("source: otel.lokiUrl");
    expect(t).toContain("2 consecutive failures");
    expect(t).toContain("probe failed");
  });

  it("a down service carries 'down since HH:MM'", () => {
    const t = hoverText(
      svc({
        id: "loki",
        severity: "down",
        downSince: Date.parse("2026-06-11T14:32:00"),
      }),
    );
    expect(t).toContain("down since 14:32");
  });

  it("an unconfigured service reads 'not configured'", () => {
    const t = hoverText(svc({ id: "grafana", severity: "unknown", target: null }));
    expect(t).toContain("not configured");
  });
});

describe("worstSeverity — fold node+daemon+service severities (CTL-1172)", () => {
  // helper alias already declared above as svc()
  type Input = WorstSeverityInput;

  // C — all up → up
  it("all services up + daemon healthy + nodes live → up", () => {
    const i: Input = { services: [svc({ id: "monitor" }), svc({ id: "broker" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live", "live"] };
    expect(worstSeverity(i)).toBe("up");
  });

  it("optional inputs omitted still yields up when services up", () => {
    expect(worstSeverity({ services: [svc({ id: "monitor" })], unavailable: false })).toBe("up");
  });

  // A — down wins
  it("one down service → down", () => {
    const i: Input = { services: [svc({ id: "monitor" }), svc({ id: "broker", severity: "down" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("down");
  });

  it("node offline → down (services all up)", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live", "offline"] };
    expect(worstSeverity(i)).toBe("down");
  });

  it("daemon offline → down", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: "offline", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("down");
  });

  // B — degraded
  it("one degraded service, none down → degraded", () => {
    const i: Input = { services: [svc({ id: "monitor" }), svc({ id: "loki", severity: "degraded" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("degraded");
  });

  it("daemon degraded, services up → degraded", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: "degraded", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("degraded");
  });

  it("single degraded node → degraded", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live", "degraded"] };
    expect(worstSeverity(i)).toBe("degraded");
  });

  // down outranks degraded
  it("down outranks degraded when both present", () => {
    const i: Input = { services: [svc({ id: "loki", severity: "degraded" }), svc({ id: "broker", severity: "down" })], unavailable: false, daemonHealth: "degraded", nodeStatuses: ["degraded"] };
    expect(worstSeverity(i)).toBe("down");
  });

  // unknown non-escalating
  it("unknown does NOT mask a real down", () => {
    const i: Input = { services: [svc({ id: "grafana", severity: "unknown" }), svc({ id: "broker", severity: "down" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("down");
  });

  it("unknown does NOT grey-out an all-up fleet", () => {
    const i: Input = { services: [svc({ id: "monitor" }), svc({ id: "grafana", severity: "unknown" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("up");
  });

  it("unknown + degraded → degraded (unknown inert)", () => {
    const i: Input = { services: [svc({ id: "grafana", severity: "unknown" }), svc({ id: "loki", severity: "degraded" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("degraded");
  });

  it("all-unknown services + healthy daemon/live nodes → up (not unknown)", () => {
    const i: Input = { services: [svc({ id: "a", severity: "unknown" }), svc({ id: "b", severity: "unknown" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("up");
  });

  // E + Q2 — fail-open
  it("unavailable (fetch failed) → unknown, even with stale services", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: true, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("unknown");
  });

  it("services === null pre-first-fetch → unknown", () => {
    const i: Input = { services: null, unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("unknown");
  });

  // edge cases
  it("empty services array is LOADED (not null) → liveness drives the result", () => {
    expect(worstSeverity({ services: [], unavailable: false, daemonHealth: "healthy", nodeStatuses: ["live"] })).toBe("up");
    expect(worstSeverity({ services: [], unavailable: false, daemonHealth: "offline", nodeStatuses: ["live"] })).toBe("down");
  });

  it("daemonHealth null is inert (does not escalate, does not force unknown)", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: null, nodeStatuses: ["live"] };
    expect(worstSeverity(i)).toBe("up");
  });

  it("empty nodeStatuses is inert", () => {
    const i: Input = { services: [svc({ id: "monitor" })], unavailable: false, daemonHealth: "healthy", nodeStatuses: [] };
    expect(worstSeverity(i)).toBe("up");
  });
});
