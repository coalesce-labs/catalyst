#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../orch-monitor/lib/canonical-event.ts";
import { loadForwarderConfig } from "./lib/config.ts";
import { readCheckpoint, writeCheckpoint } from "./lib/checkpoint.ts";
import { createTailer } from "./lib/tail.ts";
import { log } from "./lib/logger.ts";
import { OtlpSender } from "./lib/destinations/otlp.ts";
import { PosthogSender } from "./lib/destinations/posthog.ts";
import { CloudflareAESender } from "./lib/destinations/cloudflare-ae.ts";
import { isFlatEvent, normalizeFlatEvent } from "./lib/normalize.ts";

const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const EVENTS_DIR = process.env.CATALYST_EVENTS_DIR ?? join(CATALYST_DIR, "events");
const CHECKPOINT_PATH = join(CATALYST_DIR, "otel-forward.checkpoint.json");
const CONFIG_PATH = process.env.CATALYST_CONFIG_PATH
  ?? join(homedir(), ".config/catalyst/config-catalyst-workspace.json");
const PROJECT_KEY = process.env.CATALYST_PROJECT_KEY ?? "catalyst-workspace";

const cfg = loadForwarderConfig(CONFIG_PATH, PROJECT_KEY);
const ck = readCheckpoint(CHECKPOINT_PATH);

let stats = { processed: 0, skipped: 0 };

const buffers: { otlp: CanonicalEvent[]; posthog: CanonicalEvent[]; cae: CanonicalEvent[] } =
  { otlp: [], posthog: [], cae: [] };

const senders = {
  otlp: cfg.otlp.enabled ? new OtlpSender({ endpoint: cfg.otlp.endpoint, dlqPath: join(CATALYST_DIR, "otel-forward-dlq-otlp.jsonl") }) : null,
  posthog: cfg.posthog.enabled ? new PosthogSender({ apiKey: cfg.posthog.apiKey, host: cfg.posthog.host, dlqPath: join(CATALYST_DIR, "otel-forward-dlq-posthog.jsonl") }) : null,
  cae: cfg.cloudflareAE.enabled ? new CloudflareAESender({ accountId: cfg.cloudflareAE.accountId, apiToken: cfg.cloudflareAE.apiToken, dataset: cfg.cloudflareAE.dataset, dlqPath: join(CATALYST_DIR, "otel-forward-dlq-cae.jsonl") }) : null,
};

export function processLine(line: string): void {
  try {
    let ev = JSON.parse(line) as CanonicalEvent;
    if (isFlatEvent(ev)) ev = normalizeFlatEvent(ev as unknown as Record<string, unknown>);
    if (!ev.attributes) { stats.skipped++; return; }
    stats.processed++;
    if (senders.otlp) buffers.otlp.push(ev);
    if (senders.posthog) buffers.posthog.push(ev);
    if (senders.cae) buffers.cae.push(ev);
  } catch { stats.skipped++; }
}

export function getStats() { return { ...stats }; }

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
  process.on("SIGTERM", () => { ac.abort(); });
  process.on("SIGINT", () => { ac.abort(); });

  const tailer = createTailer({
    eventsDir: EVENTS_DIR,
    offset: ck?.offset ?? 0,
    onLine: processLine,
    signal: ac.signal,
  });

  const FLUSH_MS = Math.min(cfg.otlp.flushIntervalMs, cfg.posthog.flushIntervalMs, cfg.cloudflareAE.flushIntervalMs);
  const flushTimer = setInterval(flush, FLUSH_MS);

  const ckTimer = setInterval(() => {
    writeCheckpoint(CHECKPOINT_PATH, { path: tailer.currentPath(), offset: tailer.currentOffset() });
  }, 10_000);

  log.info(
    {
      otlpEnabled: cfg.otlp.enabled,
      posthogEnabled: cfg.posthog.enabled,
      cfaeEnabled: cfg.cloudflareAE.enabled,
    },
    "started",
  );

  await tailer.run();

  clearInterval(flushTimer);
  clearInterval(ckTimer);
  await flush();
  log.info(
    { processed: stats.processed, skipped: stats.skipped },
    "stopped",
  );
}
