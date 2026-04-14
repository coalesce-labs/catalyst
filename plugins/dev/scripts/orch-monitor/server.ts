import { join, resolve as resolvePath, sep } from "path";
import { realpathSync, writeFileSync, unlinkSync } from "fs";
import { subscribe } from "./lib/event-bus";
import {
  buildSnapshot,
  buildAnalyticsSnapshot,
  type MonitorSnapshot,
  type BuildSnapshotOptions,
  type SessionState,
} from "./lib/state-reader";
import { readSessionStore } from "./lib/session-store";
import { queryHistory, queryStats, compareSessions } from "./lib/history-store";
import { startWatching, type WatcherHandle } from "./lib/watcher";
import {
  createEvent,
  parseFilter,
  matchesFilter,
  EVENT_TYPES,
  type MonitorEventEnvelope,
  type SSEFilter,
} from "./lib/events";
import {
  createPrStatusFetcher,
  parseRepoFromPrUrl,
  type PrRef,
  type PrStatusFetcher,
} from "./lib/pr-status";
import {
  createLinearFetcher,
  type LinearFetcher,
  type LinearTicket,
} from "./lib/linear";

type BunServer = ReturnType<typeof Bun.serve>;

export interface CreateServerOptions {
  port?: number;
  hostname?: string;
  wtDir: string;
  startWatcher?: boolean;
  publicDir?: string;
  pidFile?: string;
  prStatusFetcher?: PrStatusFetcher | null;
  prStatusRefreshMs?: number;
  linearFetcher?: LinearFetcher | null;
  linearRefreshMs?: number;
  /** Path to the SQLite session store. Pass `null` to disable. */
  dbPath?: string | null;
  /** SQLite poll interval for the watcher (ms). */
  sqlitePollIntervalMs?: number;
}

export const DEFAULT_PORT = 7400;
export const PR_STATUS_REFRESH_MS = 30_000;
export const LINEAR_REFRESH_MS = 5 * 60_000;

function collectTicketKeys(snapshot: MonitorSnapshot): string[] {
  const keys = new Set<string>();
  for (const orch of snapshot.orchestrators) {
    for (const worker of Object.values(orch.workers)) {
      if (worker.ticket) keys.add(worker.ticket);
    }
  }
  return Array.from(keys);
}

function collectPrRefs(snapshot: MonitorSnapshot): PrRef[] {
  const refs: PrRef[] = [];
  for (const orch of snapshot.orchestrators) {
    for (const worker of Object.values(orch.workers)) {
      if (!worker.pr) continue;
      const repo = parseRepoFromPrUrl(worker.pr.url);
      if (!repo) continue;
      refs.push({ repo, number: worker.pr.number });
    }
  }
  return refs;
}

function applyPrStatus(
  snapshot: MonitorSnapshot,
  fetcher: PrStatusFetcher,
): MonitorSnapshot {
  for (const orch of snapshot.orchestrators) {
    for (const worker of Object.values(orch.workers)) {
      if (!worker.pr) continue;

      // Fast path: signal-side ciStatus written by oneshot worker on merge.
      if (worker.pr.ciStatus === "merged") {
        worker.prState = "MERGED";
        worker.prMergedAt = worker.pr.mergedAt ?? null;
        if (worker.status !== "merged") worker.status = "merged";
        if (!worker.completedAt) {
          worker.completedAt = worker.pr.mergedAt ?? null;
        }
      }

      // Backstop: gh polling overlays/refines from upstream truth.
      const repo = parseRepoFromPrUrl(worker.pr.url);
      if (!repo) continue;
      const status = fetcher.get(repo, worker.pr.number);
      if (!status) continue;
      worker.prState = status.state;
      worker.prMergedAt = status.mergedAt;
      if (status.state === "MERGED" && worker.status !== "merged") {
        worker.status = "merged";
        if (!worker.completedAt && status.mergedAt) {
          worker.completedAt = status.mergedAt;
        }
      }
    }
  }
  return snapshot;
}
const SSE_EVENTS = EVENT_TYPES;
const ALLOWED_PUBLIC_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".svg",
  ".png",
  ".ico",
]);

function resolveSafeStaticPath(
  publicDir: string,
  relative: string,
): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(publicDir);
  } catch {
    return null;
  }
  const joined = resolvePath(realRoot, relative);
  let realTarget: string;
  try {
    realTarget = realpathSync(joined);
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return null;
  }
  const dot = realTarget.lastIndexOf(".");
  const ext = dot >= 0 ? realTarget.slice(dot).toLowerCase() : "";
  if (!ALLOWED_PUBLIC_EXTENSIONS.has(ext)) return null;
  return realTarget;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

export function createServer(opts: CreateServerOptions): BunServer {
  const {
    port = DEFAULT_PORT,
    hostname = "0.0.0.0",
    wtDir,
    startWatcher = true,
    publicDir = join(import.meta.dir, "public"),
    pidFile,
    prStatusFetcher,
    prStatusRefreshMs = PR_STATUS_REFRESH_MS,
    linearFetcher,
    linearRefreshMs = LINEAR_REFRESH_MS,
    dbPath = null,
    sqlitePollIntervalMs,
  } = opts;

  const buildOpts: BuildSnapshotOptions = { dbPath };

  const prFetcher: PrStatusFetcher | null =
    prStatusFetcher === null
      ? null
      : (prStatusFetcher ?? createPrStatusFetcher());
  let lastPrRefresh = 0;

  const linear: LinearFetcher | null =
    linearFetcher === null
      ? null
      : (linearFetcher ?? createLinearFetcher());
  let linearStarted = false;

  function snapshotWithPrStatus(): MonitorSnapshot {
    const snap = buildSnapshot(wtDir, buildOpts);
    if (prFetcher) {
      const now = Date.now();
      if (now - lastPrRefresh >= prStatusRefreshMs) {
        lastPrRefresh = now;
        const refs = collectPrRefs(snap);
        if (refs.length > 0) void prFetcher.refreshAll(refs);
      }
      applyPrStatus(snap, prFetcher);
    }
    if (linear && !linearStarted) {
      linearStarted = true;
      linear.start(
        () => collectTicketKeys(buildSnapshot(wtDir, buildOpts)),
        linearRefreshMs,
      );
    }
    return snap;
  }

  const sseClients = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    SSEFilter
  >();
  const encoder = new TextEncoder();

  const unsubscribers: Array<() => void> = [];
  for (const eventType of SSE_EVENTS) {
    unsubscribers.push(
      subscribe(eventType, (data) => {
        const envelope = data as MonitorEventEnvelope;
        const msg = `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
        const bytes = encoder.encode(msg);
        for (const [client, filter] of sseClients) {
          if (!matchesFilter(envelope, filter)) continue;
          try {
            client.enqueue(bytes);
          } catch (err) {
            console.error(`[server] SSE enqueue failed:`, err);
            sseClients.delete(client);
          }
        }
      }),
    );
  }

  let watcher: WatcherHandle | null = null;

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        if (url.pathname === "/events") {
          const filter = parseFilter(url);
          let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              captured = controller;
              sseClients.set(controller, filter);
              try {
                // Initial snapshot always sent regardless of filter to bootstrap client state
                const snapshot = snapshotWithPrStatus();
                const envelope = createEvent("snapshot", snapshot, "filesystem");
                const msg = `event: snapshot\ndata: ${JSON.stringify(envelope)}\n\n`;
                controller.enqueue(encoder.encode(msg));
              } catch (err) {
                console.error(`[server] initial snapshot enqueue failed:`, err);
              }
            },
            cancel() {
              if (captured) sseClients.delete(captured);
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        if (url.pathname === "/api/snapshot") {
          return Response.json(snapshotWithPrStatus());
        }

        if (url.pathname === "/api/analytics") {
          return Response.json(buildAnalyticsSnapshot(wtDir));
        }

        if (url.pathname === "/api/sessions") {
          if (!dbPath) {
            return Response.json({ available: false, sessions: [] });
          }
          const params = url.searchParams;
          const limitRaw = params.get("limit");
          const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
          const result = readSessionStore(dbPath, {
            soloOnly: params.get("solo") === "true",
            workflowId: params.get("workflow") ?? undefined,
            ticket: params.get("ticket") ?? undefined,
            status: params.get("status") ?? undefined,
            limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
          });
          const sessions: SessionState[] = result.sessions;
          return Response.json({ available: result.available, sessions });
        }

        if (url.pathname === "/api/history") {
          if (!dbPath) {
            return Response.json({ entries: [], total: 0 });
          }
          const params = url.searchParams;
          const limitRaw = params.get("limit");
          const offsetRaw = params.get("offset");
          const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
          const parsedOffset = offsetRaw ? Number.parseInt(offsetRaw, 10) : NaN;
          return Response.json(
            queryHistory(dbPath, {
              skill: params.get("skill") ?? undefined,
              ticket: params.get("ticket") ?? undefined,
              since: params.get("since") ?? undefined,
              search: params.get("search") ?? undefined,
              limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
              offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
            }),
          );
        }

        if (url.pathname === "/api/history/stats") {
          if (!dbPath) {
            return Response.json({
              totalSessions: 0,
              totalCostUsd: 0,
              avgCostUsd: 0,
              avgDurationMs: 0,
              successRate: 0,
              skillBreakdown: [],
              dailyCosts: [],
              topTools: [],
            });
          }
          const params = url.searchParams;
          return Response.json(
            queryStats(dbPath, {
              skill: params.get("skill") ?? undefined,
              since: params.get("since") ?? undefined,
            }),
          );
        }

        if (url.pathname === "/api/history/compare") {
          if (!dbPath) {
            return Response.json(null);
          }
          const params = url.searchParams;
          const a = params.get("a");
          const b = params.get("b");
          if (!a || !b) {
            return new Response("Missing ?a=<id>&b=<id>", { status: 400 });
          }
          const result = compareSessions(dbPath, a, b);
          if (!result) {
            return new Response("Session(s) not found", { status: 404 });
          }
          return Response.json(result);
        }

        if (url.pathname === "/api/linear") {
          const tickets: Record<string, LinearTicket> = {};
          if (linear) {
            for (const key of collectTicketKeys(buildSnapshot(wtDir))) {
              const t = linear.get(key);
              if (t) tickets[key] = t;
            }
          }
          return Response.json({ tickets });
        }

        if (
          url.pathname === "/" ||
          url.pathname === "/index.html" ||
          url.pathname === "/history"
        ) {
          const htmlFile =
            url.pathname === "/history" ? "history.html" : "index.html";
          const file = Bun.file(join(publicDir, htmlFile));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response(`${htmlFile} not found`, { status: 500 });
        }


        if (url.pathname.startsWith("/public/")) {
          const rel = decodeURIComponent(url.pathname.slice("/public/".length));
          const safe = resolveSafeStaticPath(publicDir, rel);
          if (!safe) return new Response("Forbidden", { status: 403 });
          const file = Bun.file(safe);
          if (await file.exists()) {
            const dot = safe.lastIndexOf(".");
            const ext = dot >= 0 ? safe.slice(dot).toLowerCase() : "";
            return new Response(file, {
              headers: { "Content-Type": contentTypeForExt(ext) },
            });
          }
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error(`[server] fetch handler error:`, err);
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  });

  if (startWatcher) {
    watcher = startWatching(wtDir, { dbPath, sqlitePollIntervalMs });
  }

  if (pidFile) {
    try {
      writeFileSync(pidFile, `${process.pid}\n`);
    } catch (err) {
      console.error(`[server] failed to write PID file ${pidFile}:`, err);
    }
  }

  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    for (const u of unsubscribers) u();
    watcher?.stop();
    prFetcher?.stop();
    linear?.stop();
    sseClients.clear();
    if (pidFile) {
      try {
        unlinkSync(pidFile);
      } catch (err: unknown) {
        if (
          !(err instanceof Error) ||
          !("code" in err) ||
          (err as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          console.warn(`[server] failed to remove PID file:`, err);
        }
      }
    }
    return originalStop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const CATALYST_DIR =
    process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;
  const WT_DIR = `${CATALYST_DIR}/wt`;
  const parsedPort = parseInt(process.env.MONITOR_PORT ?? "", 10);
  const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const DB_PATH =
    process.env.CATALYST_DB_FILE ?? `${CATALYST_DIR}/catalyst.db`;

  const pidFileIdx = process.argv.indexOf("--pid-file");
  let pidFilePath: string | undefined;
  if (pidFileIdx >= 0) {
    pidFilePath = process.argv[pidFileIdx + 1];
    if (!pidFilePath || pidFilePath.startsWith("--")) {
      console.error("[server] --pid-file requires a path argument");
      process.exit(1);
    }
  }

  const srv = createServer({ port: PORT, wtDir: WT_DIR, dbPath: DB_PATH, pidFile: pidFilePath });
  const displayHost =
    srv.hostname === "0.0.0.0" ? "localhost" : String(srv.hostname);
  console.info(`Monitor running at http://${displayHost}:${srv.port}`);
  console.info(`(bound on ${String(srv.hostname)}:${srv.port}; watching ${WT_DIR})`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.info(`[server] received ${sig}, shutting down`);
      void srv.stop(true);
      process.exit(0);
    });
  }
}
