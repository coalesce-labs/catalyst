// service-health-monitor.ts — the SERVER-side stateful poller behind the
// service-health registry (CTL-1050). It holds a ServiceStatus per descriptor in
// memory, runs the probes/evals on the registry interval, and exposes the
// snapshot the /api/health/services route + the otel-health rewire + the outage
// emitter + the inbox decoration all read. The PURE transition logic lives in
// service-health.ts; this module owns only the I/O (HTTP probe, event-log
// recency read) and the tick loop.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type ProbeResult,
  type ServiceDescriptor,
  type ServiceHealthConfig,
  type ServiceId,
  type ServiceStatus,
  applyProbeResult,
  buildRegistry,
  initialStatus,
  DEFAULT_TIMEOUT_MS,
} from "./service-health";

export type { ServiceHealthConfig, ServiceStatus } from "./service-health";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ServiceHealthSnapshot {
  generatedAt: number;
  services: ServiceStatus[];
}

export interface ServiceHealthMonitorOpts {
  config: ServiceHealthConfig;
  /** ~/catalyst dir; event log at {catalystDir}/events/YYYY-MM.jsonl. */
  catalystDir: string;
  fetcher?: Fetcher;
  now?: () => number;
  /** Injectable event-recency reader (tests). Returns age (ms) of the newest
   *  matching emission, or null when none found. */
  recencyReader?: (matcher: RecencyMatcher) => number | null;
  /** Override the inner probe-cache TTL (default 10s — the same TTL otel-health
   *  used; the 30s registry tick is the counter clock). */
  probeCacheTtlMs?: number;
  /** Called after every full tick with the fresh snapshot — the outage emitter
   *  subscribes here so transitions drive the event log + inbox. */
  onTick?: (snapshot: ServiceHealthSnapshot) => void;
  startedAt?: number;
}

/** What to match in the event log for an event-recency service. */
export interface RecencyMatcher {
  /** Match Resource["service.name"] exactly. */
  serviceName?: string;
  /** Match attributes["event.name"] prefix (e.g. "catalyst.heartbeat"). */
  eventNamePrefix?: string;
}

/** Probe one URL, returning ok + latency. Reuses the timeout/abort mechanics
 *  otel-health.ts pioneered (its `probe()` becomes this executor). */
async function probeUrl(
  doFetch: Fetcher,
  url: string,
  timeoutMs: number,
  now: () => number,
): Promise<{ ok: boolean; latencyMs: number | null; detail: string | null }> {
  const controller = new AbortController();
  const started = now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, timedOut: true });
    }, timeoutMs);
  });
  try {
    const fetchPromise = (async (): Promise<{
      ok: boolean;
      timedOut: false;
      status?: number;
      err?: string;
    }> => {
      try {
        const res = await doFetch(url, { signal: controller.signal });
        return { ok: res.ok, timedOut: false, status: res.status };
      } catch (e) {
        return {
          ok: false,
          timedOut: false,
          err: e instanceof Error ? e.message : String(e),
        };
      }
    })();
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    const latencyMs = now() - started;
    if ("timedOut" in result && result.timedOut) {
      return { ok: false, latencyMs: null, detail: `timeout after ${timeoutMs}ms` };
    }
    if (result.ok) return { ok: true, latencyMs, detail: null };
    const r = result as { status?: number; err?: string };
    const detail =
      r.err !== undefined
        ? `fetch error: ${r.err}`
        : r.status !== undefined
          ? `HTTP ${r.status}`
          : "probe failed";
    return { ok: false, latencyMs: null, detail };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Read the age (ms) of the newest event-log line matching `matcher`. Scans the
 *  current monthly file tail (cheap — counts/timestamps only, no jq). Returns
 *  null when no match is found. */
export function readEmissionAge(
  catalystDir: string,
  matcher: RecencyMatcher,
  now: number,
): number | null {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const path = join(catalystDir, "events", `${y}-${m}.jsonl`);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    // Read only the tail of the file — daemon heartbeats are frequent so the
    // newest match is near the end. Cap at 512KB to bound the read.
    const size = statSync(path).size;
    const readFrom = Math.max(0, size - 512 * 1024);
    text = readFileSync(path, "utf8");
    if (readFrom > 0) {
      text = text.slice(readFrom);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let newestTs: number | null = null;
  // Track the MAX timestamp across all matching lines — the on-disk order is
  // append order, which is usually but not guaranteed monotonic by ts, so we take
  // the genuine newest by timestamp rather than the last file position.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const resource = evt.resource as Record<string, unknown> | undefined;
    const attrs = evt.attributes as Record<string, unknown> | undefined;
    if (matcher.serviceName !== undefined) {
      const sn = resource ? resource["service.name"] : undefined;
      if (sn !== matcher.serviceName) continue;
    }
    if (matcher.eventNamePrefix !== undefined) {
      const en = attrs ? attrs["event.name"] : undefined;
      if (typeof en !== "string" || !en.startsWith(matcher.eventNamePrefix)) continue;
    }
    const ts = typeof evt.ts === "string" ? Date.parse(evt.ts) : NaN;
    if (Number.isFinite(ts) && (newestTs === null || ts > newestTs)) {
      newestTs = ts;
    }
  }
  if (newestTs === null) return null;
  return Math.max(0, now - newestTs);
}

/** Per-service recency matcher for event-recency entries. */
const RECENCY_MATCHERS: Partial<Record<ServiceId, RecencyMatcher>> = {
  broker: { serviceName: "broker" },
  "execution-core": { serviceName: "execution-core" },
};

export interface ServiceHealthMonitor {
  /** Run one tick immediately (all entries). Resolves once statuses are updated. */
  tick(): Promise<void>;
  /** The current in-memory snapshot. */
  snapshot(): ServiceHealthSnapshot;
  /** Start the interval loop (runs an immediate tick first). */
  start(): void;
  /** Stop the interval loop. */
  stop(): void;
  /** The live descriptors (target/configSource for the hover). */
  registry(): ServiceDescriptor[];
}

export function createServiceHealthMonitor(
  opts: ServiceHealthMonitorOpts,
): ServiceHealthMonitor {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const probeCacheTtlMs = opts.probeCacheTtlMs ?? 10_000;
  const registry = buildRegistry(opts.config);
  const statuses = new Map<ServiceId, ServiceStatus>();
  for (const d of registry) statuses.set(d.id, initialStatus(d));

  // Inner per-URL probe cache (the 10s TTL otel-health kept). The registry tick
  // is the 30s counter clock; this just dedupes a burst of reads on one URL.
  const probeCache = new Map<
    string,
    { at: number; ok: boolean; latencyMs: number | null; detail: string | null }
  >();

  let timer: ReturnType<typeof setInterval> | null = null;
  const startedAt = opts.startedAt ?? now();

  async function probeWithCache(
    url: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; latencyMs: number | null; detail: string | null }> {
    const t = now();
    const cached = probeCache.get(url);
    if (cached && t - cached.at < probeCacheTtlMs) {
      return { ok: cached.ok, latencyMs: cached.latencyMs, detail: cached.detail };
    }
    const result = await probeUrl(doFetch, url, timeoutMs, now);
    probeCache.set(url, { at: t, ...result });
    return result;
  }

  function readRecency(matcher: RecencyMatcher): number | null {
    if (opts.recencyReader) return opts.recencyReader(matcher);
    return readEmissionAge(opts.catalystDir, matcher, now());
  }

  async function evalOne(d: ServiceDescriptor): Promise<ProbeResult> {
    // Unconfigured ⇒ unknown forever (excluded from outage events).
    if (d.target === null) {
      return { kind: d.kind, forcedSeverity: "unknown", detail: "not configured" };
    }

    if (d.kind === "self") {
      if (d.id === "monitor") {
        // This process answered ⇒ up. Degraded only when event-log writes fail
        // (the monitor wires that signal in via onTick consumers; here = up).
        return { kind: "self", ok: true, latencyMs: 0, detail: null };
      }
      // webhook: configured (target != null reached here) ⇒ up.
      return { kind: "self", ok: true, latencyMs: 0, detail: null };
    }

    if (d.kind === "probe-url") {
      const r = await probeWithCache(d.target, d.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return { kind: "probe-url", ok: r.ok, latencyMs: r.latencyMs, detail: r.detail };
    }

    // event-recency.
    if (d.id === "otel-collector") {
      // Collector recency fallback = Loki ingest freshness. If LOKI itself is
      // down we cannot infer the collector → unknown (no cascade red).
      const lokiStatus = statuses.get("loki");
      if (lokiStatus && lokiStatus.severity === "down") {
        return {
          kind: "event-recency",
          forcedSeverity: "unknown",
          detail: "inferred from telemetry ingest — Loki unreachable",
        };
      }
      const age = readRecency({ serviceName: "claude-code" });
      return { kind: "event-recency", ageMs: age };
    }

    const matcher = RECENCY_MATCHERS[d.id];
    if (matcher) {
      const age = readRecency(matcher);
      return { kind: "event-recency", ageMs: age };
    }
    // No matcher → unknown (never red).
    return { kind: "event-recency", forcedSeverity: "unknown" };
  }

  async function tick(): Promise<void> {
    const t = now();
    // Probe-url + recency are independent EXCEPT the collector fallback reads the
    // loki status — so evaluate probe-url entries first, then recency.
    const probeEntries = registry.filter((d) => d.kind === "probe-url");
    const otherEntries = registry.filter((d) => d.kind !== "probe-url");

    await Promise.all(
      probeEntries.map(async (d) => {
        const result = await evalOne(d);
        const prev = statuses.get(d.id);
        if (prev) statuses.set(d.id, applyProbeResult(prev, d, result, t));
      }),
    );
    await Promise.all(
      otherEntries.map(async (d) => {
        const result = await evalOne(d);
        const prev = statuses.get(d.id);
        if (prev) statuses.set(d.id, applyProbeResult(prev, d, result, t));
      }),
    );

    opts.onTick?.(snapshot());
  }

  function snapshot(): ServiceHealthSnapshot {
    return {
      generatedAt: now(),
      // Stable registry order.
      services: registry.map((d) => statuses.get(d.id)!),
    };
  }

  void startedAt; // reserved for monitor uptime detail (future)

  return {
    tick,
    snapshot,
    registry: () => registry,
    start() {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), Math.min(...registry.map((d) => d.intervalMs)));
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
