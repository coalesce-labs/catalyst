import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LokiClientOpts {
  endpoint: string;
  timeoutMs?: number;
}

// Interface for dependency injection in tests.
export interface ILokiClient {
  queryEventNames(service: string, windowHours: number): Promise<Map<string, number>>;
}

function readWorkspaceConfig(): Record<string, unknown> {
  try {
    const path = join(homedir(), ".config/catalyst/config-catalyst-workspace.json");
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getLokiEndpoint(): string {
  const cfg = readWorkspaceConfig();
  const obs = (cfg.catalyst as Record<string, unknown>)?.observability as Record<string, unknown>;
  return (obs?.lokiEndpoint as string) ?? "http://localhost:3100";
}

export class LokiClient implements ILokiClient {
  private endpoint: string;
  private timeoutMs: number;

  constructor(opts?: Partial<LokiClientOpts>) {
    this.endpoint = opts?.endpoint ?? getLokiEndpoint();
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async queryEventNames(service: string, windowHours: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const end = Math.floor(Date.now() / 1000);
    const start = end - windowHours * 3600;

    const query = `sum by (event_name) (count_over_time({service_name="${service}"} | json | __error__="" [${windowHours}h]))`;
    const url = new URL("/loki/api/v1/query_range", this.endpoint);
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(start));
    url.searchParams.set("end", String(end));
    url.searchParams.set("limit", "5000");

    try {
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return counts;
      const body = (await res.json()) as {
        data?: {
          result?: Array<{
            metric?: Record<string, string>;
            values?: Array<[number, string]>;
          }>;
        };
      };
      for (const stream of body?.data?.result ?? []) {
        const name = stream.metric?.event_name;
        if (!name) continue;
        // sum the values in the time-range result
        const total = (stream.values ?? []).reduce((acc, [, v]) => acc + Number(v), 0);
        if (total > 0) counts.set(name, total);
      }
    } catch {
      // Network unavailable — return empty, caller will show MISSING
    }
    return counts;
  }
}
