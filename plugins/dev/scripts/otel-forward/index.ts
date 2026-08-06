#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalEvent } from "../orch-monitor/lib/canonical-event.ts";
import { loadForwarderConfig } from "./lib/config.ts";
import { readCheckpoint, writeCheckpoint } from "./lib/checkpoint.ts";
import { createTailer } from "./lib/tail.ts";
import { log } from "./lib/logger.ts";
import { logDaemonHeartbeat } from "../lib/daemon-heartbeat.mjs";
import { emitProcessMemoryMetric } from "../lib/process-memory-metric.mjs"; // CTL-1517: per-process RSS/heap gauge
import { OtlpSender } from "./lib/destinations/otlp.ts";
import { PosthogSender } from "./lib/destinations/posthog.ts";
import { CloudflareAESender } from "./lib/destinations/cloudflare-ae.ts";
import {
  isFlatEvent,
  normalizeFlatEvent,
  isPinoRecord,
  normalizePinoRecord,
} from "./lib/normalize.ts";
import { dlqDepth } from "./lib/dlq.ts";
import { buildCanonicalEnvelope } from "./lib/canonical.ts";

const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const EVENTS_DIR = process.env.CATALYST_EVENTS_DIR ?? join(CATALYST_DIR, "events");
const CHECKPOINT_PATH = join(CATALYST_DIR, "otel-forward.checkpoint.json");
// CTL-1506 (Codex P1): the project key's authoritative source is Layer-1
// .catalyst/config.json (`catalyst.projectKey`), which links to the Layer-2
// config-{projectKey}.json. Resolve it in precedence order — CATALYST_PROJECT_KEY env
// override → Layer-1 key → default — so a non-default key works under the normal
// `catalyst-monitor.sh forward-start` path (which exports no env var). Absent/malformed
// Layer-1 file falls back safely to the default.
function resolveProjectKey(): string {
  if (process.env.CATALYST_PROJECT_KEY) return process.env.CATALYST_PROJECT_KEY;
  try {
    const l1 = JSON.parse(readFileSync(join(process.cwd(), ".catalyst/config.json"), "utf8"));
    const key = l1?.catalyst?.projectKey;
    if (typeof key === "string" && key) return key;
  } catch { /* absent / malformed → default */ }
  return "catalyst-workspace";
}
const PROJECT_KEY = resolveProjectKey();
// Derive the Layer-2 path from the resolved project key (config-{projectKey}.json),
// still overridable wholesale via CATALYST_CONFIG_PATH.
const CONFIG_PATH =
  process.env.CATALYST_CONFIG_PATH ??
  join(homedir(), `.config/catalyst/config-${PROJECT_KEY}.json`);

const cfg = loadForwarderConfig(CONFIG_PATH, PROJECT_KEY);
const ck = readCheckpoint(CHECKPOINT_PATH);

let stats = { processed: 0, skipped: 0 };

// CTL-1060 Phase 3: lag tracking state. lastLocalTs = newest event ts seen from the log.
// lastForwardedTs = newest event ts confirmed delivered to OTLP/Loki (seeded from checkpoint).
let lastLocalTs: string | undefined;
let lastForwardedTs: string | undefined = ck?.lastForwardedTs;

// 30-second cadence for forward_lag canonical events (CTL-1060 Phase 3).
// Tied to the OTLP/Loki path — this is the path the 2026-06-11 audit reported as "0 in Loki".
const LAG_EMIT_MS = 30_000;

/** Returns max of two ISO-8601 timestamps (or b when a is undefined). */
export function maxTs(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Returns lagMs = localNewestTs - lastForwardedTs in ms, clamped to ≥ 0. Returns 0 when either timestamp is undefined. */
export function computeLagMs(
  localNewestTs: string | undefined,
  lastForwardedTs: string | undefined
): number {
  if (!localNewestTs || !lastForwardedTs) return 0;
  const delta = Date.parse(localNewestTs) - Date.parse(lastForwardedTs);
  return delta > 0 ? delta : 0;
}

/** Builds a canonical catalyst.observability.forward_lag event for the broker/HUD pipeline. */
export function buildLagEvent(opts: {
  localNewestTs: string | undefined;
  lastForwardedTs: string | undefined;
  dlqDepth: number;
}): CanonicalEvent {
  return buildCanonicalEnvelope({
    serviceName: "catalyst.otel-forward",
    eventName: "catalyst.observability.forward_lag",
    payload: {
      lagMs: computeLagMs(opts.localNewestTs, opts.lastForwardedTs),
      localNewestTs: opts.localNewestTs,
      lastForwardedTs: opts.lastForwardedTs,
      dlqDepth: opts.dlqDepth,
    },
  });
}

const buffers: { otlp: CanonicalEvent[]; posthog: CanonicalEvent[]; cae: CanonicalEvent[] } = {
  otlp: [],
  posthog: [],
  cae: [],
};

const CURRENT_MONTH = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};
// CTL-1506 (Codex P2): resolve the monthly log file on each use, not once at startup —
// a daemon that crosses a UTC month boundary must write to the file the tailer now reads.
const currentEventLogPath = () => join(EVENTS_DIR, `${CURRENT_MONTH()}.jsonl`);

const OTLP_DLQ_PATH = join(CATALYST_DIR, "otel-forward-dlq-otlp.jsonl");

// CTL-1506 (Codex P1): module-scoped so senders can carry the shutdown signal — an
// aborted flush stops retrying and DLQs immediately, keeping shutdown inside the
// launcher's SIGKILL grace. The SIGTERM/SIGINT handlers below (in the main block) abort it.
const ac = new AbortController();

const senders = {
  otlp: cfg.otlp.enabled
    ? new OtlpSender({
        endpoint: cfg.otlp.endpoint,
        dlqPath: OTLP_DLQ_PATH,
        eventLogPath: currentEventLogPath,
        signal: ac.signal,
        // CTL-1506: age window + retry window from config
        lokiAcceptWindowMs: cfg.otlp.lokiAcceptWindowMs,
        httpRetryPolicy: { maxElapsedMs: cfg.otlp.maxRetryElapsedMs },
        // CTL-1060 Phase 3: advance lastForwardedTs on each confirmed-delivered batch
        onBatchDelivered: (batch) => {
          const batchMaxTs = batch.reduce(
            (acc, ev) => maxTs(acc, (ev as CanonicalEvent).ts),
            undefined as string | undefined
          );
          lastForwardedTs = maxTs(lastForwardedTs, batchMaxTs);
        },
      })
    : null,
  posthog: cfg.posthog.enabled
    ? new PosthogSender({
        apiKey: cfg.posthog.apiKey,
        host: cfg.posthog.host,
        dlqPath: join(CATALYST_DIR, "otel-forward-dlq-posthog.jsonl"),
      })
    : null,
  cae: cfg.cloudflareAE.enabled
    ? new CloudflareAESender({
        accountId: cfg.cloudflareAE.accountId,
        apiToken: cfg.cloudflareAE.apiToken,
        dataset: cfg.cloudflareAE.dataset,
        dlqPath: join(CATALYST_DIR, "otel-forward-dlq-cae.jsonl"),
      })
    : null,
};

function emitLag(): void {
  // CTL-1280: deterministic liveness heartbeat to otel-forward.log (Alloy→Loki),
  // emitted UNCONDITIONALLY each tick — BEFORE the cold-start skip below — so an
  // idle/quiet forwarder still proves it is alive (it previously wrote only a
  // startup line then went silent, reading as down). Rides the Alloy .log stream,
  // independent of the event pipeline this daemon itself ships.
  logDaemonHeartbeat(log, "otel-forward");
  // CTL-1517: per-process RSS/heap OTel gauge on the same tick (fire-and-forget; never
  // throws, never blocks) so per-daemon memory becomes attributable in Prometheus.
  void emitProcessMemoryMetric({ serviceName: "catalyst.otel-forward", log });
  // Skip on cold start before any event has been processed or delivered
  if (!lastLocalTs && !lastForwardedTs) return;
  try {
    const ev = buildLagEvent({
      localNewestTs: lastLocalTs,
      lastForwardedTs,
      dlqDepth: dlqDepth(OTLP_DLQ_PATH),
    });
    const logPath = currentEventLogPath(); // CTL-1506: resolve per emission (month rollover)
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(ev) + "\n");
  } catch {
    // Best-effort — must never throw
  }
}

export function processLine(line: string): void {
  try {
    let ev = JSON.parse(line) as CanonicalEvent;
    // pino BEFORE flat: an execution-core pino WARN/ERROR may carry a structured
    // `event` field (e.g. reaper.mjs), which isFlatEvent would otherwise claim
    // and strip of its severity. isPinoRecord (numeric level + string msg) never
    // matches a real flat catalyst event, so this ordering is safe (CTL-1424).
    if (isPinoRecord(ev)) ev = normalizePinoRecord(ev as unknown as Record<string, unknown>);
    else if (isFlatEvent(ev)) ev = normalizeFlatEvent(ev as unknown as Record<string, unknown>);
    if (!ev.attributes) {
      stats.skipped++;
      return;
    }
    stats.processed++;
    // Track newest local event timestamp for lag metric (CTL-1060 Phase 3)
    if (ev.ts) lastLocalTs = maxTs(lastLocalTs, ev.ts);
    if (senders.otlp) buffers.otlp.push(ev);
    if (senders.posthog) buffers.posthog.push(ev);
    if (senders.cae) buffers.cae.push(ev);
  } catch {
    stats.skipped++;
  }
}

export function getStats() {
  return { ...stats };
}

type DestKey = "otlp" | "posthog" | "cae";

// CTL-1506 (Codex P1/P2): serialize each destination's flushes INDEPENDENTLY. A sender's
// flush() opens a retry window up to maxRetryElapsedMs (default 60 s) while the flush
// timer fires far more often. A PER-DESTINATION in-flight guard keeps OTLP's DLQ access
// race-free (no two OtlpSender.flush concurrently entering drainDlqBounded against the
// same file) WITHOUT coupling healthy sinks to a slow one — a tick for PostHog/CFAE
// still flushes while OTLP is mid-retry, so their events don't sit in memory (which,
// with the checkpoint advancing, a restart could otherwise skip).
const inFlight: Record<DestKey, Promise<void> | null> = { otlp: null, posthog: null, cae: null };

function flushDest(
  key: DestKey,
  sender: { flush: (b: CanonicalEvent[]) => Promise<void> } | null,
  buffer: CanonicalEvent[]
): Promise<void> {
  if (!sender || buffer.length === 0) return Promise.resolve();
  if (inFlight[key]) return inFlight[key]!; // coalesce this destination's tick
  // CTL-1506: drain the whole buffer in a single flush() so the sender's own DLQ drain
  // runs exactly once per cycle (CTL-1060 per-cycle cap) and no spliced-out remainder can
  // be lost. batchSize is advisory only — see the config reference. A sender.flush() never
  // rejects in normal operation (it DLQs its own failures); the timer .catch below is the
  // backstop for an exceptional storage error.
  const p = sender.flush(buffer.splice(0)).finally(() => {
    inFlight[key] = null;
  });
  inFlight[key] = p;
  return p;
}

async function flushAll(): Promise<void> {
  await Promise.allSettled([
    flushDest("otlp", senders.otlp, buffers.otlp),
    flushDest("posthog", senders.posthog, buffers.posthog),
    flushDest("cae", senders.cae, buffers.cae),
  ]);
}

if (import.meta.main) {
  process.on("SIGTERM", () => {
    ac.abort();
  });
  process.on("SIGINT", () => {
    ac.abort();
  });

  const tailer = createTailer({
    eventsDir: EVENTS_DIR,
    offset: ck?.offset ?? 0,
    onLine: processLine,
    signal: ac.signal,
  });

  // CTL-1506 (Codex P2): one timer PER enabled destination at its OWN flushIntervalMs,
  // so a per-forwarder cadence actually takes effect (the old single global-min timer
  // flushed every sink at the fastest configured interval).
  // CTL-1506 (Codex P1): each timer swallows its flush rejection (logs it) — Bun treats an
  // unhandled promise rejection as fatal, so a storage/DLQ error in one destination must
  // not take down the whole daemon (the old global timer consumed rejections via allSettled).
  const onFlushError = (dest: string) => (err: unknown) =>
    log.error({ dest, err: err instanceof Error ? err.message : String(err) }, "scheduled flush failed");
  const flushTimers: ReturnType<typeof setInterval>[] = [];
  if (senders.otlp) {
    flushTimers.push(setInterval(() => {
      flushDest("otlp", senders.otlp, buffers.otlp).catch(onFlushError("otlp"));
    }, cfg.otlp.flushIntervalMs));
  }
  if (senders.posthog) {
    flushTimers.push(setInterval(() => {
      flushDest("posthog", senders.posthog, buffers.posthog).catch(onFlushError("posthog"));
    }, cfg.posthog.flushIntervalMs));
  }
  if (senders.cae) {
    flushTimers.push(setInterval(() => {
      flushDest("cae", senders.cae, buffers.cae).catch(onFlushError("cae"));
    }, cfg.cloudflareAE.flushIntervalMs));
  }

  const ckTimer = setInterval(() => {
    writeCheckpoint(CHECKPOINT_PATH, {
      path: tailer.currentPath(),
      offset: tailer.currentOffset(),
      lastForwardedTs,
    });
  }, 10_000);

  // CTL-1060 Phase 3: emit forward_lag canonical event every 30 s.
  const lagTimer = setInterval(emitLag, LAG_EMIT_MS);

  log.info(
    {
      otlpEnabled: cfg.otlp.enabled,
      posthogEnabled: cfg.posthog.enabled,
      cfaeEnabled: cfg.cloudflareAE.enabled,
    },
    "started"
  );

  await tailer.run();

  for (const t of flushTimers) clearInterval(t);
  clearInterval(ckTimer);
  clearInterval(lagTimer);
  // CTL-1506 (Codex P1): shutdown is BOUNDED. ac.abort() (from the SIGTERM/SIGINT handlers)
  // makes any in-flight retry stop and DLQ, and flushAll drains each buffer in one pass
  // (each retry now aborts fast → DLQ), so this completes well inside the launcher's grace
  // instead of waiting out a full 60s retry window.
  await Promise.allSettled(Object.values(inFlight).filter((p): p is Promise<void> => p !== null));
  await flushAll();
  log.info({ processed: stats.processed, skipped: stats.skipped }, "stopped");
}
