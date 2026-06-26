// updater.mjs — CTL-1348 / CTL-1350. The standalone catalyst-updater daemon: the
// SOLE plugin-pull owner across every node class once adopted (the broker DEFERS,
// see broker/plugin-refresh.mjs:resolvePluginPullOwner). It exists to close the
// daemonless-developer-node hole (no broker → no drift-check → stale plugins) and to
// be the out-of-band puller when a worker's broker is crash-looping (CTL-1286).
//
// CONTROL FLOW (three timers, all seam-injected for tests):
//   * pollTimer (REF'd, 90s default) — the correctness path. Calls
//     refreshAllPluginCheckouts({ pull:true }) → git fetch + reset --hard + bun install
//     per checkout root. On a daemonless dev node this is the ONLY freshness path (no
//     webhooks/phase events → the merge matchers never fire), so the interval IS the
//     CTL-1349 freshness SLA. NOT unref'd: a loop-only process that unrefs its sole
//     timer exits instantly → launchd KeepAlive thrash.
//   * heartbeatTimer (UNREF'd) — liveness. Logs the CTL-1280 `daemon heartbeat` marker
//     (component=updater) to the .log (Alloy→Loki) AND appends a DISTINCT
//     node.updater.heartbeat event. NOT node.heartbeat: readClusterHeartbeats keys
//     liveness by host.name with no emitter discriminator, so a node.heartbeat from the
//     updater would keep a host "alive" for HRW after the execution-core daemon died →
//     a stranded HRW slice. The updater's heartbeat is observability-only.
//   * eventTimer (UNREF'd) — latency optimization on nodes whose log receives merge
//     events (workers). Byte-cursor tail of the event log; a github.pr.merged / push to
//     main / phase.monitor-merge.complete triggers an immediate refresh. Best-effort:
//     the poll is the declared backstop across the UTC month-rollover of the log path.
//
// OBSERVABILITY (CTL-1350) — three signals, all reusing fleet machinery so the updater
// joins existing dashboards rather than inventing a parallel stack:
//   * Logs → a structured pino line per refresh ("updater: refresh") carrying the
//     metric values as fields. The fleet has NO in-process MeterProvider; daemon
//     "metrics" are log fields the OTEL collector's logs→metrics connector materializes
//     into Prometheus (exactly how CTL-1330's scheduler tick `total_ms` works). The
//     metric CONTRACT the OTEL side derives from these fields:
//       - catalyst.updater.refresh.duration  (Histogram, unit s)  ← refresh_duration_ms
//       - catalyst.updater.refresh.roots/pulled/changed/failed (Counter, 1) ← same fields
//       label dims: reason (poll|event|boot), catalyst.node.class
//   * Traces → emitUpdaterRefreshSpan (../tracing.mjs), OFF unless CATALYST_TRACING=on,
//     BatchSpanProcessor + AlwaysOn, OTLP→the same collector every other daemon uses.
//   * Events → node.updater.heartbeat + the plugin.checkout.* family (drift/updated/…)
//     emitted by refreshPluginCheckout through this module's canonical emitFn. Every
//     envelope carries the SAME resource identity (service.namespace=catalyst, short
//     host.name, host.id) as every other catalyst signal; service.name=catalyst.updater.

import { appendFileSync, mkdirSync, statSync, readSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  refreshAllPluginCheckouts,
  resolvePluginCheckoutRoots,
  resolveRepoFullName,
  isThisRepoMergeEvent,
  isDaemonLocalMergeSignal,
} from "../../broker/plugin-refresh.mjs";
import { getEventLogPath, getNodeClass, getHostName, HEARTBEAT_INTERVAL_MS } from "../config.mjs";
import { hostName, hostId } from "../lib/host-identity.mjs";
import { logDaemonHeartbeat } from "../../lib/daemon-heartbeat.mjs";
import { initTracing, shutdownTracing, emitUpdaterRefreshSpan } from "../tracing.mjs";

export const UPDATER_SERVICE_NAME = "catalyst.updater";
export const UPDATER_HEARTBEAT_EVENT = "node.updater.heartbeat";
export const UPDATER_NO_PLUGIN_DIRS_EVENT = "updater.no-plugin-dirs";

// 90s default (env-overridable), a NAMED constant distinct from the broker's 300s
// PLUGIN_DRIFT_CHECK_INTERVAL_MS: on daemonless dev nodes the poll is the SOLE freshness
// path so the interval IS the CTL-1349 SLA. The floor is the 60s refresh throttle.
export const UPDATER_POLL_INTERVAL_MS = Number(process.env.CATALYST_UPDATER_POLL_INTERVAL_MS) || 90_000;
// Event-tail poll cadence — cheap stat() of the log; drives the worker latency path.
export const UPDATER_EVENT_POLL_INTERVAL_MS = Number(process.env.CATALYST_UPDATER_EVENT_POLL_INTERVAL_MS) || 5_000;

const SEVERITY_NUMBER = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 };

function isoNow(nowFn = Date.now) {
  return new Date(nowFn()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// defaultLogger — pino to stderr (launchd's StandardErrorPath redirects to updater.log,
// which Alloy ships under service_name=catalyst.updater). Mirrors config.mjs's defensive
// pattern: a missing pino degrades to a console shim, never crashes the daemon. Loaded
// via createRequire (sync) so the module is usable without a top-level await.
function defaultLogger() {
  try {
    const pino = createRequire(import.meta.url)("pino");
    return pino({ name: "updater", level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
  } catch {
    const shim = (level) => (a, b) => {
      const msg = typeof a === "string" ? a : b;
      try {
        process.stderr.write(`[updater] ${level}: ${msg ?? ""}\n`);
      } catch {
        /* best-effort */
      }
    };
    return { info: shim("INFO"), warn: shim("WARN"), error: shim("ERROR"), debug: () => {} };
  }
}

/**
 * makeEmitFn — the canonical-envelope appender refreshPluginCheckout calls. Accepts the
 * broker's legacy flat shape ({ event, severity, detail }) and writes the v2 OTel
 * envelope buildCanonicalEnvelope produces (router.mjs:288-332), but stamped
 * service.name=catalyst.updater (the updater IS the emitter — NOT catalyst.broker). The
 * resource carries the same short host.name/host.id every other signal uses, plus
 * catalyst.node.class (the updater is the node-class daemon, so its own telemetry stamps
 * the class). Synchronous (refreshPluginCheckout calls emitFn inline) → appendFileSync.
 * Best-effort: a log-append failure must never break a refresh.
 */
export function makeEmitFn({ logPath = getEventLogPath(), nowFn = Date.now, nodeClass, hostNameVal } = {}) {
  const host = hostNameVal ?? getHostName();
  const cls = nodeClass ?? getNodeClass()?.class ?? null;
  return ({ event, severity, detail } = {}) => {
    try {
      const ts = isoNow(nowFn);
      const sev = severity || "INFO";
      const envelope = {
        ts,
        id: randomBytes(8).toString("hex"),
        observedTs: ts,
        severityText: sev,
        severityNumber: SEVERITY_NUMBER[sev] ?? 9,
        traceId: null,
        spanId: null,
        resource: {
          "service.name": UPDATER_SERVICE_NAME,
          "service.namespace": "catalyst",
          "host.name": hostName({ override: host }),
          "host.id": hostId({ override: host }),
          "catalyst.node.class": cls,
        },
        attributes: {
          "event.name": event,
          "event.entity": "plugin",
          "event.action": "checkout",
          "event.label": detail?.checkout ?? null,
        },
        body: { payload: detail ?? {} },
        caused_by: null,
      };
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(envelope)}\n`);
    } catch {
      /* best-effort — observability append must never break a refresh */
    }
  };
}

/**
 * buildUpdaterHeartbeatEnvelope — the node.updater.heartbeat envelope. DISTINCT from
 * execution-core's node.heartbeat (see the HRW-masking note up top). Payload carries the
 * per-checkout head shas ([{root, headSha}], empty when no pluginDirs are configured) so
 * an operator can see exactly what each node is pinned to. Pure (modulo random id + ts).
 */
export function buildUpdaterHeartbeatEnvelope({ nowFn = Date.now, nodeClass, hostNameVal, checkouts = [] } = {}) {
  const ts = isoNow(nowFn);
  const host = hostNameVal ?? getHostName();
  const cls = nodeClass ?? getNodeClass()?.class ?? null;
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": UPDATER_SERVICE_NAME,
      "service.namespace": "catalyst",
      "host.name": hostName({ override: host }),
      "host.id": hostId({ override: host }),
      "catalyst.node.class": cls,
    },
    attributes: {
      "event.name": UPDATER_HEARTBEAT_EVENT,
      "event.entity": "node",
      "event.action": "heartbeat",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        epoch: nowFn(),
        "catalyst.node.class": cls,
        roots: checkouts.length,
        checkouts, // [{ root, headSha }]
      },
    },
  };
}

// deriveRefreshTraceContext — a deterministic per-refresh trace/span id so the
// "updater: refresh" log line and the updater.refresh span share a trace_id (Loki↔Tempo
// round-trip), mirroring scheduler.mjs:deriveTickTraceContext. Folds in an epoch so each
// refresh is its own trace (no lifetime collapse).
export function deriveRefreshTraceContext({ host, reason, epoch }) {
  const seed = `${host ?? ""}:updater-refresh:${reason ?? ""}:${epoch ?? 0}`;
  const traceId = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const spanId = createHash("sha256").update(`${seed}:span`).digest("hex").slice(0, 16);
  return { traceId, spanId };
}

/**
 * runRefreshOnce — one refresh cycle: resolve roots, pull each (or detect the empty-dirs
 * misconfig), then emit all three observability signals (metric log line + span + the
 * plugin.checkout.* events the pull itself produced via emitFn). Returns the per-root
 * result array so the heartbeat can report head shas. Pure over its seams; never throws.
 *
 * @returns {{results: Array, checkouts: Array<{root,headSha}>}}
 */
export function runRefreshOnce({
  reason = "poll",
  env = process.env,
  log,
  emitFn,
  nowFn = Date.now,
  nodeClass,
  hostNameVal,
  refreshAllFn = refreshAllPluginCheckouts,
  resolveRootsFn = resolvePluginCheckoutRoots,
  state = {},
} = {}) {
  const host = hostNameVal ?? getHostName();
  const cls = nodeClass ?? getNodeClass()?.class ?? null;
  const t0 = nowFn();

  // Surface an unconfigured node ONCE (don't let a no-pluginDirs node be a silent no-op).
  let roots = [];
  try {
    roots = resolveRootsFn({ env });
  } catch {
    roots = [];
  }
  if (roots.length === 0 && !state.noPluginDirsWarned) {
    state.noPluginDirsWarned = true;
    try {
      emitFn?.({
        event: UPDATER_NO_PLUGIN_DIRS_EVENT,
        severity: "WARN",
        detail: { checkout: null, reason: "no pluginDirs configured (CATALYST_PLUGIN_DIRS / config)" },
      });
    } catch {
      /* best-effort */
    }
    log?.warn?.({ reason, roots: 0 }, "updater: no pluginDirs configured — nothing to refresh");
  }

  let results = [];
  try {
    results = refreshAllFn({ env, emitFn }) ?? [];
  } catch {
    results = [];
  }
  const t1 = nowFn();

  const pulled = results.filter((r) => r?.pulled).length;
  const changed = results.filter((r) => r?.changed).length;
  const failed = results.filter((r) => r?.failed).length;
  const checkouts = results.map((r) => ({ root: r?.root ?? null, headSha: r?.newSha ?? r?.oldSha ?? null }));

  const { traceId, spanId } = deriveRefreshTraceContext({ host, reason, epoch: t0 });

  // Metric-carrying log line (Loki → signaltometrics → Prometheus). Field names are the
  // OTEL-side contract documented up top — keep them stable.
  log?.info?.(
    {
      reason,
      roots: results.length,
      pulled,
      changed,
      failed,
      refresh_duration_ms: t1 - t0,
      "catalyst.node.class": cls,
      trace_id: traceId,
      span_id: spanId,
    },
    "updater: refresh (CTL-1350)"
  );

  // Span tree (no-op unless CATALYST_TRACING=on). Same per-refresh id as the log line.
  emitUpdaterRefreshSpan({
    reason,
    startEpochMs: t0,
    endEpochMs: t1,
    roots: results.length,
    pulled,
    changed,
    failed,
    results,
    traceId,
    spanId,
  });

  return { results, checkouts };
}

/**
 * makeEventTail — a byte-cursor tail of the unified event log that fires `onMerge(event)`
 * the first time a new line is a merge-to-main of `repoFullName` (or a daemon-local
 * phase.monitor-merge.complete). Seeded at EOF (no history replay at boot). Handles the
 * UTC month-rollover of getEventLogPath() by re-seeding at the new file's start (the new
 * month begins empty, so reading from 0 replays only genuinely-new events; the poll
 * covers any merge in the brief swap window). All fs ops are seam-injected for tests.
 */
export function makeEventTail({
  getLogPathFn = getEventLogPath,
  repoFullName,
  onMerge,
  sizeFn = (p) => statSync(p).size,
  readSliceFn = defaultReadSlice,
} = {}) {
  let curPath = getLogPathFn();
  let cursor = safeSize(curPath, sizeFn); // seed EOF
  return {
    poll() {
      const path = getLogPathFn();
      if (path !== curPath) {
        // Month rollover — switch to the new (fresh, ~empty) file at its start.
        curPath = path;
        cursor = 0;
      }
      const size = safeSize(curPath, sizeFn);
      if (size == null) return;
      if (size < cursor) cursor = 0; // truncation/rotation guard
      if (size === cursor) return;
      let slice = "";
      try {
        slice = readSliceFn(curPath, cursor, size);
      } catch {
        return;
      }
      cursor = size;
      for (const line of slice.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev;
        try {
          ev = JSON.parse(t);
        } catch {
          continue;
        }
        if (isThisRepoMergeEvent(ev, { repoFullName }) || isDaemonLocalMergeSignal(ev)) {
          onMerge?.(ev);
          return; // one refresh per drained batch; the throttle dedupes anyway
        }
      }
    },
    // exposed for assertions/tests
    _state() {
      return { curPath, cursor };
    },
  };
}

function safeSize(path, sizeFn) {
  try {
    return sizeFn(path);
  } catch {
    return null;
  }
}

// defaultReadSlice — read bytes [start,end) of a file without slurping the whole thing
// (the event log grows unbounded within a month).
function defaultReadSlice(path, start, end) {
  const len = end - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * startUpdater — arm the three timers + the (best-effort) merge-event tail. Returns a
 * { stop() } handle that clears every timer. Seam-injected so tests drive the callbacks
 * directly with no real timers/git/fs. Default seams wire the real fleet machinery.
 */
export function startUpdater({
  env = process.env,
  log = defaultLogger(),
  pollIntervalMs = UPDATER_POLL_INTERVAL_MS,
  eventPollIntervalMs = UPDATER_EVENT_POLL_INTERVAL_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  emitFn,
  refreshAllFn = refreshAllPluginCheckouts,
  resolveRootsFn = resolvePluginCheckoutRoots,
  getLogPathFn = getEventLogPath,
  repoFullName,
} = {}) {
  const nodeClass = getNodeClass()?.class ?? null;
  const hostNameVal = getHostName();
  const emit = emitFn ?? makeEmitFn({ nowFn, nodeClass, hostNameVal });
  // Resolve the repo once; null cleanly degrades the event path to poll-only.
  let repo = repoFullName;
  if (repo === undefined) {
    try {
      repo = resolveRepoFullName();
    } catch {
      repo = null;
    }
  }

  const state = { noPluginDirsWarned: false };
  let lastCheckouts = [];

  const refresh = (reason) => {
    const { checkouts } = runRefreshOnce({
      reason,
      env,
      log,
      emitFn: emit,
      nowFn,
      nodeClass,
      hostNameVal,
      refreshAllFn,
      resolveRootsFn,
      state,
    });
    if (checkouts.length) lastCheckouts = checkouts;
  };

  const heartbeat = () => {
    logDaemonHeartbeat(log, "updater"); // CTL-1280 .log liveness marker
    try {
      const line = `${JSON.stringify(buildUpdaterHeartbeatEnvelope({ nowFn, nodeClass, hostNameVal, checkouts: lastCheckouts }))}\n`;
      const logPath = getLogPathFn();
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line);
    } catch {
      /* best-effort */
    }
  };

  const tail = makeEventTail({
    getLogPathFn,
    repoFullName: repo,
    onMerge: () => refresh("event"),
  });

  // Fire once at boot, then on cadence.
  refresh("boot");
  heartbeat();

  const pollTimer = setIntervalFn(() => refresh("poll"), pollIntervalMs);
  // The poll is the daemon's reason to exist — do NOT unref it (a loop-only process that
  // unrefs its sole timer exits instantly → launchd KeepAlive thrash).
  const heartbeatTimer = setIntervalFn(heartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const eventTimer = setIntervalFn(() => tail.poll(), eventPollIntervalMs);
  eventTimer.unref?.();

  return {
    stop() {
      clearIntervalFn(pollTimer);
      clearIntervalFn(heartbeatTimer);
      clearIntervalFn(eventTimer);
    },
    // test/inspection seams
    _refresh: refresh,
    _heartbeat: heartbeat,
    _tail: tail,
  };
}

// --- entrypoint --------------------------------------------------------------
async function main() {
  const log = defaultLogger();
  // Tracing OFF unless CATALYST_TRACING=on; fire-and-forget so it never blocks boot.
  initTracing({ serviceName: UPDATER_SERVICE_NAME })
    .then((on) => {
      if (on) log.info({}, "updater: OTLP tracing enabled (CTL-1350)");
    })
    .catch(() => {});

  const handle = startUpdater({ log });
  log.info(
    { poll_interval_ms: UPDATER_POLL_INTERVAL_MS, node_class: getNodeClass()?.class ?? null },
    "updater: started (CTL-1348 — sole plugin-pull owner)"
  );

  const shutdown = (signal) => {
    log.info({ signal }, "updater: shutting down");
    handle.stop();
    shutdownTracing().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) main();
