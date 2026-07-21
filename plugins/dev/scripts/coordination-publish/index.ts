#!/usr/bin/env bun
// coordination-publish — CTL-1488 Phase 3.
//
// Tails the local monthly event log (events/YYYY-MM.jsonl), and for the
// COORDINATION subset (already stamped event.stream_class by the Phase 2
// builders — no re-classification here) assigns a strictly-increasing local_seq
// and writes each row to ~/catalyst/coordination.jsonl SYNCHRONOUSLY, before any
// network call (local-first). In `enforce` it also buffers the row for outbound
// publish to the catalyst-cloud hub (HubClient, retry + DLQ). In `off` the whole
// subsystem is inert: no tailer, no mirror file, no egress — byte-identical to
// pre-CTL-1488 behavior.
//
// Reuses otel-forward primitives directly (no fork): createTailer, withRetry,
// appendToDlq/drainDlqBounded.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createTailer } from "../otel-forward/lib/tail.ts";
import { HubClient } from "./lib/hub-client.ts";

export const SERVICE_NAME = "catalyst.coordination-publish";

export type CoordinationMode = "off" | "shadow" | "enforce";

export interface CoordinationCheckpoint {
  path: string;
  offset: number;
  /** High-water local_seq — the last value assigned before this checkpoint. */
  localSeq: number;
  updatedAt?: string;
}

export function readCoordinationCheckpoint(ckPath: string): CoordinationCheckpoint | null {
  if (!existsSync(ckPath)) return null;
  try {
    return JSON.parse(readFileSync(ckPath, "utf8")) as CoordinationCheckpoint;
  } catch {
    return null;
  }
}

export function writeCoordinationCheckpoint(ckPath: string, ck: Omit<CoordinationCheckpoint, "updatedAt">): void {
  writeFileSync(ckPath, JSON.stringify({ ...ck, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Seed the in-memory local_seq counter from the last line of an existing mirror,
 * so a restart WITHOUT a checkpoint still continues the sequence instead of
 * renumbering from 1. Absent/empty/malformed → 0. Never throws.
 */
export function seedLocalSeqFromMirror(mirrorPath: string): number {
  if (!existsSync(mirrorPath)) return 0;
  try {
    const lines = readFileSync(mirrorPath, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) return 0;
    const last = JSON.parse(lines[lines.length - 1]) as { local_seq?: unknown };
    return typeof last.local_seq === "number" ? last.local_seq : 0;
  } catch {
    return 0;
  }
}

export interface HubClientLike {
  publish(batch: Array<Record<string, unknown>>): Promise<void>;
}

export interface PublisherOpts {
  mode: CoordinationMode;
  mirrorPath: string;
  checkpointPath: string;
  signal: AbortSignal;
  /** Pin the events file (tests). Otherwise resolved from eventsDir + UTC month. */
  filePath?: string;
  eventsDir?: string;
  hubClient?: HubClientLike;
  pollMs?: number;
}

export interface CoordinationPublisher {
  processLine: (line: string) => void;
  drain: () => Promise<void>;
  run: () => Promise<void>;
  flushToHub: () => Promise<void>;
  saveCheckpoint: () => void;
  currentLocalSeq: () => number;
  outboundDepth: () => number;
  getStats: () => { written: number; skipped: number };
}

export function createCoordinationPublisher(opts: PublisherOpts): CoordinationPublisher {
  const inert = opts.mode === "off";
  const ck = readCoordinationCheckpoint(opts.checkpointPath);
  let localSeq = ck ? ck.localSeq : seedLocalSeqFromMirror(opts.mirrorPath);
  const outbound: Array<Record<string, unknown>> = [];
  const stats = { written: 0, skipped: 0 };

  function processLine(line: string): void {
    if (inert) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      stats.skipped++;
      return;
    }
    const attrs = obj.attributes as Record<string, unknown> | undefined;
    // Read the ALREADY-stamped stream class (Phase 2). Fail-closed: a line that
    // lacks the stamp is treated as non-coordination and never mirrored.
    if (attrs?.["event.stream_class"] !== "coordination") {
      stats.skipped++;
      return;
    }
    localSeq++;
    const record = { ...obj, local_seq: localSeq };
    // LOCAL-FIRST: synchronous mirror append BEFORE any network buffering.
    mkdirSync(dirname(opts.mirrorPath), { recursive: true });
    appendFileSync(opts.mirrorPath, JSON.stringify(record) + "\n");
    stats.written++;
    if (opts.mode === "enforce") outbound.push(record);
  }

  const tailer = inert
    ? null
    : createTailer({
        filePath: opts.filePath,
        eventsDir: opts.eventsDir ?? "",
        offset: ck?.offset ?? 0,
        onLine: processLine,
        signal: opts.signal,
        pollMs: opts.pollMs,
      });

  async function drain(): Promise<void> {
    if (!tailer) return;
    await tailer.drain();
  }

  async function run(): Promise<void> {
    if (!tailer) return; // mode off — resolve immediately, touch nothing
    await tailer.run();
  }

  async function flushToHub(): Promise<void> {
    if (!opts.hubClient || outbound.length === 0) return;
    const batch = outbound.splice(0);
    await opts.hubClient.publish(batch);
  }

  function saveCheckpoint(): void {
    if (!tailer) return;
    writeCoordinationCheckpoint(opts.checkpointPath, {
      path: tailer.currentPath(),
      offset: tailer.currentOffset(),
      localSeq,
    });
  }

  return {
    processLine,
    drain,
    run,
    flushToHub,
    saveCheckpoint,
    currentLocalSeq: () => localSeq,
    outboundDepth: () => outbound.length,
    getStats: () => ({ ...stats }),
  };
}

// --- Entrypoint (not unit-tested) -----------------------------------------
if (import.meta.main) {
  // Computed specifier defeats TS static resolution of the untyped .mjs config
  // module (the same trick as orch-monitor/server.ts:4419) — avoids TS7016.
  const configSpecifier = ["../execution-core/config.mjs"].join("");
  const { readCoordinationConfig, getCoordinationMirrorPath } = await import(configSpecifier);
  const cfg = readCoordinationConfig();
  if (cfg.mode === "off") {
    // Inert: no process work, byte-identical to pre-CTL-1488.
    process.exit(0);
  }

  const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
  const EVENTS_DIR = process.env.CATALYST_EVENTS_DIR ?? join(CATALYST_DIR, "events");
  const MIRROR_PATH = (getCoordinationMirrorPath as () => string)();
  const CHECKPOINT_PATH = resolve(CATALYST_DIR, "coordination-publish.checkpoint.json");
  const DLQ_PATH = resolve(CATALYST_DIR, "coordination-publish-dlq.jsonl");
  const monthPath = () => {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(EVENTS_DIR, `${ym}.jsonl`);
  };
  const EVENT_LOG_PATH = monthPath();

  const ac = new AbortController();
  process.on("SIGTERM", () => ac.abort());
  process.on("SIGINT", () => ac.abort());

  const hubClient =
    cfg.mode === "enforce" && cfg.hubUrl
      ? new HubClient({ hubUrl: cfg.hubUrl, dlqPath: DLQ_PATH, eventLogPath: EVENT_LOG_PATH })
      : undefined;

  const pub = createCoordinationPublisher({
    mode: cfg.mode as CoordinationMode,
    eventsDir: EVENTS_DIR,
    mirrorPath: MIRROR_PATH,
    checkpointPath: CHECKPOINT_PATH,
    signal: ac.signal,
    hubClient,
  });

  const ckTimer = setInterval(() => pub.saveCheckpoint(), 10_000);
  const flushTimer =
    cfg.mode === "enforce" ? setInterval(() => void pub.flushToHub(), 1000) : null;

  // CTL-1488 Phase 5: INBOUND mirror-tail — only in enforce (shadow is local-mirror-only, no pull).
  // Hub HTTP transport when hubUrl is set; otherwise the interim Loki-tail source (fail-open) so the
  // mirror still converges cross-host on a slower cadence. The merge logic never branches on transport.
  let inboundTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.mode === "enforce") {
    const { createMirrorTailClient, createHubChangeSource } = await import("./lib/mirror-tail-client.ts");
    let source;
    if (cfg.hubUrl) {
      source = createHubChangeSource({ hubUrl: cfg.hubUrl });
    } else {
      const lokiUrlSpecifier = ["../execution-core/config.mjs"].join("");
      const { getLokiQueryUrl } = await import(lokiUrlSpecifier);
      const lokiUrl = (getLokiQueryUrl as () => string | null)();
      if (lokiUrl) {
        const { createLokiFetcher } = await import("../orch-monitor/lib/loki.ts");
        const { createLokiChangeSource } = await import("./lib/interim-loki-source.ts");
        source = createLokiChangeSource({
          lokiFetcher: createLokiFetcher({ baseUrl: lokiUrl }),
          nowMs: Date.now(),
        });
      }
    }
    if (source) {
      const inbound = createMirrorTailClient({ mirrorPath: MIRROR_PATH, source, signal: ac.signal });
      inboundTimer = setInterval(() => void inbound.tick(), 2000);
    }
  }

  // eslint-disable-next-line no-console
  console.error(`[coordination-publish] started mode=${cfg.mode} hub=${cfg.hubUrl ?? "(none)"}`);
  await pub.run();

  clearInterval(ckTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (inboundTimer) clearInterval(inboundTimer);
  await pub.flushToHub();
  pub.saveCheckpoint();
}
