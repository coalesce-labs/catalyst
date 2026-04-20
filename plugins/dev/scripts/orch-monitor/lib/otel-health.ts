export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface EndpointHealth {
  url: string | null;
  reachable: boolean;
}

export interface OtelHealth {
  configured: boolean;
  prometheus: EndpointHealth;
  loki: EndpointHealth;
}

interface OtelHealthCheckerOptions {
  prometheusUrl: string | null;
  lokiUrl: string | null;
  fetcher?: Fetcher;
  timeoutMs?: number;
  cacheTtlMs?: number;
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

  async function runProbe(): Promise<OtelHealth> {
    const [promReachable, lokiReachable] = await Promise.all([
      prometheusUrl !== null ? probe(prometheusUrl, PROM_PROBE_PATH) : Promise.resolve(false),
      lokiUrl !== null ? probe(lokiUrl, LOKI_PROBE_PATH) : Promise.resolve(false),
    ]);

    return {
      configured,
      prometheus: { url: prometheusUrl, reachable: promReachable },
      loki: { url: lokiUrl, reachable: lokiReachable },
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
