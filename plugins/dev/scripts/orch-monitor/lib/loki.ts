export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface LokiStreamValue {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

export interface LokiMetricValue {
  metric: Record<string, string>;
  values?: Array<[number, string]>;
  value?: [number, string];
}

export interface LokiQueryResult {
  data: {
    resultType: string;
    result: Array<LokiStreamValue | LokiMetricValue>;
  };
}

export interface LokiFetcher {
  queryRange(
    logql: string,
    start: string,
    end: string,
    limit?: number,
  ): Promise<LokiQueryResult | null>;
  isAvailable(): boolean;
}

interface CacheEntry {
  data: LokiQueryResult;
  fetchedAt: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_LIMIT = 1000;
const MAX_CACHE_ENTRIES = 200;

export function createLokiFetcher(opts: {
  baseUrl: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): LokiFetcher {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  const cache = new Map<string, CacheEntry>();
  let available: boolean | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    try {
      const res = await doFetch(`${baseUrl}/ready`);
      available = res.ok;
    } catch {
      available = false;
    }
    if (!available) {
      console.warn("[loki] Loki unavailable — log queries disabled");
    }
    return available;
  }

  return {
    async queryRange(logql, start, end, limit) {
      if (!(await probe())) return null;

      const params = new URLSearchParams({
        query: logql,
        start,
        end,
        limit: String(limit ?? DEFAULT_LIMIT),
      });
      const url = `${baseUrl}/loki/api/v1/query_range?${params.toString()}`;

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
          data?: LokiQueryResult["data"];
        };
        if (body.status !== "success" || !body.data) return null;

        const result: LokiQueryResult = { data: body.data };
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(url, { data: result, fetchedAt: Date.now() });
        return result;
      } catch {
        return null;
      }
    },

    isAvailable() {
      return available === true;
    },
  };
}
