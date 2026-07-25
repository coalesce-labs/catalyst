// Types for process-memory-metric.mjs (CTL-1517) — the runtime stays .mjs so the
// broker/execution-core .mjs daemons import it unchanged; this gives the TS consumers
// (orch-monitor/server.ts, otel-forward/index.ts) proper types. Mirrors the
// daemon-heartbeat.d.mts convention.

export interface ProcessMemoryLogger {
  warn?: (obj: unknown, msg: string) => void;
}

export interface EmitProcessMemoryMetricOptions {
  /** catalyst.* service name (required) → resource service.name */
  serviceName: string;
  /** the daemon's logger — threaded so the no-op is loud (warn-once) */
  log?: ProcessMemoryLogger;
  /** endpoint-resolution env (default process.env) */
  env?: Record<string, string | undefined>;
  /** injectable fetch (default global fetch) */
  fetchImpl?: typeof fetch;
  /** optional host override for the resource */
  host?: string;
  /** injectable epoch-ms clock (default Date.now) */
  now?: () => number;
  /** POST abort budget in ms (default 5000) */
  timeoutMs?: number;
}

export function resolveCollectorBase(env?: Record<string, string | undefined>): string | null;

export function buildProcessMemoryMetricsPayload(spec: {
  serviceName: string;
  memoryUsage: NodeJS.MemoryUsage;
  pid: number;
  timeUnixNano: string | number;
  host?: string;
}): unknown;

export function emitProcessMemoryMetric(opts: EmitProcessMemoryMetricOptions): Promise<boolean>;

export function __resetProcessMemoryMetricState(): void;
