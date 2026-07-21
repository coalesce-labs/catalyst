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

/**
 * The current UTC monthly event-log path — the same `<eventsDir>/YYYY-MM.jsonl`
 * shape the reused otel-forward tailer (`defaultMonthPath`) resolves. Kept here so
 * the checkpoint month-gate below compares against the exact file the tailer opens.
 */
export function currentEventLogPath(eventsDir: string): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(eventsDir, `${ym}.jsonl`);
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
 * Read the mirror ONCE at startup, returning both the last local_seq high-water AND the set of event
 * ids already mirrored. Absent/empty/malformed → {lastLocalSeq:0, ids:∅}. Never throws.
 *
 * The id set is what makes a restart exactly-once for the LOCAL append path: the tailer checkpoint
 * (offset + local_seq) is written on a periodic timer, so a crash between a mirror append and the next
 * checkpoint flush leaves the checkpoint's offset BEHIND the last-mirrored line. On restart the tailer
 * re-reads those lines; without a dedup they'd be re-appended (same id, re-derived local_seq). Seeding
 * the seen-set from the mirror makes processLine skip an already-present id.
 */
export function readMirrorState(mirrorPath: string): { lastLocalSeq: number; ids: Set<string> } {
  const ids = new Set<string>();
  if (!existsSync(mirrorPath)) return { lastLocalSeq: 0, ids };
  try {
    const lines = readFileSync(mirrorPath, "utf8").split("\n").filter(Boolean);
    let lastLocalSeq = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { id?: unknown; local_seq?: unknown };
        if (typeof obj.id === "string") ids.add(obj.id);
        if (typeof obj.local_seq === "number") lastLocalSeq = obj.local_seq;
      } catch {
        // skip malformed line
      }
    }
    return { lastLocalSeq, ids };
  } catch {
    return { lastLocalSeq: 0, ids };
  }
}

/**
 * Seed the in-memory local_seq counter from the last line of an existing mirror,
 * so a restart WITHOUT a checkpoint still continues the sequence instead of
 * renumbering from 1. Absent/empty/malformed → 0. Never throws.
 */
export function seedLocalSeqFromMirror(mirrorPath: string): number {
  return readMirrorState(mirrorPath).lastLocalSeq;
}

export interface HubClientLike {
  publish(batch: Array<Record<string, unknown>>): Promise<void>;
  /** Drain any queued DLQ backlog independently of a fresh outbound batch (Codex P1). */
  drainDlq?: () => Promise<void>;
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
  // Read the mirror ONCE: the checkpoint owns the local_seq counter when present; the id set is always
  // needed so a periodic-checkpoint restart can't double-append an already-mirrored line (review #3).
  const mirrorState = readMirrorState(opts.mirrorPath);
  // Seed from the AUTHORITATIVE mirror high-water, never the checkpoint alone (review #1 / CTL-1488
  // remediate). The checkpoint is flushed on a 10s timer while the mirror is appended continuously,
  // so a present checkpoint's localSeq LAGS the mirror high-water whenever a line was mirrored after
  // the last flush. On restart the tailer re-reads those already-mirrored lines; the id-dedup skips
  // re-appending them but would leave localSeq frozen at the stale ck.localSeq, so the next genuinely
  // new line reuses a local_seq already assigned to a mirrored row — breaking the strictly-increasing/
  // unique invariant. mirrorState.lastLocalSeq is always >= ck.localSeq, so Math.max is safe.
  let localSeq = ck ? Math.max(ck.localSeq, mirrorState.lastLocalSeq) : mirrorState.lastLocalSeq;
  const seenIds = mirrorState.ids;
  // CTL-1488 (Codex P1): reuse the checkpoint byte-offset ONLY when it belongs to the
  // file we're about to tail. After a UTC month rollover the tailer opens the new
  // month's log, but a stale ck.offset from the previous month would start the read
  // mid-file — permanently skipping the new month's initial lines whenever that file
  // already grew past the old offset while the daemon was down. The checkpoint records
  // `path` for exactly this comparison; on a mismatch (or absent checkpoint) start at 0.
  // The id-dedup (seenIds) + mirror-seeded localSeq keep a from-zero re-read exactly-once.
  const initialTailPath = opts.filePath ?? currentEventLogPath(opts.eventsDir ?? "");
  const startOffset = ck && ck.path === initialTailPath ? ck.offset : 0;
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
    // Restart dedup (review #3): the periodic checkpoint can lag a mirror append, so on restart the
    // tailer re-reads already-mirrored lines. Skip an id already in the mirror so the append path is
    // exactly-once (no duplicate row, no wasted local_seq).
    const eventId = typeof obj.id === "string" ? obj.id : "";
    if (eventId && seenIds.has(eventId)) {
      stats.skipped++;
      return;
    }
    // Assign the next local_seq speculatively; commit it (and seenIds/outbound/
    // stats) ONLY after the mirror write succeeds, so a write fault leaves no
    // local_seq gap.
    const nextSeq = localSeq + 1;
    const record = { ...obj, local_seq: nextSeq };
    // LOCAL-FIRST: synchronous mirror append BEFORE any network buffering.
    mkdirSync(dirname(opts.mirrorPath), { recursive: true });
    try {
      appendFileSync(opts.mirrorPath, JSON.stringify(record) + "\n");
    } catch (err) {
      // A mirror-write fault (ENOSPC/EACCES) must not crash the never-crash
      // daemon. The tailer already advanced its offset past this line, so it
      // won't be retried — degrade to a skipped line WITHOUT advancing
      // localSeq/seenIds/outbound/stats.written (no permanent seq gap).
      console.error("[coordination-publish] mirror write failed, skipping line", err);
      stats.skipped++;
      return;
    }
    // Commit only after the write succeeded.
    localSeq = nextSeq;
    if (eventId) seenIds.add(eventId);
    stats.written++;
    if (opts.mode === "enforce") outbound.push(record);
  }

  const tailer = inert
    ? null
    : createTailer({
        filePath: opts.filePath,
        eventsDir: opts.eventsDir ?? "",
        offset: startOffset,
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

  let flushing = false;
  async function flushToHub(): Promise<void> {
    // In-flight guard: flushToHub is void-called on a 1s timer, so a slow publish could overlap
    // the next tick. Skipping while one is in flight keeps a single publisher and avoids
    // double-publishing the same rows.
    if (!opts.hubClient || flushing) return;
    flushing = true;
    try {
      if (outbound.length > 0) {
        // Snapshot without removing: splice ONLY after publish() resolves, so a publish() that throws
        // (HubClient.publish is documented never-throw, but a DLQ ENOSPC/EACCES or corrupt-line edge can
        // still reject) leaves the batch in `outbound` to retry next tick instead of losing it from
        // egress with no DLQ entry and no degraded event (CTL-1488 remediate: silent egress loss).
        // publish() also drains any DLQ backlog on a successful delivery.
        const batchSize = outbound.length;
        await opts.hubClient.publish(outbound.slice(0, batchSize));
        // Remove only the rows we published; rows appended by the tailer during the await stay queued.
        outbound.splice(0, batchSize);
      } else if (opts.hubClient.drainDlq) {
        // No new outbound rows, but a prior outage may have left a DLQ backlog that publish()'s
        // post-success drain never reaches (Codex P1). Attempt an independent drain so a recovered
        // hub catches up instead of stranding queued rows until the next coordination event arrives.
        await opts.hubClient.drainDlq();
      }
    } finally {
      flushing = false;
    }
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
  const EVENT_LOG_PATH = currentEventLogPath(EVENTS_DIR);

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
  // Catch inside the timer callback (review #2): flushToHub's try/finally rethrows on a publish()
  // rejection (the DLQ ENOSPC/EACCES edge where HubClient.publish is NOT throw-proof). Fire-and-
  // forgetting it (`void`) would surface that as a recurring unhandledRejection every second — no
  // handler is installed — which under bun/node can terminate the never-crash daemon or flood the
  // log. Degrade a throwing publish to a logged retry instead.
  const flushTimer =
    cfg.mode === "enforce"
      ? setInterval(() => {
          pub.flushToHub().catch((e) => console.error("[coordination-publish] flush failed", e));
        }, 1000)
      : null;

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
        // No nowMs: the source defaults to a live Date.now clock evaluated per-pull, so the
        // interim inbound window slides forward instead of freezing at daemon-start (CTL-1488).
        source = createLokiChangeSource({
          lokiFetcher: createLokiFetcher({ baseUrl: lokiUrl }),
        });
      }
    }
    if (source) {
      // eventLogPath makes a sustained inbound outage observable (coordination_mirror_tail_degraded),
      // mirroring the outbound HubClient's degraded signal (CTL-1488 remediate).
      const inbound = createMirrorTailClient({
        mirrorPath: MIRROR_PATH,
        source,
        signal: ac.signal,
        eventLogPath: EVENT_LOG_PATH,
      });
      inboundTimer = setInterval(() => {
        // Match the flush timer: a future uncaught throw in tick() must not
        // become an unhandledRejection that terminates the never-crash daemon.
        inbound.tick().catch((e) => console.error("[coordination-mirror-tail] tick failed", e));
      }, 2000);
    }
  }

  // eslint-disable-next-line no-console
  console.error(`[coordination-publish] started mode=${cfg.mode} hub=${cfg.hubUrl ?? "(none)"}`);
  await pub.run();

  clearInterval(ckTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (inboundTimer) clearInterval(inboundTimer);
  // Guard the shutdown flush so a DLQ/hub I/O fault can't kill the process
  // before saveCheckpoint() persists the byte-offset/local_seq checkpoint.
  await pub.flushToHub().catch((e) => console.error("[coordination-publish] shutdown flush failed", e));
  pub.saveCheckpoint();
}
