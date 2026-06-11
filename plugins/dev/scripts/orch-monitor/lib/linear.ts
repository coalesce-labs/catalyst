import { readLinearCache } from "./linear-cache-reader.mjs";
import type {
  LinearCacheById,
  ReadLinearCacheOptions,
} from "./linear-cache-reader.d.mts";

export interface LinearTicket {
  key: string;
  title: string;
  url: string;
  state: string;
  project: string | null;
  labels: string[];
  fetchedAt: string;
}

export type Runner = (
  args: string[],
) => Promise<{ stdout: string; ok: boolean }>;

const LINEAR_BASE_URL = "https://linear.app/issue";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

export interface LinearFetcher {
  get(key: string): LinearTicket | null;
  refreshAll(keys: string[]): Promise<void>;
  start(keysProvider: () => string[], intervalMs: number): void;
  stop(): void;
  /**
   * On-demand refresh of a single ticket. CTL-211 — wired up to
   * `linear.issue.*` webhook events (CTL-210) so the dashboard reflects
   * state changes within seconds instead of waiting up to 5 minutes for the
   * polling fallback. Returns silently on blank keys, and degrades silently
   * when linearis is unavailable (matches refreshAll behavior).
   */
  invalidate(key: string): Promise<void>;
}

const DEFAULT_CONCURRENCY = 5;

export function parseTicketJson(raw: string): LinearTicket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const identifier = asString(parsed.identifier);
  const title = asString(parsed.title);
  if (!identifier || !title) return null;

  const stateName = isRecord(parsed.state)
    ? asString(parsed.state.name, "")
    : "";

  let projectName: string | null = null;
  if (isRecord(parsed.project)) {
    const n = asString(parsed.project.name, "");
    projectName = n || null;
  }

  const labels: string[] = [];
  if (isRecord(parsed.labels) && Array.isArray(parsed.labels.nodes)) {
    for (const node of parsed.labels.nodes) {
      if (isRecord(node)) {
        const name = asString(node.name, "");
        if (name) labels.push(name);
      }
    }
  }

  const url = asString(
    parsed.url,
    `${LINEAR_BASE_URL}/${encodeURIComponent(identifier)}`,
  );

  return {
    key: identifier,
    title,
    url,
    state: stateName,
    project: projectName,
    labels,
    fetchedAt: new Date().toISOString(),
  };
}

async function defaultRunner(
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const proc = Bun.spawn(["linearis", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return { stdout, ok: exit === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const slots = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < slots; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          const item = items[idx];
          if (item === undefined) return;
          await worker(item as T);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export function createLinearFetcher(
  opts: { runner?: Runner; concurrency?: number } = {},
): LinearFetcher {
  const runner = opts.runner ?? defaultRunner;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const cache = new Map<string, LinearTicket>();
  let available: boolean | null = null;
  let warned = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    try {
      const res = await runner(["--version"]);
      available = res.ok;
    } catch {
      available = false;
    }
    if (!available && !warned) {
      warned = true;
      console.warn(
        "[linear] linearis CLI unavailable; ticket metadata disabled",
      );
    }
    return available;
  }

  async function fetchOne(key: string): Promise<void> {
    let res: { stdout: string; ok: boolean };
    try {
      res = await runner(["issues", "read", key]);
    } catch (err) {
      console.error(`[linear] runner threw for ${key}:`, err);
      return;
    }
    if (!res.ok || !res.stdout) return;
    const ticket = parseTicketJson(res.stdout);
    if (!ticket) {
      console.warn(`[linear] unrecognized JSON shape for ${key}`);
      return;
    }
    cache.set(ticket.key, ticket);
  }

  async function refreshAll(keys: string[]): Promise<void> {
    const unique = Array.from(new Set(keys.filter((k) => k && k.trim())));
    if (unique.length === 0) return;
    if (!(await probe())) return;
    await runWithConcurrencyLimit(unique, concurrency, fetchOne);
  }

  return {
    get(key) {
      return cache.get(key) ?? null;
    },
    refreshAll,
    start(keysProvider, intervalMs) {
      void refreshAll(keysProvider());
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void refreshAll(keysProvider());
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async invalidate(key: string) {
      const trimmed = (key ?? "").trim();
      if (trimmed.length === 0) return;
      if (!(await probe())) return;
      await fetchOne(trimmed);
    },
  };
}

// ── BFF9 / CTL-921 ──────────────────────────────────────────────────────────
// Cache-backed LinearFetcher. The legacy createLinearFetcher above polls
// `linearis issues read <key>` live into memory, started at server.ts:768 and
// serving the legacy /api/linear and /api/briefing routes. That second live
// path kept counting against Linear's 2500/hr cap and contradicted BFF1's
// (CTL-883) "no synchronous Linear call on any request path" guarantee — which
// BFF1 only enforced for board-data.mjs::linearInfo(). This factory re-points
// those routes at the SAME durable source BFF1 unified board reads onto:
// readLinearCache() over ~/catalyst/filter-state.db ticket_state (+ the
// scheduler's eligible projection as a gap-filler). It spawns NOTHING, so an
// OPEN linear-breaker can never be tripped here and the execution-core breaker
// is honored by construction (the read is always served from cache).

export type LinearCacheReader = (
  opts?: ReadLinearCacheOptions,
) => Promise<LinearCacheById>;

export interface CacheBackedLinearFetcherOptions {
  /** Override the durable-cache reader (defaults to the real readLinearCache). */
  cacheReader?: LinearCacheReader;
  /** filter-state.db path forwarded to the cache reader (defaults to the real one). */
  dbPath?: string;
  /** eligible-projection dir forwarded to the cache reader (defaults to the real one). */
  eligibleDir?: string;
}

// Build a LinearTicket from a durable-cache entry. The cache carries
// state/labels (ticket_state) + project/title (eligible projection) but NOT a
// url (no durable source) — so the canonical Linear issue url is derived from
// the key. Missing title/state degrade to the empty string the legacy fetcher
// would also have produced for a half-populated payload; the consumers
// (/api/briefing's prompt builder, /api/linear's JSON) tolerate that.
function cacheEntryToTicket(
  key: string,
  entry: LinearCacheById[string],
  fetchedAt: string,
): LinearTicket {
  return {
    key,
    title: asString(entry.title, ""),
    url: `${LINEAR_BASE_URL}/${encodeURIComponent(key)}`,
    state: asString(entry.linearState, ""),
    project: entry.project ?? null,
    labels: Array.isArray(entry.labels) ? entry.labels.filter(Boolean) : [],
    fetchedAt,
  };
}

export function createCacheBackedLinearFetcher(
  opts: CacheBackedLinearFetcherOptions = {},
): LinearFetcher {
  const cacheReader = opts.cacheReader ?? readLinearCache;
  const readerOpts: ReadLinearCacheOptions = {};
  if (opts.dbPath !== undefined) readerOpts.dbPath = opts.dbPath;
  if (opts.eligibleDir !== undefined) readerOpts.eligibleDir = opts.eligibleDir;

  let byId: LinearCacheById = {};
  let fetchedAt = new Date(0).toISOString();
  let timer: ReturnType<typeof setInterval> | null = null;

  // Reload the entire durable cache in one pass. The legacy fetcher refreshed
  // per-key via N `linearis` spawns; the broker already maintains the whole
  // ticket_state table, so a single bulk read replaces all of them. Never
  // throws: the real readLinearCache already degrades a locked/absent DB to {},
  // but we also swallow here so the read-model never blocks on enrichment — a
  // failed reload leaves the previous snapshot in place. The keys argument is
  // intentionally ignored: the bulk read covers every key.
  async function reload(): Promise<void> {
    try {
      const next = await cacheReader(readerOpts);
      byId = next ?? {};
      fetchedAt = new Date().toISOString();
    } catch {
      // keep the last good snapshot; degrade silently (CTL-883 contract)
    }
  }

  return {
    get(key) {
      const entry = byId[key];
      if (!entry) return null; // cache miss → partial/empty, never a live fan-out
      return cacheEntryToTicket(key, entry, fetchedAt);
    },
    async refreshAll(_keys) {
      await reload();
    },
    start(_keysProvider, intervalMs) {
      void reload();
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void reload();
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async invalidate(key: string) {
      // Webhook-driven freshness: the broker has already written the new state
      // into ticket_state by the time this fires, so a cheap bulk reload picks
      // it up. No `linearis` spawn — blank keys are still a no-op for parity
      // with the legacy fetcher's invalidate contract.
      const trimmed = (key ?? "").trim();
      if (trimmed.length === 0) return;
      await reload();
    },
  };
}
