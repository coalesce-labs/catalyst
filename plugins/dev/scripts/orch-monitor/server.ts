import { join, resolve as resolvePath, sep, dirname, basename } from "path";
import { realpathSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { subscribe } from "./lib/event-bus";
import {
  buildSnapshot,
  buildAnalyticsSnapshot,
  buildSessionDetail,
  type MonitorSnapshot,
  type BuildSnapshotOptions,
  type SessionState,
} from "./lib/state-reader";
import { readSessionStore } from "./lib/session-store";
import { queryHistory, queryStats, compareSessions } from "./lib/history-store";
import { startWatching, type WatcherHandle } from "./lib/watcher";
import { readRecentStreamEvents } from "./lib/stream-reader";
import {
  sessionIdFromPid,
  readWorkerTasks,
  getTaskDiagnostic,
} from "./lib/task-reader";
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
import type { BriefingProvider } from "./lib/ai-briefing";
import {
  createPreviewFetcher,
  type PreviewFetcher,
} from "./lib/preview-status";
import { writeMergedSignalFile } from "./lib/signal-writer";
import { loadOtelConfig } from "./lib/otel-config";
import {
  createPrometheusFetcher,
  type PrometheusFetcher,
} from "./lib/prometheus";
import { createLokiFetcher, type LokiFetcher } from "./lib/loki";
import {
  createOtelHealthChecker,
  type OtelHealthChecker,
} from "./lib/otel-health";
import {
  costByTicket,
  tokensByType,
  cacheHitRate,
  costRateByModel,
  toolUsageByName,
  apiErrors,
  costValidation,
} from "./lib/otel-queries";
import {
  openDb,
  closeDb,
  getAllAnnotations,
  getAnnotation,
  setDisplayName,
  addFlag,
  removeFlag,
  addNote,
  removeNote,
  addTag,
  removeTag,
  deleteAnnotation,
} from "./lib/annotations";
import { startTerminalRenderer, type RenderOptions } from "./lib/terminal";

type BunServer = ReturnType<typeof Bun.serve>;

export interface CreateServerOptions {
  port?: number;
  hostname?: string;
  wtDir: string;
  runsDir?: string | null;
  startWatcher?: boolean;
  publicDir?: string;
  pidFile?: string;
  prStatusFetcher?: PrStatusFetcher | null;
  prStatusRefreshMs?: number;
  linearFetcher?: LinearFetcher | null;
  linearRefreshMs?: number;
  dbPath?: string | null;
  sqlitePollIntervalMs?: number;
  briefingProvider?: BriefingProvider | null;
  prometheusUrl?: string | null;
  lokiUrl?: string | null;
  prometheusFetcher?: PrometheusFetcher | null;
  lokiFetcher?: LokiFetcher | null;
  otelHealthChecker?: OtelHealthChecker | null;
  previewFetcher?: PreviewFetcher | null;
  previewRefreshMs?: number;
  annotationsDbPath?: string;
  terminal?: boolean;
  renderOptions?: RenderOptions;
}

const DEFAULT_PORT = 7400;

function resolveVersion(): string {
  const candidates = [
    join(dirname(import.meta.dir), "version.txt"),
    join(dirname(dirname(import.meta.dir)), "version.txt"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8").trim();
    }
  }
  return "unknown";
}

const CATALYST_DEV_VERSION = resolveVersion();
const PR_STATUS_REFRESH_MS = 30_000;
const PREVIEW_REFRESH_MS = 30_000;
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
      if (status.state === "MERGED") {
        // Write-through to the signal file so the dashboard and any downstream
        // consumers of `workers/<ticket>.json` converge on `done` even when
        // the orchestrator's own Phase 4 loop never observed the merge
        // (e.g. the orchestrator agent already exited). Idempotent — skips
        // when the file already reports done+merged with the same mergedAt.
        const signalPath = join(orch.path, "workers", `${worker.ticket}.json`);
        writeMergedSignalFile(signalPath, status.mergedAt);

        if (worker.status !== "merged") {
          worker.status = "merged";
          if (!worker.completedAt && status.mergedAt) {
            worker.completedAt = status.mergedAt;
          }
        }
      }
    }
  }
  return snapshot;
}

function applyPreviewStatus(
  snapshot: MonitorSnapshot,
  fetcher: PreviewFetcher,
): void {
  for (const orch of snapshot.orchestrators) {
    for (const worker of Object.values(orch.workers)) {
      if (!worker.pr) continue;
      const repo = parseRepoFromPrUrl(worker.pr.url);
      if (!repo) continue;
      const links = fetcher.get(repo, worker.pr.number);
      if (links.length > 0) worker.previews = links;
    }
  }
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
    runsDir = null,
    startWatcher = true,
    publicDir = join(import.meta.dir, "public"),
    pidFile,
    prStatusFetcher,
    prStatusRefreshMs = PR_STATUS_REFRESH_MS,
    linearFetcher,
    linearRefreshMs = LINEAR_REFRESH_MS,
    dbPath = null,
    sqlitePollIntervalMs,
    briefingProvider: briefingProviderOpt,
    prometheusUrl,
    lokiUrl,
    prometheusFetcher: promFetcherOpt,
    lokiFetcher: lokiFetcherOpt,
    otelHealthChecker: otelHealthCheckerOpt,
    previewFetcher: previewFetcherOpt,
    previewRefreshMs = PREVIEW_REFRESH_MS,
    annotationsDbPath,
  } = opts;

  const buildOpts: BuildSnapshotOptions = { dbPath, runsDir };

  const CATALYST_DIR =
    process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;
  const annDbPath = annotationsDbPath ?? `${CATALYST_DIR}/annotations.db`;
  try {
    openDb(annDbPath);
  } catch (err) {
    throw new Error(
      `Failed to open annotations database at ${annDbPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

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

  const briefingProvider: BriefingProvider | null =
    briefingProviderOpt === null ? null : (briefingProviderOpt ?? null);

  const prom: PrometheusFetcher | null =
    promFetcherOpt === null
      ? null
      : (promFetcherOpt ?? (prometheusUrl ? createPrometheusFetcher({ baseUrl: prometheusUrl }) : null));

  const loki: LokiFetcher | null =
    lokiFetcherOpt === null
      ? null
      : (lokiFetcherOpt ?? (lokiUrl ? createLokiFetcher({ baseUrl: lokiUrl }) : null));

  const otelHealth: OtelHealthChecker =
    otelHealthCheckerOpt ??
    createOtelHealthChecker({
      prometheusUrl: prometheusUrl ?? null,
      lokiUrl: lokiUrl ?? null,
    });

  const previewFetcher: PreviewFetcher | null =
    previewFetcherOpt === null
      ? null
      : (previewFetcherOpt ?? createPreviewFetcher());
  let lastPreviewRefresh = 0;

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
    if (previewFetcher) {
      const now = Date.now();
      if (now - lastPreviewRefresh >= previewRefreshMs) {
        lastPreviewRefresh = now;
        const refs = collectPrRefs(snap);
        if (refs.length > 0) void previewFetcher.refreshAll(refs);
      }
      applyPreviewStatus(snap, previewFetcher);
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

        if (url.pathname === "/api/version") {
          return Response.json({ version: CATALYST_DEV_VERSION });
        }

        if (url.pathname === "/api/snapshot") {
          return Response.json(snapshotWithPrStatus());
        }

        if (url.pathname === "/api/analytics") {
          return Response.json(buildAnalyticsSnapshot(wtDir, buildOpts));
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

        const sessionMatch = url.pathname.match(
          /^\/api\/session\/([^/]+)\/([^/]+)$/,
        );
        if (sessionMatch) {
          let orchId: string;
          let ticket: string;
          try {
            orchId = decodeURIComponent(sessionMatch[1]);
            ticket = decodeURIComponent(sessionMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            orchId.includes("..") ||
            orchId.includes("\0") ||
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const detail = buildSessionDetail(wtDir, orchId, ticket, { runsDir });
          if (!detail) {
            return new Response("Not Found", { status: 404 });
          }
          if (prFetcher && detail.worker.pr) {
            const repo = parseRepoFromPrUrl(detail.worker.pr.url);
            if (repo) {
              const status = prFetcher.get(repo, detail.worker.pr.number);
              if (status) {
                detail.worker.prState = status.state;
                detail.worker.prMergedAt = status.mergedAt;
              }
            }
          }
          return Response.json(detail);
        }

        const streamMatch = url.pathname.match(
          /^\/api\/worker-stream\/([^/]+)\/([^/]+)$/,
        );
        if (streamMatch) {
          let orchId: string;
          let ticket: string;
          try {
            orchId = decodeURIComponent(streamMatch[1]);
            ticket = decodeURIComponent(streamMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            orchId.includes("..") ||
            orchId.includes("\0") ||
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const maxEventsRaw = url.searchParams.get("limit");
          const maxEvents = maxEventsRaw ? Number.parseInt(maxEventsRaw, 10) : 30;
          const stateReader = await import("./lib/state-reader");
          const scanned = runsDir
            ? stateReader.scanAllOrchestrators({ runsDir, wtDir })
            : stateReader.scanOrchestrators(wtDir);
          const entry = scanned.find((d) => basename(d.path) === orchId);
          if (!entry) {
            return new Response("Not Found", { status: 404 });
          }
          const events = readRecentStreamEvents(
            entry.path,
            ticket,
            Number.isFinite(maxEvents) ? maxEvents : 30,
          );
          return Response.json({ orchId, ticket, events });
        }

        if (url.pathname === "/api/worker-tasks/debug") {
          const pidRaw = url.searchParams.get("pid");
          const sessionIdParam = url.searchParams.get("sessionId");
          if (!pidRaw && !sessionIdParam) {
            return new Response("pid or sessionId required", { status: 400 });
          }
          const diagnostic = getTaskDiagnostic({
            pid: pidRaw ? Number(pidRaw) : undefined,
            sessionId: sessionIdParam ?? undefined,
          });
          return Response.json(diagnostic);
        }

        const taskMatch = url.pathname.match(
          /^\/api\/worker-tasks$/,
        );
        if (taskMatch) {
          const pidRaw = url.searchParams.get("pid");
          const sessionIdParam = url.searchParams.get("sessionId");
          if (!pidRaw && !sessionIdParam) {
            return new Response("pid or sessionId required", { status: 400 });
          }
          const sessionId = sessionIdParam
            || (pidRaw ? sessionIdFromPid(Number(pidRaw)) : null);
          if (!sessionId) {
            return Response.json({ tasks: null });
          }
          const tasks = readWorkerTasks(sessionId);
          return Response.json({ tasks });
        }

        if (url.pathname === "/api/linear") {
          const tickets: Record<string, LinearTicket> = {};
          if (linear) {
            for (const key of collectTicketKeys(buildSnapshot(wtDir, buildOpts))) {
              const t = linear.get(key);
              if (t) tickets[key] = t;
            }
          }
          return Response.json({ tickets });
        }

        if (url.pathname === "/api/briefing") {
          if (!briefingProvider) {
            return Response.json({ enabled: false });
          }
          const snap = snapshotWithPrStatus();
          const tickets: Record<string, LinearTicket> = {};
          if (linear) {
            for (const key of collectTicketKeys(snap)) {
              const t = linear.get(key);
              if (t) tickets[key] = t;
            }
          }
          const result = await briefingProvider.generate(snap, tickets);
          if (!result) {
            return Response.json({ enabled: true, briefing: null });
          }
          return Response.json({
            enabled: true,
            briefing: result.briefing,
            suggestedLabels: result.suggestedLabels,
            generatedAt: result.generatedAt,
          });
        }

        if (url.pathname === "/api/otel/status") {
          return Response.json({
            enabled: prom !== null || loki !== null,
            prometheus: prom ? prom.isAvailable() : false,
            loki: loki ? loki.isAvailable() : false,
          });
        }

        if (url.pathname === "/api/health/otel") {
          const health = await otelHealth.check();
          return Response.json(health);
        }

        if (url.pathname === "/api/otel/cost") {
          if (!prom) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const range = url.searchParams.get("range") ?? "1h";
          const result = await costByTicket(prom, range);
          return Response.json({ data: result });
        }

        if (url.pathname === "/api/otel/tokens") {
          if (!prom) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const range = url.searchParams.get("range") ?? "1h";
          const tokens = await tokensByType(prom, range);
          const hitRate = await cacheHitRate(prom, range);
          return Response.json({ data: { tokens, cacheHitRate: hitRate } });
        }

        if (url.pathname === "/api/otel/cost-rate") {
          if (!prom) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const interval = url.searchParams.get("interval") ?? "5m";
          const result = await costRateByModel(prom, interval);
          return Response.json({ data: result });
        }

        if (url.pathname === "/api/otel/tools") {
          if (!loki) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const range = url.searchParams.get("range") ?? "1h";
          const result = await toolUsageByName(loki, range);
          return Response.json({ data: result });
        }

        if (url.pathname === "/api/otel/errors") {
          if (!loki) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const range = url.searchParams.get("range") ?? "1h";
          const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 50;
          const result = await apiErrors(loki, range, limit);
          return Response.json({ data: result });
        }

        if (url.pathname === "/api/otel/cost-validation") {
          if (!prom) return Response.json({ error: "OTel not configured" }, { status: 503 });
          const range = url.searchParams.get("range") ?? "6h";
          const snap = buildSnapshot(wtDir, buildOpts);
          const signalCosts: Record<string, number> = {};
          for (const orch of snap.orchestrators) {
            for (const [key, worker] of Object.entries(orch.workers)) {
              if (worker.cost?.costUSD) signalCosts[key] = worker.cost.costUSD;
            }
          }
          const result = await costValidation(prom, signalCosts, range);
          return Response.json({ data: result });
        }

        if (url.pathname === "/api/annotations") {
          return Response.json({ annotations: getAllAnnotations() });
        }

        const annMatch = url.pathname.match(
          /^\/api\/annotations\/([A-Za-z0-9._-]+)$/,
        );
        if (annMatch && annMatch[1]) {
          const sessionId = decodeURIComponent(annMatch[1]);

          if (req.method === "DELETE") {
            deleteAnnotation(sessionId);
            return Response.json({ ok: true });
          }

          if (req.method === "PUT") {
            let body: Record<string, unknown>;
            try {
              body = (await req.json()) as Record<string, unknown>;
            } catch {
              return Response.json(
                { error: "Invalid JSON body" },
                { status: 400 },
              );
            }

            const VALID_FLAGS = new Set([
              "starred",
              "flagged",
              "archived",
            ]);

            if (Array.isArray(body.addFlags)) {
              for (const f of body.addFlags) {
                if (typeof f !== "string" || !VALID_FLAGS.has(f)) {
                  return Response.json(
                    {
                      error: `Invalid flag: ${String(f)}. Valid: starred, flagged, archived`,
                    },
                    { status: 400 },
                  );
                }
              }
            }

            if (typeof body.displayName === "string") {
              setDisplayName(sessionId, body.displayName);
            } else if (body.displayName === null) {
              setDisplayName(sessionId, null);
            }

            if (Array.isArray(body.addFlags)) {
              for (const f of body.addFlags) {
                if (typeof f === "string") addFlag(sessionId, f);
              }
            }
            if (Array.isArray(body.removeFlags)) {
              for (const f of body.removeFlags) {
                if (typeof f === "string") removeFlag(sessionId, f);
              }
            }
            if (typeof body.addNote === "string") {
              addNote(sessionId, body.addNote);
            }
            if (
              typeof body.removeNoteIndex === "number" &&
              Number.isInteger(body.removeNoteIndex)
            ) {
              removeNote(sessionId, body.removeNoteIndex);
            }
            if (Array.isArray(body.addTags)) {
              for (const t of body.addTags) {
                if (typeof t === "string") addTag(sessionId, t);
              }
            }
            if (Array.isArray(body.removeTags)) {
              for (const t of body.removeTags) {
                if (typeof t === "string") removeTag(sessionId, t);
              }
            }

            const annotation = getAnnotation(sessionId);
            return Response.json({ annotation });
          }

          return new Response("Method Not Allowed", { status: 405 });
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


        if (url.pathname.startsWith("/public/") || url.pathname.startsWith("/assets/")) {
          const rel = decodeURIComponent(
            url.pathname.startsWith("/public/")
              ? url.pathname.slice("/public/".length)
              : url.pathname.slice(1),
          );
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
    watcher = startWatching(wtDir, { dbPath, sqlitePollIntervalMs, runsDir });
  }

  if (pidFile) {
    try {
      writeFileSync(pidFile, `${process.pid}\n`);
    } catch (err) {
      console.error(`[server] failed to write PID file ${pidFile}:`, err);
    }
  }

  if (opts.terminal) {
    unsubscribers.push(startTerminalRenderer(opts.renderOptions));
  }

  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    for (const u of unsubscribers) u();
    watcher?.stop();
    prFetcher?.stop();
    previewFetcher?.stop();
    linear?.stop();
    briefingProvider?.stop();
    closeDb();
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

export function startTerminalOnly(
  wtDir: string,
  renderOpts?: RenderOptions,
  runsDir?: string | null,
): {
  stop: () => void;
} {
  let watcher: WatcherHandle | null = null;
  try {
    watcher = startWatching(wtDir, { runsDir: runsDir ?? null });
  } catch (err) {
    console.error(`[terminal] failed to start watcher for ${wtDir}:`, err);
  }
  const unsubTerminal = startTerminalRenderer(renderOpts);
  console.info(`Terminal monitor running (no HTTP server), watching ${wtDir}`);
  return {
    stop: () => {
      unsubTerminal();
      watcher?.stop();
    },
  };
}

if (import.meta.main) {
  const CATALYST_DIR =
    process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;
  const WT_DIR = `${CATALYST_DIR}/wt`;
  const RUNS_DIR = `${CATALYST_DIR}/runs`;
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

  const useTerminal = process.argv.includes("--terminal");
  const terminalOnly = process.argv.includes("--terminal-only");
  const compact = process.argv.includes("--compact");
  const renderOpts: RenderOptions = { compact };

  const otelCfg = loadOtelConfig(
    process.env.CATALYST_CONFIG_DIR ?? `${process.env.HOME}/.config/catalyst`,
  );

  if (terminalOnly) {
    const handle = startTerminalOnly(WT_DIR, renderOpts, RUNS_DIR);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        console.info(`[terminal] received ${sig}, shutting down`);
        handle.stop();
        process.exit(0);
      });
    }
  } else {
    const srv = createServer({
      port: PORT,
      wtDir: WT_DIR,
      runsDir: RUNS_DIR,
      dbPath: DB_PATH,
      pidFile: pidFilePath,
      prometheusUrl: otelCfg.enabled ? otelCfg.prometheusUrl : null,
      lokiUrl: otelCfg.enabled ? otelCfg.lokiUrl : null,
      terminal: useTerminal,
      renderOptions: renderOpts,
    });
    const displayHost =
      srv.hostname === "0.0.0.0" ? "localhost" : String(srv.hostname);
    console.info(`Monitor v${CATALYST_DEV_VERSION} running at http://${displayHost}:${srv.port}`);
    if (useTerminal) {
      console.info("Terminal renderer active (--terminal)");
    }
    console.info(`(bound on ${String(srv.hostname)}:${srv.port}; watching ${WT_DIR} and ${RUNS_DIR})`);

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        console.info(`[server] received ${sig}, shutting down`);
        void srv.stop(true);
        process.exit(0);
      });
    }
  }
}
