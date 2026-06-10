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
import { readReconcileHealth } from "./lib/reconcile-health-reader"; // CTL-867
import type { BoardPayload } from "./lib/board-data.mjs";
import { createBoardSnapshotManager } from "./lib/board-snapshot.mjs";
// CTL-896 (SHELL6): the dedicated nav-signal projection — worker count, queue
// depth, board anomaly, and the local daemon-health dot — derived off the SAME
// reactive board snapshot the board SSE already pushes (never a per-request
// scan), with the daemon health layered from the local node.heartbeat liveness.
import { deriveNavSignal } from "./lib/nav-signal.mjs";
import type { NavSignal, DaemonHealth } from "./lib/nav-signal.mjs";
// CTL-898 (SHELL8): the footer health dot generalizes into a PER-NODE cluster-
// health indicator + node filter. The /api/cluster routes assemble the BFF2
// cluster view (cluster-view.mjs) off the SAME reactive board snapshot, then
// project it to the tiny per-node footer signal (cluster-signal.mjs). Single-host
// is an exact identity no-op (one node — the local daemon).
import { createClusterEntity } from "./lib/cluster-view.mjs";
import type { ClusterView } from "./lib/cluster-view.mjs";
import { deriveClusterSignal } from "./lib/cluster-signal.mjs";
import type { ClusterSignal } from "./lib/cluster-signal.mjs";
// CTL-886 (BFF4): run→worker identity — surface every phase-*.json signal as a
// queryable run entity (/api/ticket-runs/<id>) + serve one signal verbatim
// (/api/ec-worker/<ticket>/<phase>). Pure file-reads of resident signals — no
// live Linear/GitHub call per request.
import {
  assembleTicketRuns,
  readPhaseSignalVerbatim,
} from "./lib/ticket-runs.mjs";
// CTL-887 (BFF5): the live transcript tail for execution-core workers. The
// legacy /api/worker-stream reads the Plane-B runs/ tree (empty for EC); this
// is the EC equivalent — tails ~/.claude/projects/*/<sessionId>.jsonl and
// emits typed StreamEvents over SSE for the worker [● live] tab + reasoning
// rows + footer counters + the ticket active-node live tail.
import {
  resolveTranscriptPath,
  TranscriptTail,
} from "./lib/ec-worker-stream.mjs";
// CTL-885 (BFF3): the cross-node live-tail SSE FAN-IN. The /api/ec-worker-stream
// route is made node-aware: single-host (hosts.json absent/len 1) is an EXACT
// identity no-op (tail the LOCAL transcript, zero added latency, no owner
// resolution, no remote hop); multi-host multiplexes the OWNING node's per-host
// stream keyed by host.name (never a shared/merged log). The owner is resolved
// from BFF2/BFF10's per-worker host:{name,id} carried on the board snapshot.
import {
  readClusterRoster,
  resolveTailRoute,
  resolvePeerBaseUrl,
  proxyRemoteTail,
} from "./lib/cross-node-stream.mjs";
// CTL-938: the live SCREEN tail — the PRE-transcript wedge window. `claude logs
// <shortId>` dumps a bg session's rendered screen buffer (the only surface that
// shows WHY a session idles before any transcript exists — e.g. the
// "Unknown command: /catalyst-dev:phase-plan" wedge). No follow flag exists, so
// /api/ec-worker-screen/<shortId> polls every SCREEN_POLL_MS, ANSI-normalizes,
// diffs, and pushes only CHANGED full-screen frames over SSE.
import {
  ScreenPoller,
  deriveScreenShortId,
  SCREEN_POLL_MS,
} from "./lib/ec-worker-screen.mjs";
import type { ScreenLogsExec } from "./lib/ec-worker-screen.mjs";
import { hostName } from "./lib/canonical-event-shared.ts";
// CTL-890 (BFF8): the read-model's ONE destructive endpoint (design P10) —
// POST /api/ec-worker/<ticket>/stop wraps the flaky `claude stop <shortId>`
// behind a typed confirm + a fence-aware guard (single-host no-op pass;
// multi-host rejects a stale/partitioned generation). Optimistic rollback is a
// UI-side timer; the endpoint returns the verbatim shortId+ticket+phase identity
// the client needs to mark `stopping` and arm that timer.
import { stopWorker, type StopWorkerResult } from "./lib/stop-worker.mjs";
// CTL-924 (BFF12): the read-model's SECOND write endpoint (HOME5's Answer /
// Unblock verb) — POST /api/ticket/<ticket>/respond records the operator's
// response, clears the needs-human marker, and emits the resume event that
// drives CTL-876's loop (the daemon re-dispatches the parked worker). Shares
// BFF8's typed-confirm + fence-aware scaffolding (single-host no-op pass;
// multi-host rejects a stale/partitioned generation). Optimistic rollback is a
// UI-side timer; the endpoint returns the verbatim ticket+phase identity the
// client needs to mark the row `resuming` and arm that timer.
import {
  respondTicket,
  type RespondTicketResult,
} from "./lib/respond-ticket.mjs";
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
  createCacheBackedLinearFetcher,
  type LinearFetcher,
  type LinearTicket,
} from "./lib/linear";
import type { BriefingProvider } from "./lib/ai-briefing";
import type { SummarizeHandler } from "./lib/summarize";
import { createSummarizeHandler } from "./lib/summarize";
import { loadSummarizeConfig, type SummarizeConfig, type ProviderName } from "./lib/summarize/config";
import { buildSummarizeSnapshot } from "./lib/summarize/snapshot";
import { getProvider, type SummarizeProvider } from "./lib/summarize/providers";
import { createCache } from "./lib/summarize/cache";
import { createRateLimiter } from "./lib/summarize/rate-limit";
import {
  generateActivityBriefing,
  type ActivityWindow,
  VALID_ACTIVITY_WINDOWS,
} from "./lib/activity-briefing";
import {
  createPreviewFetcher,
  type PreviewFetcher,
} from "./lib/preview-status";
import { writeMergedSignalFile } from "./lib/signal-writer";
import {
  createWebhookHandler,
  type WebhookHandler,
} from "./lib/webhook-handler";
import { createFileBasedPrCache } from "./lib/pr-cache";
import {
  resolveOrchestrator as resolveOrchestratorFn,
  type ActiveOrchestrator,
} from "./lib/orchestrator-resolver";
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
import { validatePredicate } from "./lib/event-filter";
import { readBacklog, tailEventLog, readTunnelEventStats } from "./lib/event-log-reader";
import { loadOtelConfig } from "./lib/otel-config";
import { loadWebhookConfig } from "./lib/webhook-config";
import { detectProjectKey } from "./lib/project-key";
import { loadMonitorConfig } from "./lib/monitor-config";
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
  workerHistoryBySession,
  isValidCcSessionId,
  workerBurnSeries,
  ticketTelemetrySeries,
  isValidLinearKey,
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
// CTL-889 (P8/P9/P12): cache-backed Linear detail / artifacts / search readers.
// All three read EXCLUSIVELY from durable caches (filter-state.db ticket_state +
// the local thoughts tree) and NEVER do a synchronous live Linear call per
// request — the rate-limit win, consistent with the BFF1 (CTL-883) decision.
import { readTicketDetail } from "./lib/ticket-detail-reader.mjs";
import { readTicketArtifacts } from "./lib/ticket-artifacts-reader.mjs";
import { readTicketSearch } from "./lib/ticket-search-reader.mjs";

type BunServer = ReturnType<typeof Bun.serve>;

// CTL-942: detail-page deep links. The /ticket/$id and /worker/$id routes live
// in the TanStack router mounted by the BOARD entry (board.html →
// src/board/main.tsx → AppRouter) — index.html's shell App mounts no router —
// so a hard navigation / refresh / shared link must be answered with board.html
// for the route to render at all. Scope is deliberately tight: exactly one
// non-empty path segment after /ticket or /worker, and the segment must not
// look like an asset (no "." extension) so a mistyped asset URL keeps 404ing
// instead of receiving html. /api/* and /events* can never match (the
// ^/(ticket|worker)/ prefix excludes them by construction).
export function isDetailDeepLinkPath(pathname: string): boolean {
  const m = /^\/(ticket|worker)\/([^/]+)$/.exec(pathname);
  return m != null && !m[2].includes(".");
}

export interface CreateServerOptions {
  port?: number;
  hostname?: string;
  wtDir: string;
  /** Override for the Catalyst state directory used by event log stats (default: ~/catalyst). */
  catalystDir?: string;
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
  summarizeConfig?: SummarizeConfig;
  prometheusUrl?: string | null;
  lokiUrl?: string | null;
  prometheusFetcher?: PrometheusFetcher | null;
  lokiFetcher?: LokiFetcher | null;
  otelHealthChecker?: OtelHealthChecker | null;
  previewFetcher?: PreviewFetcher | null;
  previewRefreshMs?: number;
  annotationsDbPath?: string;
  /**
   * Override for the broker's durable filter-state.db (ticket_state cache) used
   * by the cache-backed Linear detail/search routes (CTL-889, P8/P12). Defaults
   * to `${catalystDir}/filter-state.db` — the broker's own default. Tests point
   * this at a seeded temp DB so the routes don't read the live broker cache.
   */
  filterStateDbPath?: string;
  /**
   * CTL-896 (SHELL6): override for the local daemon-health reader that feeds the
   * footer health dot in the nav-signal projection (/api/nav, /api/nav/stream).
   * Production lazily resolves the local node's last `node.heartbeat` (recovery
   * .readClusterHeartbeats) and classifies it via node-liveness — the single-host
   * identity no-op (the one local daemon's own heartbeat IS the health). Tests
   * inject a deterministic status so the routes don't read the live event log.
   */
  daemonHealthReader?: (() => DaemonHealth | Promise<DaemonHealth>) | null;
  /**
   * CTL-898 (SHELL8): override for the per-node cluster-health reader that feeds
   * the footer's generalized per-node indicator + node filter (/api/cluster,
   * /api/cluster/stream). Given the board snapshot it returns the assembled
   * ClusterView (cluster-view.mjs::assembleClusterView), projected to the tiny
   * footer signal by deriveClusterSignal. Production lazily resolves the roster
   * (config.getClusterHosts) + heartbeats (recovery.readClusterHeartbeats) — the
   * single-host identity no-op yields ONE node (the local daemon). Tests inject a
   * deterministic ClusterView so the routes don't read the live event log/roster.
   */
  clusterReader?: ((board: BoardPayload) => ClusterView | Promise<ClusterView>) | null;
  /**
   * CTL-938: override for the `claude logs <shortId>` runner that feeds the
   * live SCREEN SSE (/api/ec-worker-screen/<shortId>) — the pre-transcript
   * wedge window. Production spawns the real claude CLI (defaultClaudeLogsExec);
   * tests inject a scripted fake so no subprocess is ever forked.
   */
  screenLogsExec?: ScreenLogsExec | null;
  /** CTL-938: screen poll cadence override (default SCREEN_POLL_MS ≈ 2s). Tests
   *  shrink it so the SSE assertions don't wait multiple seconds per frame. */
  screenPollMs?: number;
  terminal?: boolean;
  renderOptions?: RenderOptions;
  commsReader?: CommsReader | null;
  webhookConfig?: {
    smeeChannel: string;
    secret: string;
    /** Env-var name the secret is read from (e.g. "CATALYST_WEBHOOK_SECRET"). Exposed via /api/status/webhook-tunnel. */
    secretEnvName?: string;
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
   * HMAC signing secrets array (CTL-273) — empty disables `POST /api/webhook/linear`. CTL-210.
   * `smeeChannel` drives the second smee tunnel (CTL-242); empty means no tunnel.
   */
  linearWebhookConfig?: {
    linearSecrets: Array<{ key: string; secret: string }>;
    /** smee.io channel URL for Linear delivery. Empty = no tunnel. CTL-242. */
    smeeChannel?: string;
    /** Linear bot user UUIDs for loop prevention (set of worker + orchestrator app-actor UUIDs). CTL-263. */
    botUserIds?: ReadonlySet<string>;
    /** Linear team→repo map (CTL-362). When set, the handler stamps
     * `attributes["vcs.repository.name"]` on issue/comment/cycle envelopes for
     * teams that appear here so the HUD's REPO column populates for Linear
     * events. Empty / absent = no enrichment (pre-CTL-362 behaviour). */
    linearTeams?: Array<{ key: string; vcsRepo: string }>;
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

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// CTL-753: workflow substep event reader for /api/ticket-substeps
interface SubStepEvent {
  ts: string;
  workflowName: string;
  stepLabel: string;
  stepIndex: number;
  status: string;
}

function readSubStepEvents(eventsDir: string, ticket: string): SubStepEvent[] {
  const month = new Date().toISOString().slice(0, 7);
  const logPath = join(eventsDir, `${month}.jsonl`);
  const escapedTicket = ticket.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const pattern = new RegExp(
    `^workflow\\.substep\\.(started|complete|failed)\\.${escapedTicket}$`,
  );
  try {
    const text = readFileSync(logPath, "utf-8");
    const results: SubStepEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const ev = safeParseJson(line);
      if (!ev) continue;
      const name =
        (ev.attributes as Record<string, string> | undefined)?.["event.name"] ??
        "";
      if (!pattern.test(name)) continue;
      const payload =
        ((ev.body as Record<string, unknown>)?.payload as Record<
          string,
          unknown
        >) ?? {};
      results.push({
        ts: (ev.ts as string) ?? "",
        workflowName: (payload.workflowName as string) ?? "",
        stepLabel: (payload.stepLabel as string) ?? "",
        stepIndex: (payload.stepIndex as number) ?? 0,
        status: (payload.status as string) ?? "",
      });
    }
    results.sort((a, b) => a.ts.localeCompare(b.ts));
    return results;
  } catch {
    return [];
  }
}

const SSE_EVENTS = EVENT_TYPES;
// `global-event` and `global-event-backlog` are produced per-client by the
// activity tailer in the /events handler — not by the in-process bus — so they
// are excluded from the bus broadcast loop.
const BUS_BROADCAST_EVENTS = SSE_EVENTS.filter(
  (t) => t !== "global-event" && t !== "global-event-backlog",
);
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
    catalystDir: catalystDirOpt,
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
    summarizeConfig: summarizeConfigOpt,
    prometheusUrl,
    lokiUrl,
    prometheusFetcher: promFetcherOpt,
    lokiFetcher: lokiFetcherOpt,
    otelHealthChecker: otelHealthCheckerOpt,
    previewFetcher: previewFetcherOpt,
    previewRefreshMs = PREVIEW_REFRESH_MS,
    annotationsDbPath,
    filterStateDbPath,
    commsReader: commsReaderOpt,
    webhookConfig,
    linearWebhookConfig,
    daemonHealthReader: daemonHealthReaderOpt,
    clusterReader: clusterReaderOpt,
    screenLogsExec: screenLogsExecOpt,
    screenPollMs = SCREEN_POLL_MS,
  } = opts;

  const buildOpts: BuildSnapshotOptions = { dbPath, runsDir };

  const CATALYST_DIR =
    catalystDirOpt ?? process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;
  const annDbPath = annotationsDbPath ?? `${CATALYST_DIR}/annotations.db`;
  // CTL-889: the broker's durable ticket_state cache the detail/search routes
  // read (filter-state.db). Defaults to the broker's own default path.
  const filterStateDb = filterStateDbPath ?? `${CATALYST_DIR}/filter-state.db`;
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

  // BFF9 / CTL-921: the LinearFetcher behind /api/linear + /api/briefing reads
  // from the broker's durable filter-state.db ticket_state (via readLinearCache)
  // instead of polling `linearis issues read` live. This retires the second
  // surviving live-Linear path (the first, board-data.mjs::linearInfo, was
  // retired by BFF1/CTL-883) so NO request path spawns linearis or counts
  // against the 2500/hr cap. Cache-backed by construction: an OPEN linear-breaker
  // can never be tripped from here.
  const linear: LinearFetcher | null =
    linearFetcher === null
      ? null
      : (linearFetcher ?? createCacheBackedLinearFetcher());
  let linearStarted = false;

  const briefingProvider: BriefingProvider | null =
    briefingProviderOpt === null ? null : (briefingProviderOpt ?? null);

  const summarizeHandler: SummarizeHandler | null =
    summarizeHandlerOpt === null ? null : (summarizeHandlerOpt ?? null);

  const activityBriefingConfig: SummarizeConfig =
    summarizeConfigOpt ?? { enabled: false, defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6", providers: {} };

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

  // CTL-234 — orchestrator attribution for webhook events. Builds an
  // `ActiveOrchestrator[]` snapshot for the resolver: orchestrator IDs come
  // from `basename(orch.path)`, branch prefix is `${id}-` (the convention
  // used by orchestrate-create-worktree), and the PR list comes from worker
  // signal files. Cached briefly so a burst of webhooks doesn't re-scan disk
  // for every event.
  const ORCH_LIST_TTL_MS = 30_000;
  let cachedOrchList: { at: number; list: ActiveOrchestrator[] } | null = null;

  function getActiveOrchestrators(): ActiveOrchestrator[] {
    const now = Date.now();
    if (cachedOrchList && now - cachedOrchList.at < ORCH_LIST_TTL_MS) {
      return cachedOrchList.list;
    }
    const snap = buildSnapshot(wtDir, buildOpts);
    const list: ActiveOrchestrator[] = snap.orchestrators.map((orch) => {
      const id = basename(orch.path);
      const prs: Array<{ repo: string; number: number }> = [];
      for (const worker of Object.values(orch.workers)) {
        if (!worker.pr) continue;
        const wrepo = parseRepoFromPrUrl(worker.pr.url);
        if (wrepo === null) continue;
        prs.push({ repo: wrepo, number: worker.pr.number });
      }
      return { id, branchPrefix: `${id}-`, prs };
    });
    cachedOrchList = { at: now, list };
    return list;
  }

  let webhookHandler: WebhookHandler | null = null;
  let webhookTunnel: WebhookTunnel | null = null;
  let linearWebhookTunnel: WebhookTunnel | null = null;
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
      resolveOrchestrator: (input) =>
        resolveOrchestratorFn(input, getActiveOrchestrators()),
      emit: (type, data) => emit(type, data),
      prCache: createFileBasedPrCache(),
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
  if (linearWebhookConfig && linearWebhookConfig.linearSecrets.length > 0) {
    const linearEventLog: EventLogWriter = createEventLogWriter({
      catalystDir: CATALYST_DIR,
      logger: {
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    linearWebhookHandler = createLinearWebhookHandler({
      linearSecrets: linearWebhookConfig?.linearSecrets ?? [],
      botUserIds: linearWebhookConfig?.botUserIds,
      linearTeams: linearWebhookConfig?.linearTeams ?? [],
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
    // CTL-867: surface per-team reconcile health (last successful eligible
    // refresh age + the `alerting` flag) so the dashboard can show a team whose
    // eligibleQuery is failing persistently — its eligible set frozen stale,
    // silently starving. Best-effort: the reader never throws (missing dir →
    // empty map). Omitted entirely when no team has a marker yet.
    const reconcileHealth = readReconcileHealth(CATALYST_DIR);
    if (Object.keys(reconcileHealth).length > 0) {
      snap.reconcileHealth = reconcileHealth;
    }
    return snap;
  }

  const sseClients = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    SSEFilter
  >();
  const encoder = new TextEncoder();

  // CTL-733: one shared, reactively-recomputed board snapshot pushed over SSE
  // (/api/board/stream) — replaces per-tab polling of /api/board. Subscriber-
  // gated, so it does zero work when no board tab is open.
  const boardSnapshot = createBoardSnapshotManager();

  // CTL-896 (SHELL6): the local daemon-health reader for the footer health dot.
  //
  // SINGLE-HOST IDENTITY NO-OP: the read-model classifies the ONE local daemon's
  // own `node.heartbeat` freshness (live/degraded/offline → healthy/degraded/
  // offline). The heavy execution-core deps (recovery.readClusterHeartbeats reads
  // the local event log; config.getHostName names the local node) are imported
  // LAZILY via computed specifiers — the same dependency-hygiene guard cluster-
  // view.mjs uses so esbuild can't pull pino/bun:sqlite into any browser bundle —
  // and resolved ONCE under Bun. Every step is best-effort: an import or read
  // failure degrades to "offline" rather than throwing out of a nav request
  // (the read-model never fabricates health for a daemon it cannot hear).
  let daemonDepsPromise: Promise<{
    readClusterHeartbeats: (opts: { logPath?: string }) => Record<string, string>;
    getHostName: () => string;
    deriveDaemonHealth: typeof import("./lib/nav-signal.mjs").deriveDaemonHealth;
  } | null> | null = null;
  const loadDaemonDeps = () => {
    if (!daemonDepsPromise) {
      daemonDepsPromise = (async () => {
        try {
          const recoveryMod = ["..", "execution-core", "recovery.mjs"].join("/");
          const configMod = ["..", "execution-core", "config.mjs"].join("/");
          const [recovery, config, navSignal] = await Promise.all([
            import(recoveryMod),
            import(configMod),
            import("./lib/nav-signal.mjs"),
          ]);
          return {
            readClusterHeartbeats: recovery.readClusterHeartbeats,
            getHostName: config.getHostName,
            deriveDaemonHealth: navSignal.deriveDaemonHealth,
          };
        } catch {
          return null; // execution-core unavailable → degrade to offline
        }
      })();
    }
    return daemonDepsPromise;
  };
  const productionDaemonHealth = async (): Promise<DaemonHealth> => {
    try {
      const deps = await loadDaemonDeps();
      if (!deps) return "offline";
      // Let recovery.readClusterHeartbeats resolve the canonical current-month
      // event-log path itself (config.getEventLogPath, UTC YYYY-MM) so the read
      // path matches exactly what the daemon writes — no format drift here.
      const lastSeen = deps.readClusterHeartbeats({});
      return deps.deriveDaemonHealth(lastSeen, deps.getHostName());
    } catch {
      return "offline";
    }
  };
  const readDaemonHealth: () => Promise<DaemonHealth> =
    daemonHealthReaderOpt != null
      ? async () => daemonHealthReaderOpt()
      : productionDaemonHealth;

  // assembleNavSignal — project the four nav signals off the board snapshot the
  // read-model already computed, layering the local daemon health. One board read
  // (the shared, reactively-cached snapshot) + one heartbeat classify; NO
  // synchronous per-request scan of the source signal files.
  const assembleNavSignal = async (board: BoardPayload): Promise<NavSignal> =>
    deriveNavSignal(board, { daemon: await readDaemonHealth() });

  // CTL-898 (SHELL8): the per-node cluster-health projection for the footer +
  // node filter. The cluster VIEW (owner_host grouping + heartbeat liveness
  // overlay) is assembled off the SAME shared board snapshot via the BFF2
  // read-model entity — it spawns nothing and degrades to the single-host
  // identity no-op when the execution-core roster/recovery deps are unavailable.
  // The view is then projected to the tiny footer signal. Tests inject
  // `clusterReaderOpt` so the routes don't touch the live event log/roster.
  const clusterEntity = createClusterEntity();
  const readClusterView = async (board: BoardPayload): Promise<ClusterView> => {
    if (clusterReaderOpt != null) return clusterReaderOpt(board);
    return clusterEntity.project(board);
  };
  const assembleClusterSignal = async (
    board: BoardPayload,
  ): Promise<ClusterSignal> => {
    try {
      return deriveClusterSignal(await readClusterView(board));
    } catch (err) {
      // Never throw out of a cluster request — degrade to the empty single-host
      // signal (the footer keeps its muted/unknown dot) rather than 500.
      console.error(`[server] cluster signal assemble failed:`, err);
      return deriveClusterSignal(null);
    }
  };

  const unsubscribers: Array<() => void> = [];
  for (const eventType of BUS_BROADCAST_EVENTS) {
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

          // Eagerly validate the activity predicate so we can return 400 before
          // opening a stream. Empty-string predicate is allowed (means "no
          // jq filter, all global events"); only validate non-empty.
          if (
            filter.activityPredicate !== undefined &&
            filter.activityPredicate.trim() !== ""
          ) {
            const v = validatePredicate(filter.activityPredicate);
            if (!v.ok) {
              return new Response(
                `activity filter error: ${v.error ?? "invalid"}`,
                { status: 400 },
              );
            }
          }

          let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
          let activityCtrl: AbortController | null = null;
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
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

              // Activity stream multiplex: only when the client opted in via
              // `?activity=` (predicate may be empty for "all events").
              if (filter.activityPredicate !== undefined) {
                const predicate = filter.activityPredicate;
                try {
                  const backlogLines = await readBacklog({
                    catalystDir: CATALYST_DIR,
                    predicate,
                    limit: 100,
                  });
                  const parsed = backlogLines
                    .map((l) => safeParseJson(l))
                    .filter((v): v is Record<string, unknown> => v !== null);
                  const backlogEnv = createEvent(
                    "global-event-backlog",
                    { events: parsed },
                    "filesystem",
                  );
                  // Enqueue may race with client cancel; swallow the
                  // ERR_INVALID_STATE that comes back if the controller has
                  // already closed.
                  try {
                    controller.enqueue(
                      encoder.encode(
                        `event: global-event-backlog\ndata: ${JSON.stringify(backlogEnv)}\n\n`,
                      ),
                    );
                  } catch {
                    /* client cancelled */
                  }
                } catch (err) {
                  console.error(`[server] activity backlog failed:`, err);
                }

                activityCtrl = new AbortController();
                void tailEventLog({
                  catalystDir: CATALYST_DIR,
                  predicate,
                  signal: activityCtrl.signal,
                  onEvent: (line) => {
                    const parsed = safeParseJson(line);
                    if (parsed === null) return;
                    const env = createEvent("global-event", parsed, "filesystem");
                    try {
                      controller.enqueue(
                        encoder.encode(
                          `event: global-event\ndata: ${JSON.stringify(env)}\n\n`,
                        ),
                      );
                    } catch {
                      activityCtrl?.abort();
                    }
                  },
                });
              }
            },
            cancel() {
              if (captured) sseClients.delete(captured);
              activityCtrl?.abort();
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

        if (url.pathname === "/api/config") {
          const cfg = loadMonitorConfig(`${process.cwd()}/.catalyst/config.json`);
          return Response.json(cfg);
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

        if (url.pathname === "/api/ticket-substeps") {
          const ticketParam = url.searchParams.get("ticket");
          if (!ticketParam) {
            return new Response("Bad Request: missing ticket", { status: 400 });
          }
          if (
            ticketParam.includes("..") ||
            ticketParam.includes("/") ||
            ticketParam.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const eventsDir = join(CATALYST_DIR, "events");
          const subSteps = readSubStepEvents(eventsDir, ticketParam);
          return Response.json({ ticket: ticketParam, subSteps });
        }

        // CTL-889 (P8): cache-backed Linear ticket detail — description (null,
        // not cached), labels[], the relation graph (forward + reverse
        // blocks/related edges), assignee, and held classification. Read from
        // filter-state.db ticket_state, NEVER a live `linearis` call. 404 when
        // the ticket has no descriptor row.
        const ticketDetailMatch = url.pathname.match(
          /^\/api\/ticket-detail\/([^/]+)$/,
        );
        if (ticketDetailMatch) {
          let ticket: string;
          try {
            ticket = decodeURIComponent(ticketDetailMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const detail = await readTicketDetail(ticket, {
            dbPath: filterStateDb,
          });
          if (!detail) {
            return new Response("Not Found", { status: 404 });
          }
          return Response.json(detail);
        }

        // CTL-889 (P9): a ticket's research/plan thoughts artifacts for the
        // spine 📄 links — repo-root-relative paths + a peek preview, read from
        // the LOCAL thoughts tree. Surfaces the CTL-866 cross-node eventual-
        // consistency caveat (artifacts authored on another node appear only
        // after a thoughts-sync push).
        const ticketArtifactsMatch = url.pathname.match(
          /^\/api\/ticket-artifacts\/([^/]+)$/,
        );
        if (ticketArtifactsMatch) {
          let ticket: string;
          try {
            ticket = decodeURIComponent(ticketArtifactsMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            ticket.includes("..") ||
            ticket.includes("/") ||
            ticket.includes("\0")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const artifacts = await readTicketArtifacts(ticket);
          return Response.json(artifacts);
        }

        // CTL-889 (P12): cache-backed fuzzy ticket search for the ⌘K palette's
        // "Search all tickets in Linear" action. Fuzzy-matches the durable
        // ticket_state cache — NO per-keystroke live Linear API call. An empty
        // ?q= returns an empty result set (the palette renders the row idle).
        if (url.pathname === "/api/search") {
          const q = url.searchParams.get("q") ?? "";
          const limitRaw = url.searchParams.get("limit");
          const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
          const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(parsedLimit, 100))
            : 20;
          if (q.trim() === "") {
            return Response.json({
              query: q,
              results: [],
              source: "filter-state.db",
            });
          }
          const result = await readTicketSearch(q, {
            dbPath: filterStateDb,
            limit,
          });
          return Response.json(result);
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

        if (url.pathname === "/api/briefing/activity") {
          const windowParam = url.searchParams.get("window") ?? "30m";
          if (!VALID_ACTIVITY_WINDOWS.has(windowParam as ActivityWindow)) {
            return Response.json(
              { error: "Invalid window. Use 30m, 1h, or 6h." },
              { status: 400 },
            );
          }
          const result = await generateActivityBriefing(
            CATALYST_DIR,
            activityBriefingConfig,
            windowParam as ActivityWindow,
          );
          return Response.json(result);
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

        // CTL-914 (DETAIL3): the worker-page [history] tail. Queries the
        // `claude-code` Loki stream for ONE run's transcript by its CC session
        // UUID — REAL today, no plumbing — so a dead worker's tail is readable
        // hours later (why the worker page is never empty). The filter is a
        // `| session_id=\`UUID\`` STRUCTURED-METADATA pipe inside
        // workerHistoryBySession (a `{session_id=}` label matcher returns 0).
        // sessionId is UUID-validated before it ever reaches the LogQL, so the
        // pipe can never be an injection vector. 503 when Loki is not configured
        // (the UI degrades to the resident-data page), 400 on a bad id.
        const ecWorkerHistoryMatch = url.pathname.match(
          /^\/api\/ec-worker-history\/([^/]+)$/,
        );
        if (ecWorkerHistoryMatch) {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(ecWorkerHistoryMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isValidCcSessionId(sessionId)) {
            return new Response("Bad Request", { status: 400 });
          }
          if (!loki) {
            return Response.json({ error: "OTel not configured" }, { status: 503 });
          }
          const range = url.searchParams.get("range") ?? "24h";
          const rawLimit = parseInt(url.searchParams.get("limit") ?? "500", 10);
          const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(1, rawLimit), 2000)
            : 500;
          const rows = await workerHistoryBySession(loki, sessionId, range, limit);
          if (rows === null) {
            // Loki probe failed mid-flight — honest 503, not a fabricated empty.
            return Response.json({ error: "Loki unavailable" }, { status: 503 });
          }
          return Response.json({ data: rows });
        }

        // CTL-917 (DETAIL6): the worker Burn Strip's REAL Prometheus sparklines.
        // Four query_range series keyed on the CC session UUID (cost / tokens /
        // tokens-by-type / active-seconds) — no new plumbing, the same already-
        // emitting OTEL pipeline the `/api/otel/*` routes read. The UUID is
        // UUID-validated before it reaches the PromQL `{session_id=…}` matcher,
        // so the matcher can never be an injection vector. 503 when Prometheus is
        // not configured (the UI falls back to the resident BoardWorker scalar),
        // 400 on a bad id.
        const otelBurnMatch = url.pathname.match(
          /^\/api\/otel\/burn\/([^/]+)$/,
        );
        if (otelBurnMatch) {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(otelBurnMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isValidCcSessionId(sessionId)) {
            return new Response("Bad Request", { status: 400 });
          }
          if (!prom) {
            return Response.json({ error: "OTel not configured" }, { status: 503 });
          }
          const range = url.searchParams.get("range") ?? "1h";
          const series = await workerBurnSeries(prom, sessionId, range);
          if (series === null) {
            // Prometheus probe failed mid-flight — honest 503, never a fake series.
            return Response.json({ error: "Prometheus unavailable" }, { status: 503 });
          }
          return Response.json({ data: series });
        }

        // CTL-917 (DETAIL6): the ticket telemetry strip's REAL Prometheus
        // sparklines keyed on the Linear key (total cost / tokens-by-type +
        // cost-by-phase `sum by(task_type)` + cost-by-model `sum by(model)`).
        // commits/LoC stay git-sourced (NEEDS-PLUMBING) so they are NOT queried
        // here. The linear_key is validated before it reaches the PromQL matcher.
        const otelTicketTelemetryMatch = url.pathname.match(
          /^\/api\/otel\/ticket-telemetry\/([^/]+)$/,
        );
        if (otelTicketTelemetryMatch) {
          let linearKey: string;
          try {
            linearKey = decodeURIComponent(otelTicketTelemetryMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!isValidLinearKey(linearKey)) {
            return new Response("Bad Request", { status: 400 });
          }
          if (!prom) {
            return Response.json({ error: "OTel not configured" }, { status: 503 });
          }
          const range = url.searchParams.get("range") ?? "1h";
          const series = await ticketTelemetrySeries(prom, linearKey, range);
          if (series === null) {
            return Response.json({ error: "Prometheus unavailable" }, { status: 503 });
          }
          return Response.json({ data: series });
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

        // CTL-892 / SHELL2: the app shell (index.html → App → AppShell, CTL-891)
        // is now the canonical root. It hosts the dense board as the "board"
        // surface inside the shared SidebarInset, alongside Home/Workers/Queue —
        // one shell, two densities — so `/` serves the shell, NOT the shell-less
        // board page. (Before SHELL2, CTL-730 served board.html raw at `/`.) The
        // standalone board.html survives as a legacy/fallback entry at /board (it
        // still carries the FND deep-link router for /ticket/$id + /worker/$id).
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = Bun.file(join(publicDir, "index.html"));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response("index.html not found", { status: 500 });
        }

        // CTL-892 / SHELL2: the standalone board is no longer at root, but stays
        // reachable as a legacy/fallback entry. It's still built (vite `board`
        // input) and owns the board deep-link routes until those migrate into the
        // shell router in a later SHELL/FND ticket.
        if (url.pathname === "/board" || url.pathname === "/board.html") {
          const file = Bun.file(join(publicDir, "board.html"));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response("board.html not found", { status: 500 });
        }

        // CTL-942: SPA fallback for detail-page deep links (/ticket/$id,
        // /worker/$id). Serve board.html — the entry that carries the deep-link
        // router (index.html's shell App mounts none) — so hard navigation,
        // refresh, and shared links render the detail pages instead of 404ing.
        // Vite emits absolute /assets/* paths, so the nested pathname is safe.
        if (req.method === "GET" && isDetailDeepLinkPath(url.pathname)) {
          const file = Bun.file(join(publicDir, "board.html"));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response("board.html not found", { status: 500 });
        }

        if (
          url.pathname === "/legacy" ||
          url.pathname === "/legacy/" ||
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

        if (url.pathname === "/api/status/webhook-tunnel") {
          const stats = readTunnelEventStats(CATALYST_DIR);
          if (!webhookConfig) {
            return Response.json({
              connected: false,
              smeeUrl: null,
              secretEnvName: null,
              secretPresent: false,
              lastEventAt: stats.lastEventAt,
              eventCount24h: stats.eventCount24h,
              eventCount24hByRepo: stats.eventCount24hByRepo,
            });
          }
          return Response.json({
            connected: webhookTunnel?.isStarted() ?? false,
            smeeUrl: webhookConfig.smeeChannel || null,
            secretEnvName: webhookConfig.secretEnvName ?? "CATALYST_WEBHOOK_SECRET",
            secretPresent: webhookConfig.secret.length > 0,
            lastEventAt: stats.lastEventAt,
            eventCount24h: stats.eventCount24h,
            eventCount24hByRepo: stats.eventCount24hByRepo,
          });
        }

        // CTL-886 (BFF4) keystone P2: a ticket's full run history. One run entity
        // per phase-*.json signal under ~/catalyst/execution-core/workers/<id>/
        // (model, bg_job_id, attempt, generation, status, timestamps, host{},
        // pr{} when present). FINISHED runs (no live BoardWorker) included by
        // construction — we read the on-disk signals, not the live-agent list.
        // Per-phase cost is JOINED from catalyst.db, never invented onto the
        // signal. Pure file reads — no live Linear/GitHub call.
        const ticketRunsMatch = url.pathname.match(/^\/api\/ticket-runs\/([^/]+)$/);
        if (ticketRunsMatch) {
          let ticket: string;
          try {
            ticket = decodeURIComponent(ticketRunsMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!/^[A-Za-z]+-\d+$/.test(ticket)) {
            return new Response("Bad Request", { status: 400 });
          }
          return Response.json(await assembleTicketRuns(ticket));
        }

        // CTL-890 (BFF8) P10: the redesign's ONE destructive endpoint, gated last.
        // POST /api/ec-worker/<ticket>/stop wraps the flaky `claude stop <shortId>`
        // (pid-file absent on CC 2.1.152). Matched BEFORE the GET verbatim route
        // and gated on POST so a stop request is never confused with the
        // signal reader (and "stop" is not a valid phase, so a GET here 404s
        // harmlessly). Contract (design §3.4):
        //   • TYPED CONFIRM — body.confirm must equal the ticket id exactly.
        //   • TARGET RUN    — body.phase selects which run (its phase-<phase>.json
        //     signal carries the bg_job_id → shortId). The response echoes the
        //     exact shortId+ticket+phase so the UI shows what it is killing.
        //   • FENCE-AWARE   — single-host (hosts.json absent/len 1) is a no-op
        //     pass; multi-host rejects a verified-stale generation (a partitioned
        //     node) and refuses on an unconfirmable fence.
        //   • OPTIMISTIC ROLLBACK is a UI-side ~10s timer; on success we return the
        //     identity + a `stopping` status the client marks optimistically.
        const ecStopMatch = url.pathname.match(
          /^\/api\/ec-worker\/([^/]+)\/stop$/,
        );
        if (ecStopMatch && req.method === "POST") {
          let ticket: string;
          try {
            ticket = decodeURIComponent(ecStopMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!/^[A-Za-z]+-\d+$/.test(ticket)) {
            return new Response("Bad Request", { status: 400 });
          }
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
          const phase = typeof body.phase === "string" ? body.phase : "";
          if (!/^[a-z][a-z-]*$/.test(phase)) {
            return Response.json(
              { error: "phase is required and must be a valid phase name" },
              { status: 400 },
            );
          }
          const result: StopWorkerResult = await stopWorker({
            ticket,
            phase,
            confirm: body.confirm,
          });
          switch (result.status) {
            case "not_found":
              return Response.json(
                { status: "not_found", error: `no run signal for ${ticket}:${phase}` },
                { status: 404 },
              );
            case "confirm_mismatch":
              return Response.json(
                {
                  status: "confirm_mismatch",
                  error: "typed confirmation did not match the ticket id",
                  expected: result.expected,
                },
                { status: 400 },
              );
            case "no_session":
              return Response.json(result, { status: 409 });
            case "fenced":
              // A stale-generation node is fenced out — the worker is NOT killed.
              return Response.json(
                {
                  ...result,
                  error: "stop rejected: this node's generation is stale (fenced out)",
                },
                { status: 409 },
              );
            case "fence_indeterminate":
              return Response.json(
                {
                  ...result,
                  error: "stop rejected: fence could not be confirmed",
                },
                { status: 409 },
              );
            case "stop_failed":
              return Response.json(result, { status: 502 });
            case "stopping":
              // Kill issued; the UI marks the worker `stopping` and arms its ~10s
              // optimistic-rollback timer against the next board frame.
              return Response.json(result, { status: 200 });
          }
        }

        // CTL-924 (BFF12): the read-model's SECOND write endpoint — HOME5's Inbox
        // `Answer / Unblock` verb. POST /api/ticket/<ticket>/respond records the
        // operator's answer/unblock note, clears the `.linear-label-needs-human`
        // marker, and emits ONE `linear.comment.created` event into the unified
        // log — the daemon's handleCommentWake (CTL-549) consumes it, strips the
        // held label, and re-dispatches the parked worker (CTL-876's resume loop).
        // Contract mirrors BFF8's stop route:
        //   • TYPED CONFIRM — body.confirm must equal the ticket id exactly.
        //   • FENCE-AWARE   — single-host (hosts.json absent/len 1) is a no-op
        //     pass; multi-host rejects a verified-stale generation (a partitioned
        //     node) and refuses on an unconfirmable fence. NOTHING is mutated on
        //     a fence rejection.
        //   • OPTIMISTIC ROLLBACK is a UI-side timer; on success we return the
        //     ticket+phase identity + a `resuming` status the client marks
        //     optimistically (the held row should clear within the window).
        const respondMatch = url.pathname.match(
          /^\/api\/ticket\/([^/]+)\/respond$/,
        );
        if (respondMatch && req.method === "POST") {
          let ticket: string;
          try {
            ticket = decodeURIComponent(respondMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (!/^[A-Za-z]+-\d+$/.test(ticket)) {
            return new Response("Bad Request", { status: 400 });
          }
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
          const response = typeof body.response === "string" ? body.response : "";
          const result: RespondTicketResult = respondTicket({
            ticket,
            response,
            confirm: body.confirm,
          });
          switch (result.status) {
            case "not_held":
              return Response.json(
                {
                  status: "not_held",
                  error: `no parked (needs-input) run for ${ticket} to answer/unblock`,
                },
                { status: 404 },
              );
            case "confirm_mismatch":
              return Response.json(
                {
                  status: "confirm_mismatch",
                  error: "typed confirmation did not match the ticket id",
                  expected: result.expected,
                },
                { status: 400 },
              );
            case "fenced":
              // A stale-generation node is fenced out — nothing was mutated.
              return Response.json(
                {
                  ...result,
                  error: "respond rejected: this node's generation is stale (fenced out)",
                },
                { status: 409 },
              );
            case "fence_indeterminate":
              return Response.json(
                {
                  ...result,
                  error: "respond rejected: fence could not be confirmed",
                },
                { status: 409 },
              );
            case "resuming":
              // Response recorded + marker cleared + resume event emitted; the UI
              // marks the row `resuming` and arms its optimistic-rollback timer.
              return Response.json(result, { status: 200 });
          }
        }

        // CTL-886 (BFF4) companion P3: one phase signal served VERBATIM — the raw
        // phase-<phase>.json contents (model, bg_job_id, generation, status,
        // timestamps, host, pr) untransformed, for the worker header / PHASE
        // TIMESTAMPS / SIGNAL panel. 404 when the phase has no signal on disk.
        const ecWorkerMatch = url.pathname.match(
          /^\/api\/ec-worker\/([^/]+)\/([^/]+)$/,
        );
        if (ecWorkerMatch) {
          let ticket: string;
          let phase: string;
          try {
            ticket = decodeURIComponent(ecWorkerMatch[1]);
            phase = decodeURIComponent(ecWorkerMatch[2]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          if (
            !/^[A-Za-z]+-\d+$/.test(ticket) ||
            !/^[a-z][a-z-]*$/.test(phase)
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          const signal = await readPhaseSignalVerbatim(ticket, phase);
          if (!signal) {
            return new Response("Not Found", { status: 404 });
          }
          return Response.json(signal);
        }

        // CTL-887 (BFF5) + CTL-885 (BFF3): the live transcript tail, made
        // NODE-AWARE. BFF5 resolves a CC session UUID to its
        // ~/.claude/projects/<dir>/<sessionId>.jsonl path and streams typed
        // StreamEvents over SSE as the file grows (the EC equivalent of the
        // legacy /api/worker-stream, which is empty for execution-core workers).
        // BFF3 wraps that host-local tail in the cross-node FAN-IN: the UI
        // subscribes ONCE and the read-model multiplexes the OWNING node's
        // per-host stream keyed by host.name.
        //   • SINGLE-HOST (hosts.json absent/len 1): an EXACT identity no-op —
        //     tail the LOCAL transcript with zero added latency, no owner
        //     resolution, no remote hop (resolveTailRoute → { mode: "local" }).
        //   • MULTI-HOST, owner is a DIFFERENT node: proxy that peer's
        //     /api/ec-worker-stream/<sessionId> through unchanged (never a
        //     shared/merged log — only the one owner's per-host stream).
        const ecWorkerStreamMatch = url.pathname.match(
          /^\/api\/ec-worker-stream\/([^/]+)$/,
        );
        if (ecWorkerStreamMatch) {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(ecWorkerStreamMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          // A CC session id is a UUID — reject anything else so no arbitrary
          // path ever reaches the filesystem.
          if (
            !/^[0-9a-fA-F-]{8,64}$/.test(sessionId) ||
            sessionId.includes("..") ||
            sessionId.includes("/")
          ) {
            return new Response("Bad Request", { status: 400 });
          }

          // ── BFF3 fan-in routing (single-host = identity no-op) ──────────────
          // Read the committed roster ONCE. SINGLE-HOST is the identity no-op:
          // resolveTailRoute short-circuits to { mode: "local" } before any
          // owner resolution, so we never even read the board snapshot — zero
          // added latency. Only the MULTI-HOST branch resolves the owner: we
          // read the board snapshot's per-worker host:{name,id} (BFF2/BFF10) —
          // never a live attachment fetch, never a merged log — and pass a
          // synchronous lookup over that resolved worker list. `hostBaseUrl` is
          // the cross-node transport seam: no production roster→URL source
          // exists yet (single-node MVP), so a multi-host owner with no
          // resolvable base URL is reported unroutable (a 404) rather than
          // mis-tailed to the wrong node's local file.
          const roster = readClusterRoster();
          const workers =
            roster.length > 1 ? ((await boardSnapshot.getLatest())?.workers ?? []) : [];
          const route = resolveTailRoute({
            sessionId,
            roster,
            selfHost: hostName(),
            ownerHostForSession: (sid) =>
              workers.find((w) => w.sessionId === sid)?.host?.name ?? null,
            hostBaseUrl: (host) => resolvePeerBaseUrl(host),
          });
          if (route.mode === "remote") {
            // MULTI-HOST: fan in the owning node's per-host stream, keyed by
            // host.name, by proxying its SSE body straight through (no re-frame
            // — the client's StreamEventRow renderer consumes the peer's frames
            // unchanged). A down/unreachable peer → 502 (never a wrong tail).
            const abort = new AbortController();
            const body = await proxyRemoteTail({ url: route.url, signal: abort.signal });
            if (!body) {
              return new Response("Bad Gateway", { status: 502 });
            }
            const proxied = new ReadableStream<Uint8Array>({
              async start(controller) {
                const reader = body.getReader();
                try {
                  for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) controller.enqueue(value);
                  }
                  controller.close();
                } catch {
                  // upstream torn down (peer closed / client aborted) — end the
                  // proxied stream cleanly rather than leaking the reader.
                  try {
                    controller.close();
                  } catch {
                    /* already closed */
                  }
                }
              },
              cancel() {
                // client disconnected → abort the upstream subscription so no
                // per-host connection leaks.
                abort.abort();
              },
            });
            return new Response(proxied, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
          if (route.mode === "unroutable") {
            // MULTI-HOST: owner is a different node we can't reach (no transport
            // address). 404 rather than blindly tailing THIS host's transcript
            // (which would show the wrong node's session).
            return new Response("Not Found", { status: 404 });
          }
          // route.mode === "local": the identity no-op — tail the LOCAL
          // transcript exactly as the non-cluster BFF5 path does.
          const transcriptPath = await resolveTranscriptPath(sessionId);
          if (!transcriptPath) {
            return new Response("Not Found", { status: 404 });
          }

          let timer: ReturnType<typeof setInterval> | null = null;
          let inFlight = false;
          let closed = false;
          const tail = new TranscriptTail(transcriptPath);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const pump = () => {
                if (inFlight || closed) return;
                inFlight = true;
                void (async () => {
                  try {
                    const events = await tail.poll();
                    if (closed) return;
                    for (const ev of events) {
                      controller.enqueue(
                        encoder.encode(
                          `event: stream-event\ndata: ${JSON.stringify(ev)}\n\n`,
                        ),
                      );
                    }
                  } catch {
                    // client likely went away mid-enqueue; stop pumping
                    closed = true;
                    if (timer) clearInterval(timer);
                    timer = null;
                  } finally {
                    inFlight = false;
                  }
                })();
              };
              // Open frame so a cold connection paints the tail immediately,
              // then poll for growth on a fixed cadence.
              controller.enqueue(
                encoder.encode(
                  `event: open\ndata: ${JSON.stringify({ sessionId })}\n\n`,
                ),
              );
              pump();
              timer = setInterval(pump, 750);
            },
            cancel() {
              closed = true;
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

        // CTL-938: the live SCREEN SSE — the PRE-transcript wedge window. Given
        // a worker's bg shortId (or full job UUID), poll `claude logs <shortId>`
        // every screenPollMs, ANSI-normalize, diff against the last snapshot,
        // and push only CHANGED frames (each carrying the FULL screen, never a
        // delta — frames are droppable, so a slow client just paints the latest
        // one). Terminal outcomes close the stream: session gone → `gone`
        // event, claude CLI unusable → `unavailable` event. The FIRST poll runs
        // before the SSE handshake so a dead session is an HTTP status (404 /
        // 503), not an empty stream the client must time out on.
        const ecWorkerScreenMatch = url.pathname.match(
          /^\/api\/ec-worker-screen\/([^/]+)$/,
        );
        if (ecWorkerScreenMatch) {
          let rawId: string;
          try {
            rawId = decodeURIComponent(ecWorkerScreenMatch[1]);
          } catch {
            return new Response("Bad Request", { status: 400 });
          }
          // `claude logs` only accepts the 8-char short form; deriveScreenShortId
          // also truncates a full job UUID. null = malformed → nothing ever
          // reaches the exec fn (no arbitrary string ever hits a subprocess).
          const screenShortId = deriveScreenShortId(rawId);
          if (!screenShortId) {
            return new Response("Bad Request", { status: 400 });
          }

          const poller = new ScreenPoller(screenShortId, {
            exec: screenLogsExecOpt ?? undefined,
          });
          const first = await poller.poll();
          if (first.kind === "gone") {
            return new Response("Not Found", { status: 404 });
          }
          if (first.kind === "unavailable") {
            return new Response("Service Unavailable", { status: 503 });
          }

          let timer: ReturnType<typeof setInterval> | null = null;
          let inFlight = false;
          let closed = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const close = () => {
                if (closed) return;
                closed = true;
                if (timer) clearInterval(timer);
                timer = null;
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              };
              const emit = (event: string, data: unknown) => {
                if (closed) return;
                try {
                  controller.enqueue(
                    encoder.encode(
                      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                    ),
                  );
                } catch {
                  // client went away mid-enqueue — stop polling immediately
                  close();
                }
              };
              emit("open", { shortId: screenShortId });
              if (first.kind === "frame") {
                emit("screen", { screen: first.screen, ts: Date.now() });
              }
              // Backpressure: skip the tick while a poll is in flight (a slow
              // `claude logs` never queues a pile-up — intermediate frames are
              // simply never produced; the next completed poll diffs against
              // the latest screen).
              const pump = () => {
                if (inFlight || closed) return;
                inFlight = true;
                void (async () => {
                  try {
                    const res = await poller.poll();
                    if (closed) return;
                    if (res.kind === "frame") {
                      emit("screen", { screen: res.screen, ts: Date.now() });
                    } else if (res.kind === "gone") {
                      emit("gone", { reason: res.reason });
                      close();
                    } else if (res.kind === "unavailable") {
                      emit("unavailable", { reason: res.reason });
                      close();
                    }
                    // "unchanged" → nothing on the wire (change-driven); the
                    // client derives the frozen-screen age from its own clock.
                  } catch {
                    close();
                  } finally {
                    inFlight = false;
                  }
                })();
              };
              timer = setInterval(pump, screenPollMs);
              // Interval cleanup on client abort — Bun fires req.signal when
              // the EventSource disconnects, in addition to stream cancel().
              req.signal.addEventListener("abort", close);
            },
            cancel() {
              closed = true;
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

        if (url.pathname === "/api/board") {
          return Response.json(await boardSnapshot.getLatest());
        }

        // CTL-733: SSE push of the shared board snapshot. The client (Board.tsx /
        // the board SharedWorker) opens ONE of these and receives a `board` event
        // on connect and on every reactive recompute — no per-tab polling.
        if (url.pathname === "/api/board/stream") {
          let unsubscribe: (() => void) | null = null;
          let closed = false;
          const send = (
            controller: ReadableStreamDefaultController<Uint8Array>,
            snap: BoardPayload,
          ) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: board\ndata: ${JSON.stringify(snap)}\n\n`),
              );
            } catch {
              // client went away between recompute and enqueue
              unsubscribe?.();
              unsubscribe = null;
            }
          };
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              // subscribe first so no recompute is missed between bootstrap + subscribe
              unsubscribe = boardSnapshot.subscribe((snap) => send(controller, snap));
              try {
                send(controller, await boardSnapshot.getLatest());
              } catch (err) {
                console.error(`[server] board stream initial snapshot failed:`, err);
              }
            },
            cancel() {
              closed = true;
              unsubscribe?.();
              unsubscribe = null;
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

        // CTL-896 (SHELL6): the nav-signal projection — worker count, queue depth,
        // board anomaly, and the daemon-health dot — as a single one-shot read for
        // the warm paint + the SSE reconcile. Derived off the SAME shared board
        // snapshot the board endpoints serve plus the local daemon health; NEVER a
        // synchronous per-request scan of the source signal files.
        if (url.pathname === "/api/nav") {
          return Response.json(
            await assembleNavSignal(await boardSnapshot.getLatest()),
          );
        }

        // CTL-896 (SHELL6): SSE push of the nav signal. The rail opens ONE of these
        // and receives a `nav` event on connect and on every reactive board
        // recompute — the live badges update without a page reload and WITHOUT
        // per-tab polling of the source files (Gherkin: "Live without thrash").
        if (url.pathname === "/api/nav/stream") {
          let unsubscribe: (() => void) | null = null;
          let closed = false;
          const sendNav = (
            controller: ReadableStreamDefaultController<Uint8Array>,
            signal: NavSignal,
          ) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: nav\ndata: ${JSON.stringify(signal)}\n\n`),
              );
            } catch {
              unsubscribe?.();
              unsubscribe = null;
            }
          };
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              // subscribe first so no recompute is missed between bootstrap +
              // subscribe; each board frame is projected into a nav signal (the
              // daemon health is re-read per frame so the dot tracks heartbeats).
              unsubscribe = boardSnapshot.subscribe((snap) => {
                void assembleNavSignal(snap).then((signal) =>
                  sendNav(controller, signal),
                );
              });
              try {
                sendNav(
                  controller,
                  await assembleNavSignal(await boardSnapshot.getLatest()),
                );
              } catch (err) {
                console.error(`[server] nav stream initial signal failed:`, err);
              }
            },
            cancel() {
              closed = true;
              unsubscribe?.();
              unsubscribe = null;
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

        // CTL-898 (SHELL8): the per-node cluster-health signal — one {host,status}
        // per running node + the single-host flag — as a one-shot read for the
        // footer's warm paint + the SSE reconcile. Projected off the SAME shared
        // board snapshot the board/nav endpoints serve plus the cluster view's
        // owner_host grouping + heartbeat liveness; NEVER a per-request scan.
        // Single-host is the exact identity no-op (one node, the local daemon).
        if (url.pathname === "/api/cluster") {
          return Response.json(
            await assembleClusterSignal(await boardSnapshot.getLatest()),
          );
        }

        // CTL-898 (SHELL8): SSE push of the cluster signal. The footer opens ONE
        // of these and receives a `cluster` event on connect and on every reactive
        // board recompute — a node going dark past its grace window flips its dot
        // to offline WITHOUT a page reload and WITHOUT per-tab polling of the
        // source files (Gherkin: "A node going dark is reflected").
        if (url.pathname === "/api/cluster/stream") {
          let unsubscribe: (() => void) | null = null;
          let closed = false;
          const sendCluster = (
            controller: ReadableStreamDefaultController<Uint8Array>,
            signal: ClusterSignal,
          ) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: cluster\ndata: ${JSON.stringify(signal)}\n\n`,
                ),
              );
            } catch {
              unsubscribe?.();
              unsubscribe = null;
            }
          };
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              // subscribe first so no recompute is missed between bootstrap +
              // subscribe; each board frame is projected into a cluster signal
              // (the heartbeat liveness is re-classified per frame so a node going
              // dark surfaces without a reload).
              unsubscribe = boardSnapshot.subscribe((snap) => {
                void assembleClusterSignal(snap).then((signal) =>
                  sendCluster(controller, signal),
                );
              });
              try {
                sendCluster(
                  controller,
                  await assembleClusterSignal(await boardSnapshot.getLatest()),
                );
              } catch (err) {
                console.error(
                  `[server] cluster stream initial signal failed:`,
                  err,
                );
              }
            },
            cancel() {
              closed = true;
              unsubscribe?.();
              unsubscribe = null;
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

  const linearSmeeChannel = opts.linearWebhookConfig?.smeeChannel ?? "";
  if (linearSmeeChannel.length > 0) {
    linearWebhookTunnel = createWebhookTunnel({
      source: linearSmeeChannel,
      target: `http://localhost:${server.port}/api/webhook/linear`,
      logger: {
        info: (m) => console.info(`[linear-tunnel] ${m}`),
        error: (m) => console.error(`[linear-tunnel] ${m}`),
      },
    });
    void linearWebhookTunnel.start().catch((err: unknown) => {
      console.error(
        `[server] linear webhook tunnel start failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
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
    boardSnapshot.stop();
    prFetcher?.stop();
    previewFetcher?.stop();
    linear?.stop();
    briefingProvider?.stop();
    void webhookTunnel?.stop();
    void linearWebhookTunnel?.stop();
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
    projectKey,
  );
  const webhookConfig =
    fullWebhookConfig &&
    fullWebhookConfig.smeeChannel.length > 0 &&
    fullWebhookConfig.secret.length > 0
      ? {
          smeeChannel: fullWebhookConfig.smeeChannel,
          secret: fullWebhookConfig.secret,
          secretEnvName: fullWebhookConfig.secretEnvName,
          watchRepos: fullWebhookConfig.watchRepos,
        }
      : null;
  const linearWebhookConfig =
    fullWebhookConfig &&
    (fullWebhookConfig.linearSecrets.length > 0 ||
      fullWebhookConfig.linearSmeeChannel.length > 0)
      ? {
          linearSecrets: fullWebhookConfig.linearSecrets,
          smeeChannel: fullWebhookConfig.linearSmeeChannel,
          botUserIds: fullWebhookConfig.linearBotUserIds.size > 0 ? fullWebhookConfig.linearBotUserIds : undefined,
          linearTeams: fullWebhookConfig.linearTeams,
        }
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
      summarizeConfig: summarizeCfg,
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
