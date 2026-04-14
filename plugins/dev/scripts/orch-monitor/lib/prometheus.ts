export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PrometheusMetricValue {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

export interface PrometheusQueryResult {
  data: {
    resultType: string;
    result: PrometheusMetricValue[];
  };
}

export interface PrometheusFetcher {
  query(promql: string, time?: string): Promise<PrometheusQueryResult | null>;
  queryRange(
    promql: string,
    start: string,
    end: string,
    step: string,
  ): Promise<PrometheusQueryResult | null>;
  isAvailable(): boolean;
}

interface CacheEntry {
  data: PrometheusQueryResult;
  fetchedAt: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 200;

export function createPrometheusFetcher(opts: {
  baseUrl: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): PrometheusFetcher {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  const cache = new Map<string, CacheEntry>();
  let available: boolean | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    try {
      const res = await doFetch(`${baseUrl}/api/v1/status/buildinfo`);
      available = res.ok;
    } catch {
      available = false;
    }
    if (!available) {
      console.warn("[prometheus] Prometheus unavailable — OTel metrics disabled");
    }
    return available;
  }

  async function doQuery(url: string): Promise<PrometheusQueryResult | null> {
    if (!(await probe())) return null;

    const cached = cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      return cached.data;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await doFetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return null;

      const body = (await res.json()) as {
        status?: string;
        data?: PrometheusQueryResult["data"];
      };
      if (body.status !== "success" || !body.data) return null;

      const result: PrometheusQueryResult = { data: body.data };
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(url, { data: result, fetchedAt: Date.now() });
      return result;
    } catch {
      return null;
    }
  }

  return {
    async query(promql, time) {
      const params = new URLSearchParams({ query: promql });
      if (time) params.set("time", time);
      return doQuery(`${baseUrl}/api/v1/query?${params.toString()}`);
    },

    async queryRange(promql, start, end, step) {
      const params = new URLSearchParams({
        query: promql,
        start,
        end,
        step,
      });
      return doQuery(`${baseUrl}/api/v1/query_range?${params.toString()}`);
    },

    isAvailable() {
      return available === true;
    },
  };
}
