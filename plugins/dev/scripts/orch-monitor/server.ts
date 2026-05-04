import { join, resolve as resolvePath, sep, dirname, basename } from "path";
import { realpathSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { subscribe, emit } from "./lib/event-bus";
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
import {
  listArchivedOrchestrators,
  getArchivedOrchestrator,
  getArchivePath,
} from "./lib/archive-reader";
import { startWatching, type WatcherHandle } from "./lib/watcher";
import { readRecentStreamEvents } from "./lib/stream-reader";
import {
  parseStreamForSubagents,
  flattenTodosForWorker,
  streamFilePath,
} from "./lib/subagent-tree";
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
import type { SummarizeHandler } from "./lib/summarize";
import { createSummarizeHandler } from "./lib/summarize";
import { loadSummarizeConfig, type ProviderName } from "./lib/summarize/config";
import { buildSummarizeSnapshot } from "./lib/summarize/snapshot";
import { getProvider, type SummarizeProvider } from "./lib/summarize/providers";
import { createCache } from "./lib/summarize/cache";
import { createRateLimiter } from "./lib/summarize/rate-limit";
import {
  createPreviewFetcher,
  type PreviewFetcher,
} from "./lib/preview-status";
import { writeMergedSignalFile } from "./lib/signal-writer";
import {
  createWebhookHandler,
  type WebhookHandler,
} from "./lib/webhook-handler";
import {
  createLinearWebhookHandler,
  type LinearWebhookHandler,
} from "./lib/linear-webhook-handler";
import {
  createWebhookTunnel,
  type WebhookTunnel,
  type SmeeClientFactory,
} from "./lib/webhook-tunnel";
import {
  createWebhookSubscriber,
  DEFAULT_WEBHOOK_EVENTS,
  type WebhookSubscriber,
  type SubscriberRunner,
} from "./lib/webhook-subscriber";
import {
  createWebhookReplay,
  type WebhookReplay,
} from "./lib/webhook-replay";
import {
  createEventLogWriter,
  type EventLogWriter,
} from "./lib/event-log";
import { loadOtelConfig } from "./lib/otel-config";
import { loadWebhookConfig } from "./lib/webhook-config";
import { detectProjectKey } from "./lib/project-key";
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
import {
  createCommsReader,
  isValidChannelName,
  type CommsReader,
} from "./lib/comms-reader";

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
  summarizeHandler?: SummarizeHandler | null;
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
  commsReader?: CommsReader | null;
  webhookConfig?: {
    smeeChannel: string;
    secret: string;
    /** Local target URL — defaults to http://localhost:{port}/api/webhook. */
    target?: string;
    /** Override for tests so the real smee-client isn't invoked. */
    tunnelFactory?: SmeeClientFactory;
    /**
     * Repos to subscribe to at daemon startup, in addition to the workers
     * observed in signal files. Empty/missing → auto-discovery only. CTL-216.
     */
    watchRepos?: string[];
    /**
     * Test override for the gh subprocess runner used by the subscriber. When
     * omitted, the production `defaultGhRunner` (Bun.spawn → real `gh`) is
     * used. Tests pass a stub so no real `gh` is invoked.
     */
    subscriberRunner?: SubscriberRunner;
  } | null;
  /**
   * Linear webhook config. Independent of `webhookConfig` (which carries the
   * GitHub bits) so a daemon can run Linear-only or GitHub-only setups.
   * `secret` empty disables `POST /api/webhook/linear`. CTL-210.
   */
  linearWebhookConfig?: {
    secret: string;
  } | null;
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
// Webhooks are the primary delivery path (CTL-209). Polling drops to a
// 10-minute fallback so missed deliveries get reconciled within bounded latency.
const PR_STATUS_REFRESH_MS = 10 * 60_000;
const PREVIEW_REFRESH_MS = 10 * 60_000;
export const LINEAR_REFRESH_MS = 5 * 60_000;

const defaultGhRunner: SubscriberRunner = async (args) => {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return { stdout, ok: exit === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
};

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

const SAFE_ARCHIVE_PART = /^[A-Za-z0-9._-]+$/;
const ARCHIVE_FILE_REL_FORBIDDEN = /(^|\/)\.\.(\/|$)|\\|\0/;

function isSafeArchivePart(s: string): boolean {
  if (s.length === 0 || s.length > 120) return false;
  return SAFE_ARCHIVE_PART.test(s);
}

function isSafeArchiveFileRel(s: string): boolean {
  if (s.length === 0 || s.length > 250) return false;
  if (s.startsWith("/")) return false;
  if (ARCHIVE_FILE_REL_FORBIDDEN.test(s)) return false;
  return s.split("/").every((seg) => seg === "" ? false : SAFE_ARCHIVE_PART.test(seg));
}

function contentTypeForArchive(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
      return "application/x-ndjson; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
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
    summarizeHandler: summarizeHandlerOpt,
    prometheusUrl,
    lokiUrl,
    prometheusFetcher: promFetcherOpt,
    lokiFetcher: lokiFetcherOpt,
    otelHealthChecker: otelHealthCheckerOpt,
    previewFetcher: previewFetcherOpt,
    previewRefreshMs = PREVIEW_REFRESH_MS,
    annotationsDbPath,
    commsReader: commsReaderOpt,
    webhookConfig,
    linearWebhookConfig,
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

  // Forward reference: the webhook handler is constructed below but
  // the prFetcher's freshness filter needs to call into it. We hold a mutable
  // ref and assign once the handler exists.
  let webhookHandlerRef: WebhookHandler | null = null;
  const prFetcher: PrStatusFetcher | null =
    prStatusFetcher === null
      ? null
      : (prStatusFetcher ??
        createPrStatusFetcher({
          lastWebhookAt: (ref) =>
            webhookHandlerRef?.getLastWebhookAt(ref.repo, ref.number) ?? null,
        }));
  let lastPrRefresh = 0;

  const linear: LinearFetcher | null =
    linearFetcher === null
      ? null
      : (linearFetcher ?? createLinearFetcher());
  let linearStarted = false;

  const briefingProvider: BriefingProvider | null =
    briefingProviderOpt === null ? null : (briefingProviderOpt ?? null);

  const summarizeHandler: SummarizeHandler | null =
    summarizeHandlerOpt === null ? null : (summarizeHandlerOpt ?? null);

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
      : (previewFetcherOpt ??
        createPreviewFetcher({
          getPrState: (ref) => prFetcher?.get(ref.repo, ref.number)?.state ?? null,
          lastWebhookAt: (ref) =>
            webhookHandlerRef?.getLastWebhookAt(ref.repo, ref.number) ?? null,
        }));
  let lastPreviewRefresh = 0;

  const comms: CommsReader | null =
    commsReaderOpt === null ? null : (commsReaderOpt ?? createCommsReader());

  function findSignalPathsForRef(repo: string, prNumber: number): string[] {
    const paths: string[] = [];
    const snap = buildSnapshot(wtDir, buildOpts);
    for (const orch of snap.orchestrators) {
      for (const worker of Object.values(orch.workers)) {
        if (!worker.pr) continue;
        if (worker.pr.number !== prNumber) continue;
        const wrepo = parseRepoFromPrUrl(worker.pr.url);
        if (wrepo !== repo) continue;
        paths.push(join(orch.path, "workers", `${worker.ticket}.json`));
      }
    }
    return paths;
  }

  let webhookHandler: WebhookHandler | null = null;
  let webhookTunnel: WebhookTunnel | null = null;
  let webhookSubscriber: WebhookSubscriber | null = null;
  let webhookReplay: WebhookReplay | null = null;
  if (webhookConfig && prFetcher) {
    const eventLog: EventLogWriter = createEventLogWriter({
      catalystDir: CATALYST_DIR,
      logger: {
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    webhookHandler = createWebhookHandler({
      secret: webhookConfig.secret,
      prFetcher,
      previewFetcher: previewFetcher ?? undefined,
      findSignalPaths: findSignalPathsForRef,
      eventLog,
      emit: (type, data) => emit(type, data),
      logger: {
        info: (m) => console.info(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    webhookHandlerRef = webhookHandler;
    webhookSubscriber = createWebhookSubscriber({
      smeeChannel: webhookConfig.smeeChannel,
      secret: webhookConfig.secret,
      events: [...DEFAULT_WEBHOOK_EVENTS],
      runner: webhookConfig.subscriberRunner ?? defaultGhRunner,
      logger: {
        info: (m) => console.info(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    webhookReplay = createWebhookReplay({
      runner: defaultGhRunner,
      handler: webhookHandler,
      secret: webhookConfig.secret,
      logger: {
        info: (m) => console.info(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
  }

  // Linear webhook handler — independent of GitHub config so a daemon can run
  // either or both. Shares the same EventLogWriter when both are present so
  // GitHub and Linear events interleave in the same monthly file. CTL-210.
  let linearWebhookHandler: LinearWebhookHandler | null = null;
  if (linearWebhookConfig && linearWebhookConfig.secret.length > 0) {
    const linearEventLog: EventLogWriter = createEventLogWriter({
      catalystDir: CATALYST_DIR,
      logger: {
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    linearWebhookHandler = createLinearWebhookHandler({
      secret: linearWebhookConfig.secret,
      eventLog: linearEventLog,
      emit: (type, data) => emit(type, data),
      // CTL-211 — invalidate the LinearFetcher cache on issue webhook events
      // so the dashboard reflects the new state in seconds instead of waiting
      // for the next 5-min polling tick. Other event kinds (comment, reaction,
      // etc.) don't change the ticket fields the dashboard renders, so they
      // skip invalidation. The fetcher's invalidate() degrades silently when
      // linearis is unavailable.
      onAccept: async (event) => {
        if (
          linear !== null &&
          (event.kind === "issue" || event.kind === "comment") &&
          event.ticket !== null
        ) {
          await linear.invalidate(event.ticket);
        }
      },
      logger: {
        info: (m) => console.info(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
  }

  function snapshotWithPrStatus(): MonitorSnapshot {
    const snap = buildSnapshot(wtDir, buildOpts);
    if (webhookSubscriber) {
      const seen = new Set<string>();
      for (const ref of collectPrRefs(snap)) {
        if (seen.has(ref.repo)) continue;
        seen.add(ref.repo);
        void webhookSubscriber.ensureSubscribed(ref.repo);
      }
    }
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

        const rollupMatch = url.pathname.match(/^\/api\/rollup\/([^/]+)$/);
        if (rollupMatch) {
          let orchId: string;
          try {
            orchId = decodeURIComponent(rollupMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (orchId.includes("..") || orchId.includes("/") || orchId.includes("\0")) {
            return new Response("Bad Request", { status: 400 });
          }
          const snap = snapshotWithPrStatus();
          const orch = snap.orchestrators.find((o) => o.id === orchId);
          if (!orch) {
            return new Response("Not Found", { status: 404 });
          }
          return Response.json({
            orchId: orch.id,
            rollup: orch.rollupBriefing ?? null,
          });
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

        const subagentsMatch = url.pathname.match(
          /^\/api\/worker\/([^/]+)\/([^/]+)\/subagents$/,
        );
        if (subagentsMatch) {
          let orchId: string;
          let ticket: string;
          try {
            orchId = decodeURIComponent(subagentsMatch[1]);
            ticket = decodeURIComponent(subagentsMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            orchId.includes("..") ||
            orchId.includes("/") ||
            orchId.includes("\0") ||
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const stateReader = await import("./lib/state-reader");
          const scanned = runsDir
            ? stateReader.scanAllOrchestrators({ runsDir, wtDir })
            : stateReader.scanOrchestrators(wtDir);
          const entry = scanned.find((d) => basename(d.path) === orchId);
          if (!entry) return new Response("Not Found", { status: 404 });
          const tree = parseStreamForSubagents(streamFilePath(entry.path, ticket));
          return Response.json({ orchId, ticket, tree });
        }

        const workerTodosMatch = url.pathname.match(
          /^\/api\/worker\/([^/]+)\/([^/]+)\/todos$/,
        );
        if (workerTodosMatch) {
          let orchId: string;
          let ticket: string;
          try {
            orchId = decodeURIComponent(workerTodosMatch[1]);
            ticket = decodeURIComponent(workerTodosMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            orchId.includes("..") ||
            orchId.includes("/") ||
            orchId.includes("\0") ||
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const stateReader = await import("./lib/state-reader");
          const scanned = runsDir
            ? stateReader.scanAllOrchestrators({ runsDir, wtDir })
            : stateReader.scanOrchestrators(wtDir);
          const entry = scanned.find((d) => basename(d.path) === orchId);
          if (!entry) return new Response("Not Found", { status: 404 });
          const tree = parseStreamForSubagents(streamFilePath(entry.path, ticket));
          const todos = flattenTodosForWorker(tree, ticket);
          return Response.json({ orchId, ticket, todos });
        }

        const orchTodosMatch = url.pathname.match(/^\/api\/orch\/([^/]+)\/todos$/);
        if (orchTodosMatch) {
          let orchId: string;
          try {
            orchId = decodeURIComponent(orchTodosMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (orchId.includes("..") || orchId.includes("/") || orchId.includes("\0")) {
            return new Response("Bad Request", { status: 400 });
          }
          const stateReader = await import("./lib/state-reader");
          const scanned = runsDir
            ? stateReader.scanAllOrchestrators({ runsDir, wtDir })
            : stateReader.scanOrchestrators(wtDir);
          const entry = scanned.find((d) => basename(d.path) === orchId);
          if (!entry) return new Response("Not Found", { status: 404 });
          const orchState = stateReader.readOrchestratorState(
            entry.path,
            "workspace" in entry ? entry.workspace : "default",
          );
          const todos = [];
          for (const [, worker] of Object.entries(orchState.workers)) {
            const ticket = worker.ticket;
            if (!ticket) continue;
            const tree = parseStreamForSubagents(streamFilePath(entry.path, ticket));
            todos.push(...flattenTodosForWorker(tree, ticket));
          }
          return Response.json({ orchId, todos });
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

        if (url.pathname === "/api/comms/channels") {
          if (!comms) return Response.json({ channels: [] });
          return Response.json({ channels: await comms.listChannels() });
        }

        const commsStreamMatch = url.pathname.match(
          /^\/api\/comms\/channels\/([^/]+)\/stream$/,
        );
        if (commsStreamMatch) {
          let channelName: string;
          try {
            channelName = decodeURIComponent(commsStreamMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isValidChannelName(channelName)) {
            return new Response("Invalid channel name", { status: 400 });
          }
          if (!comms) return new Response("Comms not available", { status: 503 });

          const commsReader = comms;
          let offset = 0;
          let timer: ReturnType<typeof setInterval> | null = null;
          let inFlight = false;
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const initial = await commsReader.getChannel(channelName, { limit: 200 });
              if (!initial) {
                const errFrame = `event: error-event\ndata: ${JSON.stringify({ error: "channel-not-found", channel: channelName })}\n\n`;
                try {
                  controller.enqueue(encoder.encode(errFrame));
                } catch {
                  // Client may have already disconnected.
                }
                controller.close();
                return;
              }
              offset = initial.tailOffset;
              const snapshotFrame = `event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`;
              try {
                controller.enqueue(encoder.encode(snapshotFrame));
              } catch {
                return;
              }
              timer = setInterval(() => {
                if (inFlight) return;
                inFlight = true;
                void (async () => {
                  try {
                    const tail = await commsReader.tailChannel(channelName, offset);
                    offset = tail.newOffset;
                    for (const m of tail.messages) {
                      const frame = `event: message\ndata: ${JSON.stringify(m)}\n\n`;
                      controller.enqueue(encoder.encode(frame));
                    }
                  } catch {
                    // Keep the stream alive on transient read errors.
                  } finally {
                    inFlight = false;
                  }
                })();
              }, 500);
            },
            cancel() {
              if (timer) clearInterval(timer);
              timer = null;
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

        const commsChannelMatch = url.pathname.match(
          /^\/api\/comms\/channels\/([^/]+)$/,
        );
        if (commsChannelMatch) {
          let channelName: string;
          try {
            channelName = decodeURIComponent(commsChannelMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isValidChannelName(channelName)) {
            return new Response("Invalid channel name", { status: 400 });
          }
          if (!comms) return new Response("Not Found", { status: 404 });
          const limitRaw = url.searchParams.get("limit");
          const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
          const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(parsedLimit, 1000))
            : 200;
          const detail = await comms.getChannel(channelName, { limit });
          if (!detail) return new Response("Not Found", { status: 404 });
          return Response.json(detail);
        }

        const commsParticipantMatch = url.pathname.match(
          /^\/api\/comms\/participants\/([^/]+)$/,
        );
        if (commsParticipantMatch) {
          let agentName: string;
          try {
            agentName = decodeURIComponent(commsParticipantMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (agentName.includes("/") || agentName.includes("\0")) {
            return new Response("Bad Request", { status: 400 });
          }
          if (!comms) return new Response("Not Found", { status: 404 });
          const detail = await comms.getParticipant(agentName);
          if (!detail) return new Response("Not Found", { status: 404 });
          return Response.json(detail);
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

        if (url.pathname === "/api/webhook" && req.method === "POST") {
          if (!webhookHandler) {
            return new Response("webhook receiver not configured", {
              status: 503,
            });
          }
          return webhookHandler.handle(req);
        }

        if (url.pathname === "/api/webhook/linear" && req.method === "POST") {
          if (!linearWebhookHandler) {
            return new Response("linear webhook receiver not configured", {
              status: 503,
            });
          }
          return linearWebhookHandler.handle(req);
        }

        if (url.pathname === "/api/summarize" && req.method === "POST") {
          if (!summarizeHandler) {
            return Response.json(
              { error: "AI not configured" },
              { status: 503 },
            );
          }
          return summarizeHandler.handle(req);
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

        if (url.pathname === "/api/archive/orchestrators") {
          if (!dbPath) {
            return Response.json({ entries: [], total: 0 });
          }
          const params = url.searchParams;
          const limitRaw = params.get("limit");
          const offsetRaw = params.get("offset");
          const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
          const parsedOffset = offsetRaw ? Number.parseInt(offsetRaw, 10) : NaN;
          const result = listArchivedOrchestrators(dbPath, {
            since: params.get("since") ?? undefined,
            until: params.get("until") ?? undefined,
            ticket: params.get("ticket") ?? undefined,
            status: params.get("status") ?? undefined,
            limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
            offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
          });
          return Response.json(result);
        }

        const archiveFileMatch = url.pathname.match(
          /^\/api\/archive\/orchestrators\/([^/]+)\/files\/(.+)$/,
        );
        if (archiveFileMatch) {
          if (!dbPath) {
            return new Response("Not Found", { status: 404 });
          }
          let orchId: string;
          let fileRel: string;
          try {
            orchId = decodeURIComponent(archiveFileMatch[1]);
            fileRel = decodeURIComponent(archiveFileMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            !isSafeArchivePart(orchId) ||
            !isSafeArchiveFileRel(fileRel)
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const archivePath = getArchivePath(dbPath, orchId);
          if (!archivePath) {
            return new Response("Not Found", { status: 404 });
          }
          const candidate = resolvePath(archivePath, fileRel);
          let realRoot: string;
          try {
            realRoot = realpathSync(archivePath);
          } catch {
            return new Response("Not Found", { status: 404 });
          }
          let realTarget: string;
          try {
            realTarget = realpathSync(candidate);
          } catch {
            return new Response("Not Found", { status: 404 });
          }
          if (
            realTarget !== realRoot &&
            !realTarget.startsWith(realRoot + sep)
          ) {
            return new Response("Forbidden", { status: 403 });
          }
          const file = Bun.file(realTarget);
          if (!(await file.exists())) {
            return new Response("Not Found", { status: 404 });
          }
          return new Response(file, {
            headers: {
              "Content-Type": contentTypeForArchive(realTarget),
              "Cache-Control": "private, max-age=60",
            },
          });
        }

        const archiveDetailMatch = url.pathname.match(
          /^\/api\/archive\/orchestrators\/([^/]+)$/,
        );
        if (archiveDetailMatch) {
          if (!dbPath) {
            return new Response("Not Found", { status: 404 });
          }
          let orchId: string;
          try {
            orchId = decodeURIComponent(archiveDetailMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isSafeArchivePart(orchId)) {
            return new Response("Bad Request", { status: 400 });
          }
          const detail = getArchivedOrchestrator(dbPath, orchId);
          if (!detail) {
            return new Response("Not Found", { status: 404 });
          }
          return Response.json(detail);
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


        if (url.pathname === "/mockups" || url.pathname === "/mockups/") {
          const file = Bun.file(join(publicDir, "mockups", "index.html"));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }

        if (url.pathname.startsWith("/mockups/")) {
          const rel = decodeURIComponent(
            "mockups/" + url.pathname.slice("/mockups/".length),
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

  if (webhookConfig && webhookHandler) {
    const tunnelTarget =
      webhookConfig.target ?? `http://localhost:${server.port}/api/webhook`;
    webhookTunnel = createWebhookTunnel({
      source: webhookConfig.smeeChannel,
      target: tunnelTarget,
      logger: {
        info: (m) => console.info(m),
        error: (m) => console.error(m),
      },
      factory: webhookConfig.tunnelFactory,
    });
    void webhookTunnel.start().catch((err: unknown) => {
      console.error(
        `[server] webhook tunnel start failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    if (webhookReplay && webhookSubscriber) {
      const replay = webhookReplay;
      const subscriber = webhookSubscriber;
      // CTL-216: subscribe to configured watchRepos before replay so they're
      // present in subscriber.listSubscribed() when replay runs. Errors per
      // repo are tolerated by ensureSubscribed (logged + continue).
      const watchRepos = webhookConfig.watchRepos ?? [];
      const watchSubscriptions =
        watchRepos.length > 0
          ? Promise.allSettled(
              watchRepos.map((repo) => subscriber.ensureSubscribed(repo)),
            )
          : Promise.resolve();
      // 1-hour replay window — wide enough to cover most outages, narrow enough
      // to keep startup latency under a few seconds.
      const since = new Date(Date.now() - 60 * 60_000);
      void watchSubscriptions
        .then(() => replay.replaySince(subscriber.listSubscribed(), since))
        .then((count) => {
          if (count > 0) {
            console.info(
              `[server] replayed ${count} webhook deliveries from the last hour`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(
            `[server] webhook replay failed:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    }
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
    void webhookTunnel?.stop();
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

  const projectKey = detectProjectKey(process.cwd());
  const otelCfg = loadOtelConfig(
    process.env.CATALYST_CONFIG_DIR ?? `${process.env.HOME}/.config/catalyst`,
    projectKey,
  );

  const summarizeCfg = loadSummarizeConfig(
    `${process.cwd()}/.catalyst/config.json`,
  );

  const fullWebhookConfig = loadWebhookConfig(
    process.env.CATALYST_CONFIG_DIR ?? `${process.env.HOME}/.config/catalyst`,
    `${process.cwd()}/.catalyst/config.json`,
  );
  const webhookConfig =
    fullWebhookConfig &&
    fullWebhookConfig.smeeChannel.length > 0 &&
    fullWebhookConfig.secret.length > 0
      ? {
          smeeChannel: fullWebhookConfig.smeeChannel,
          secret: fullWebhookConfig.secret,
          watchRepos: fullWebhookConfig.watchRepos,
        }
      : null;
  const linearWebhookConfig =
    fullWebhookConfig && fullWebhookConfig.linearSecret.length > 0
      ? { secret: fullWebhookConfig.linearSecret }
      : null;
  let summarizeHandler: SummarizeHandler | null = null;
  if (summarizeCfg.enabled) {
    const providers: Record<ProviderName, SummarizeProvider> = {
      anthropic: getProvider("anthropic"),
      openai: getProvider("openai"),
      grok: getProvider("grok"),
    };
    summarizeHandler = createSummarizeHandler({
      config: summarizeCfg,
      buildSnapshot: (orchId) => buildSummarizeSnapshot(WT_DIR, orchId),
      providers,
      cache: createCache(5 * 60_000),
      rateLimiter: createRateLimiter({
        maxConcurrent: 2,
        minIntervalMs: 500,
      }),
    });
  }

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
      summarizeHandler,
      webhookConfig,
      linearWebhookConfig,
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
