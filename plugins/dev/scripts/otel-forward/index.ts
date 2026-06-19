#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalEvent } from "../orch-monitor/lib/canonical-event.ts";
import { loadForwarderConfig } from "./lib/config.ts";
import { readCheckpoint, writeCheckpoint } from "./lib/checkpoint.ts";
import { createTailer } from "./lib/tail.ts";
import { log } from "./lib/logger.ts";
import { logDaemonHeartbeat } from "../lib/daemon-heartbeat.mjs";
import { OtlpSender } from "./lib/destinations/otlp.ts";
import { PosthogSender } from "./lib/destinations/posthog.ts";
import { CloudflareAESender } from "./lib/destinations/cloudflare-ae.ts";
import { isFlatEvent, normalizeFlatEvent } from "./lib/normalize.ts";
import { dlqDepth } from "./lib/dlq.ts";
import { buildCanonicalEnvelope } from "./lib/canonical.ts";

const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const EVENTS_DIR = process.env.CATALYST_EVENTS_DIR ?? join(CATALYST_DIR, "events");
const CHECKPOINT_PATH = join(CATALYST_DIR, "otel-forward.checkpoint.json");
const CONFIG_PATH =
  process.env.CATALYST_CONFIG_PATH ??
  join(homedir(), ".config/catalyst/config-catalyst-workspace.json");
const PROJECT_KEY = process.env.CATALYST_PROJECT_KEY ?? "catalyst-workspace";

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
export function computeLagMs(localNewestTs: string | undefined, lastForwardedTs: string | undefined): number {
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
const EVENT_LOG_PATH = join(EVENTS_DIR, `${CURRENT_MONTH()}.jsonl`);

const OTLP_DLQ_PATH = join(CATALYST_DIR, "otel-forward-dlq-otlp.jsonl");

const senders = {
  otlp: cfg.otlp.enabled
    ? new OtlpSender({
        endpoint: cfg.otlp.endpoint,
        dlqPath: OTLP_DLQ_PATH,
        eventLogPath: EVENT_LOG_PATH,
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
  // Skip on cold start before any event has been processed or delivered
  if (!lastLocalTs && !lastForwardedTs) return;
  try {
    const ev = buildLagEvent({
      localNewestTs: lastLocalTs,
      lastForwardedTs,
      dlqDepth: dlqDepth(OTLP_DLQ_PATH),
    });
    mkdirSync(dirname(EVENT_LOG_PATH), { recursive: true });
    appendFileSync(EVENT_LOG_PATH, JSON.stringify(ev) + "\n");
  } catch {
    // Best-effort — must never throw
  }
}

export function processLine(line: string): void {
  try {
    let ev = JSON.parse(line) as CanonicalEvent;
    if (isFlatEvent(ev)) ev = normalizeFlatEvent(ev as unknown as Record<string, unknown>);
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

async function flush(): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (senders.otlp && buffers.otlp.length > 0) {
    const batch = buffers.otlp.splice(0);
    tasks.push(senders.otlp.flush(batch));
  }
  if (senders.posthog && buffers.posthog.length > 0) {
    const batch = buffers.posthog.splice(0);
    tasks.push(senders.posthog.flush(batch));
  }
  if (senders.cae && buffers.cae.length > 0) {
    const batch = buffers.cae.splice(0);
    tasks.push(senders.cae.flush(batch));
  }
  await Promise.allSettled(tasks);
}

if (import.meta.main) {
  const ac = new AbortController();
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

  const FLUSH_MS = Math.min(
    cfg.otlp.flushIntervalMs,
    cfg.posthog.flushIntervalMs,
    cfg.cloudflareAE.flushIntervalMs
  );
  const flushTimer = setInterval(flush, FLUSH_MS);

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

  clearInterval(flushTimer);
  clearInterval(ckTimer);
  clearInterval(lagTimer);
  await flush();
  log.info({ processed: stats.processed, skipped: stats.skipped }, "stopped");
}
