import type { ServiceSeverity } from "./service-health";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface EndpointHealth {
  url: string | null;
  reachable: boolean;
  /** CTL-1050: the SHARED severity from the service-health registry tracker.
   *  `reachable` stays for backward compatibility (down ⇒ false, else true), but
   *  `severity` carries the proportional up|degraded|down|unknown the CTL-1039
   *  banner/headline gate on (banner only on "down", "degraded" → reconnecting…). */
  severity?: ServiceSeverity;
}

export interface OtelHealth {
  configured: boolean;
  prometheus: EndpointHealth;
  loki: EndpointHealth;
}

/** A registry tracker the otel-health checker reads severity from, so there is
 *  exactly ONE severity model. Returns the current severity for an endpoint, or
 *  null when the registry hasn't resolved that entry yet (falls back to probe). */
export interface SeverityTracker {
  lokiSeverity(): ServiceSeverity | null;
  prometheusSeverity(): ServiceSeverity | null;
}

interface OtelHealthCheckerOptions {
  prometheusUrl: string | null;
  lokiUrl: string | null;
  fetcher?: Fetcher;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** CTL-1050: when present, `reachable` + `severity` come from the registry
   *  tracker (the single severity model) rather than this checker's own binary
   *  probe. The inner probe still runs as the fallback before the registry
   *  resolves an entry. */
  severityTracker?: SeverityTracker | null;
}

export interface OtelHealthChecker {
  check(): Promise<OtelHealth>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 10_000;
const PROM_PROBE_PATH = "/api/v1/status/buildinfo";
const LOKI_PROBE_PATH = "/ready";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createOtelHealthChecker(
  opts: OtelHealthCheckerOptions,
): OtelHealthChecker {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const prometheusUrl =
    opts.prometheusUrl !== null ? stripTrailingSlashes(opts.prometheusUrl) : null;
  const lokiUrl =
    opts.lokiUrl !== null ? stripTrailingSlashes(opts.lokiUrl) : null;
  const configured = prometheusUrl !== null || lokiUrl !== null;

  let cached: OtelHealth | null = null;
  let cachedAt = 0;

  async function probe(url: string, probePath: string): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, timeoutMs);
    });
    try {
      const fetchPromise = (async (): Promise<boolean> => {
        try {
          const res = await doFetch(`${url}${probePath}`, { signal: controller.signal });
          return res.ok;
        } catch {
          return false;
        }
      })();
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  const tracker = opts.severityTracker ?? null;

  /** Map a registry severity to the legacy binary reachable. down/unknown ⇒
   *  unreachable-ish, but only `down` should drive the DARK banner — so reachable
   *  is true for up|degraded|unknown and false ONLY for down (CTL-1039: a single
   *  blip / degraded never reads as unreachable). */
  function reachableFromSeverity(sev: ServiceSeverity): boolean {
    return sev !== "down";
  }

  async function runProbe(): Promise<OtelHealth> {
    // When the registry tracker is wired, derive reachable + severity from the
    // SHARED model (the single severity model). Fall back to the inner probe for
    // any endpoint the registry hasn't resolved yet (severity null).
    const trackedLoki = tracker?.lokiSeverity() ?? null;
    const trackedProm = tracker?.prometheusSeverity() ?? null;

    const needLokiProbe = lokiUrl !== null && trackedLoki === null;
    const needPromProbe = prometheusUrl !== null && trackedProm === null;

    const [promReachable, lokiReachable] = await Promise.all([
      needPromProbe ? probe(prometheusUrl as string, PROM_PROBE_PATH) : Promise.resolve(false),
      needLokiProbe ? probe(lokiUrl as string, LOKI_PROBE_PATH) : Promise.resolve(false),
    ]);

    // The `severity` field is added ONLY when the registry tracker is wired — so
    // a bare checker (no tracker) keeps its exact legacy { url, reachable } shape
    // (backward compatible). With a tracker, severity is the shared model's value,
    // falling back to the inner probe for an entry the registry hasn't resolved.
    const lokiSeverity: ServiceSeverity | undefined =
      tracker === null || lokiUrl === null
        ? undefined
        : (trackedLoki ?? (lokiReachable ? "up" : "down"));
    const promSeverity: ServiceSeverity | undefined =
      tracker === null || prometheusUrl === null
        ? undefined
        : (trackedProm ?? (promReachable ? "up" : "down"));

    return {
      configured,
      prometheus: {
        url: prometheusUrl,
        reachable:
          prometheusUrl === null
            ? false
            : promSeverity !== undefined
              ? reachableFromSeverity(promSeverity)
              : promReachable,
        ...(promSeverity !== undefined ? { severity: promSeverity } : {}),
      },
      loki: {
        url: lokiUrl,
        reachable:
          lokiUrl === null
            ? false
            : lokiSeverity !== undefined
              ? reachableFromSeverity(lokiSeverity)
              : lokiReachable,
        ...(lokiSeverity !== undefined ? { severity: lokiSeverity } : {}),
      },
    };
  }

  return {
    async check() {
      const now = Date.now();
      if (cached && now - cachedAt < cacheTtlMs) {
        return cached;
      }
      const result = await runProbe();
      cached = result;
      cachedAt = now;
      return result;
    },
  };
}
