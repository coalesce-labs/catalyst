// CTL-1172: lift the /api/health/services fetch to the AppShell so the footer
// health indicator and the FleetOps SERVICES strip share ONE ~30s poll (CTL-945
// pattern). DEVIATION from use-nav-signal / use-cluster-signal: no SSE endpoint
// for services → setInterval poll, not an EventSource. Same alive-guard + cleanup
// discipline.
import { createContext, useContext, useEffect, useState } from "react";
import type {
  ServiceHealthSnapshotView,
  ServiceStatusView,
} from "@/components/observe/service-health-kit";

export interface ServiceHealthContextValue {
  services: ServiceStatusView[] | null;
  unavailable: boolean;
}

/** Fail-open default: no provider / pre-first-fetch ⇒ unknown (muted), never green. */
export const SERVICE_HEALTH_DEFAULT: ServiceHealthContextValue = {
  services: null,
  unavailable: false,
};

export const ServiceHealthContext =
  createContext<ServiceHealthContextValue>(SERVICE_HEALTH_DEFAULT);

export function useServiceHealthContext(): ServiceHealthContextValue {
  return useContext(ServiceHealthContext);
}

/** Matches the server registry recompute (lib/service-health.ts:283). */
export const SERVICE_HEALTH_POLL_MS = 30_000;

/** Poll /api/health/services. Call ONCE at the AppShell provider site. */
export function useServiceHealth(): ServiceHealthContextValue {
  const [value, setValue] = useState<ServiceHealthContextValue>(SERVICE_HEALTH_DEFAULT);
  useEffect(() => {
    let alive = true;
    let controller: AbortController | undefined;
    const load = async (): Promise<void> => {
      if (!alive) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const resp = await fetch("/api/health/services", { signal: controller.signal });
        if (!alive) return;
        if (!resp.ok) {
          setValue({ services: null, unavailable: true });
          return;
        }
        const body = (await resp.json()) as ServiceHealthSnapshotView;
        if (!alive) return;
        setValue({ services: body.services ?? [], unavailable: false });
      } catch (err) {
        if (!alive || (err instanceof DOMException && err.name === "AbortError")) return;
        setValue({ services: null, unavailable: true });
      }
    };
    void load();
    const id = setInterval(() => void load(), SERVICE_HEALTH_POLL_MS);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return value;
}
