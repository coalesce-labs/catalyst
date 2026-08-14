/**
 * Read and tail the global Catalyst event log
 * (`~/catalyst/events/<YYYY-MM>.jsonl`). Used by the orch-monitor server to
 * fan out a filtered stream to UI clients via SSE.
 *
 * Two entry points:
 *   - `readBacklog` — synchronous-ish historical read (last N matching lines
 *     from the current month file)
 *   - `tailEventLog` — long-lived async tail with month-rotation handling
 */

import {
  existsSync,
  statSync,
  fstatSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { getEventName } from "../../lib/event-name.mjs"; // CTL-1834: THE shared event-name boundary
import { join } from "node:path";
import { createFilterStream } from "./event-filter";
import type { EventRing } from "./event-ring";

/**
 * CTL-1232 (profiling): process-wide counters for the full-log `readFileSync`
 * paths that survive the event-ring fast-path. The ring covers the common case;
 * these count the FALLBACKS (the requested window underflows the ring → a
 * whole-file read), the suspected driver of the monitor's high-water RSS. Each
 * full read of the ~190 MB+ current-month file is a large transient that Bun/
 * mimalloc rarely returns to the OS. Surfaced verbatim by GET /debug/memory so
 * the offending path + cadence can be confirmed from live traffic.
 */
export interface FullReadMetric {
  count: number;
  lastBytes: number;
  lastMs: number;
  lastTs: string;
  lastRssMB: number;
}
export const fullReadMetrics: Record<string, FullReadMetric> = {};
export function recordFullRead(label: string, bytes: number, ms: number): void {
  let m = fullReadMetrics[label];
  if (!m) {
    m = { count: 0, lastBytes: 0, lastMs: 0, lastTs: "", lastRssMB: 0 };
    fullReadMetrics[label] = m;
  }
  m.count++;
  m.lastBytes = bytes;
  m.lastMs = ms;
  m.lastTs = new Date().toISOString();
  m.lastRssMB = Math.round(process.memoryUsage().rss / 1048576);
}

function monthlyPath(catalystDir: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(catalystDir, "events", `${y}-${m}.jsonl`);
}

/**
 * CTL-1515: chunk size for {@link scanFileLines}. The bounded forward scan's
 * peak transient is one chunk, replacing the whole-file `readFileSync` that
 * allocated a single ~1.7 GB contiguous string bun/mimalloc never returns to
 * the OS.
 */
const SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB

/**
 * CTL-1515: bounded forward line scan. Reads `path` in `chunkBytes`-sized
 * chunks via `openSync`/`readSync` (peak transient = one chunk) and invokes
 * `onLine` once per `\n`-delimited line, in file order. This is the bounded
 * replacement for the ring-underflow `readFileSync` fallbacks in
 * {@link readBacklog} and {@link readTunnelEventStats}: a whole-file read of the
 * current-month log allocated one giant contiguous buffer that Bun/mimalloc
 * rarely returns to the OS.
 *
 * A `node:string_decoder` {@link StringDecoder} carries the partial line across
 * chunk edges, so a multibyte UTF-8 sequence split on a chunk boundary is
 * decoded byte-exact (never dropped or mojibake'd). The trailing empty segment
 * of a newline-terminated file is NOT emitted; a final line lacking a trailing
 * newline IS emitted. The fd is always closed (try/finally). Returns the total
 * number of bytes read.
 */
export function scanFileLines(
  path: string,
  onLine: (line: string) => void,
  chunkBytes: number = SCAN_CHUNK_BYTES,
): number {
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(chunkBytes);
  const fd = openSync(path, "r");
  // Snapshot the EOF at open so a file being appended to (a busy producer) can't
  // keep extending this scan indefinitely — read exactly the bytes present now
  // (Codex P2 on #2730).
  const snapshotSize = fstatSync(fd).size;
  let totalBytes = 0;
  let pending = "";
  try {
    let bytesRead = 0;
    // `null` position → sequential reads advancing the fd's own cursor; the
    // peak transient is one chunk (vs a whole-file readFileSync string).
    while (totalBytes < snapshotSize && (bytesRead = readSync(fd, buf, 0, Math.min(chunkBytes, snapshotSize - totalBytes), null)) > 0) {
      totalBytes += bytesRead;
      pending += decoder.write(buf.subarray(0, bytesRead));
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    }
    // Flush any bytes the decoder was holding, then emit a final unterminated
    // line (a file ending in "\n" leaves `pending` empty → nothing emitted).
    pending += decoder.end();
    if (pending.length > 0) onLine(pending);
  } finally {
    closeSync(fd);
  }
  return totalBytes;
}

/**
 * scanFileLinesAsync — CTL-1515. The async twin of {@link scanFileLines}: same
 * bounded openSync/readSync chunk scan and StringDecoder line-carry, but it
 * `await`s `onLine` per line so a consumer can apply backpressure (e.g. await a
 * jq stdin `drain()`) and keep the whole scan memory-bounded. Kept separate from
 * the sync `scanFileLines` because `readTunnelEventStats` needs the synchronous
 * form. Returns the number of bytes scanned; the fd is always closed.
 */
export async function scanFileLinesAsync(
  path: string,
  onLine: (line: string) => Promise<void> | void,
  chunkBytes: number = SCAN_CHUNK_BYTES,
): Promise<number> {
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(chunkBytes);
  const fd = openSync(path, "r");
  // Snapshot the EOF at open so a file being appended to (a busy producer) can't
  // keep extending this scan indefinitely — read exactly the bytes present now
  // (Codex P2 on #2730).
  const snapshotSize = fstatSync(fd).size;
  let totalBytes = 0;
  let pending = "";
  try {
    let bytesRead = 0;
    while (totalBytes < snapshotSize && (bytesRead = readSync(fd, buf, 0, Math.min(chunkBytes, snapshotSize - totalBytes), null)) > 0) {
      totalBytes += bytesRead;
      pending += decoder.write(buf.subarray(0, bytesRead));
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        await onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.length > 0) await onLine(pending);
  } finally {
    closeSync(fd);
  }
  return totalBytes;
}

/**
 * readTailUtf8 — CTL-1529. Read AT MOST `maxBytes` from the END of `path` and
 * return it as UTF-8 text.
 *
 * This exists because "read the whole file, then `.slice()` the tail" is a
 * whole-file read wearing a bounded read's comment. Two live sites shipped that
 * shape against files that grow without bound:
 *
 *   • `service-health-monitor.ts` — `readFileSync(<monthly event log>, "utf8")`
 *     followed by `text.slice(size - 512 KiB)`. The comment said "Cap at 512KB
 *     to bound the read"; the code materialized all 344 MB first (and the guard
 *     could not see it, because the argument was a bare `path` variable).
 *   • `stream-reader.ts` — same shape, 32 KiB, against a per-session stream log.
 *
 * The read starts at `max(0, size - maxBytes)`. When that offset is > 0 the
 * first line is a FRAGMENT (the window cut mid-record), so it is dropped —
 * every caller splits on "\n" and JSON.parses, and a truncated line's suffix
 * can otherwise parse into a bogus record (the same discipline as
 * `probeOldestTs`'s `skipFirstLine` in execution-core/event-tail.mjs). A file
 * smaller than `maxBytes` is returned in full, byte-identical to the
 * `readFileSync` it replaces.
 *
 * A `StringDecoder` is NOT needed: the whole window is decoded in one pass. The
 * window's LEADING bytes may split a multibyte sequence, but those bytes belong
 * to the dropped fragment line. Peak transient is `min(size, maxBytes)`.
 * Missing/unreadable file ⇒ "" (never throws); the fd is always closed.
 */
export function readTailUtf8(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return "";
    const cap = Math.max(1, Math.floor(maxBytes));
    const from = Math.max(0, size - cap);
    const want = size - from;
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.toString("utf8", 0, got);
    if (from === 0) return text;
    const nl = text.indexOf("\n");
    return nl === -1 ? "" : text.slice(nl + 1);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 1600;

/**
 * Idle-tick exponential backoff for the file-tail loop (CTL-473 Fix 8). On a
 * busy tick (new bytes detected) reset to base; on an idle tick double up to
 * the cap. Pure function so the schedule can be unit-tested without driving
 * the async loop.
 */
export function nextPollMs(opts: {
  prevMs: number;
  sawNewBytes: boolean;
  baseMs?: number;
  capMs?: number;
}): number {
  const base = opts.baseMs ?? BACKOFF_BASE_MS;
  const cap = opts.capMs ?? BACKOFF_CAP_MS;
  if (opts.sawNewBytes) return base;
  // Defensive: a sub-base prevMs (corrupt/initial-zero state) snaps to base
  // rather than doubling from there. Backoff begins at base.
  if (opts.prevMs < base) return base;
  return Math.min(cap, opts.prevMs * 2);
}

export interface ReadBacklogOpts {
  catalystDir: string;
  predicate: string;
  limit: number;
  /**
   * CTL-1224: shared event ring. When present and it retains at least `limit`
   * lines, the backlog is served from the in-memory ring (no full-file
   * `readFileSync`). Same underflow-guard posture as readTunnelEventStats /
   * readActivityEvents: a missing/empty/too-small ring falls back to the file
   * read so the backlog is always complete (correctness over speed).
   */
  ring?: EventRing | null;
  now?: () => Date;
}

export async function readBacklog(opts: ReadBacklogOpts): Promise<string[]> {
  // CTL-1224 ring fast-path. With no explicit sinceTs the implicit window is
  // "last N matching lines from the current month". The ring covers that iff it
  // holds at least `limit` lines (else the file may hold older matches the ring
  // already evicted → fall back). ring.query applies the SAME select(<pred>) jq
  // wrapping + the limit newest-last slice, so output is identical to the file
  // path. Empty-predicate passthrough is handled inside ring.query too.
  if (
    opts.ring &&
    opts.ring.oldestTs() !== null &&
    opts.ring.size() >= opts.limit
  ) {
    return opts.ring.query({ predicate: opts.predicate, limit: opts.limit });
  }

  const now = opts.now ?? (() => new Date());
  const path = monthlyPath(opts.catalystDir, now());
  if (!existsSync(path)) return [];

  // CTL-1515: ring-underflow fallback. Instead of a single whole-file
  // `readFileSync` (a ~1.7 GB contiguous transient bun/mimalloc never returns),
  // scan the current-month log in bounded chunks and feed each line to the same
  // filter path — output is byte-for-byte identical to the old read+split, but
  // the peak transient is one chunk.
  const _t0 = performance.now();

  if (!opts.predicate.trim()) {
    // Empty predicate: rolling last-`limit` non-empty lines (matches the old
    // `allLines.slice(-limit)`, no JSON validation).
    const rolling: string[] = [];
    const bytes = scanFileLines(path, (l) => {
      if (l.length === 0) return;
      rolling.push(l);
      if (rolling.length > opts.limit) rolling.shift();
    });
    recordFullRead("readBacklog", bytes, performance.now() - _t0);
    return rolling;
  }

  const stream = createFilterStream(opts.predicate);
  // Rolling last-`limit` buffer: a broad predicate on a huge log retains only the
  // most recent `limit` matches, never the whole file — otherwise the memory the
  // bounded scan saved just moves into this array (Codex P1 on #2730).
  const matches: string[] = [];
  stream.onMatch((l) => {
    matches.push(l);
    if (matches.length > opts.limit) matches.shift();
  });
  try {
    // scanFileLinesAsync feeds each line to jq and awaits `drain()` whenever jq's
    // stdin is backpressured — so a slow/stalled jq cannot let the whole ~1.7 GB
    // log queue into stdin (that would defeat the bounded-transient goal). Same
    // feed the old `for (const l of allLines)` loop produced; empty/invalid-JSON
    // lines are dropped inside the stream (as `.filter(l => l.length > 0)` + jq did).
    const bytes = await scanFileLinesAsync(path, async (l) => {
      if (!stream.write(l)) await stream.drain();
    });
    recordFullRead("readBacklog", bytes, performance.now() - _t0);
    // Wait for jq to emit EVERY match (it exits when stdin ends) before we return —
    // the old fixed 50ms double-flush could expire while jq still had pending
    // input/output on a large log, returning stale early matches (Codex P1 on #2730).
    await stream.end();
  } finally {
    // Always reap the jq child + its pipes, even if the scan throws mid-stream
    // (e.g. the file disappears between existsSync and openSync) — otherwise the
    // SSE caller catches the error and leaves an orphaned subprocess (CTL-1515).
    stream.close();
  }
  return matches.slice(-opts.limit);
}

export interface TailEventLogOpts {
  catalystDir: string;
  predicate: string;
  signal: AbortSignal;
  onEvent: (line: string) => void;
  pollMs?: number;
  now?: () => Date;
}

export async function tailEventLog(opts: TailEventLogOpts): Promise<void> {
  const basePollMs = opts.pollMs ?? BACKOFF_BASE_MS;
  let currentPollMs = basePollMs;
  const nowFn = opts.now ?? (() => new Date());

  if (opts.signal.aborted) return;

  const stream = createFilterStream(opts.predicate);
  stream.onMatch(opts.onEvent);

  let currentPath = monthlyPath(opts.catalystDir, nowFn());
  // Seek to EOF — we only emit *new* lines.
  let offset = existsSync(currentPath) ? statSync(currentPath).size : 0;

  try {
    while (!opts.signal.aborted) {
      // Detect month rollover. Rollover does not count as "new bytes" — the
      // next iteration will detect any newly-written content naturally.
      const expectedPath = monthlyPath(opts.catalystDir, nowFn());
      if (expectedPath !== currentPath) {
        currentPath = expectedPath;
        offset = 0;
      }

      let sawNewBytes = false;
      if (existsSync(currentPath)) {
        const size = statSync(currentPath).size;
        if (size > offset) {
          const fd = openSync(currentPath, "r");
          const len = size - offset;
          const buf = Buffer.alloc(len);
          try {
            readSync(fd, buf, 0, len, offset);
          } finally {
            closeSync(fd);
          }
          offset = size;

          const lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
          for (const l of lines) stream.write(l);
          await stream.flush();
          sawNewBytes = true;
        } else if (size < offset) {
          // File truncated/replaced — restart from beginning
          offset = 0;
        }
      }

      // CTL-473 Fix 8: back off on idle ticks. 200ms → 400ms → 800ms → 1600ms
      // cap, reset to 200ms on any non-empty tick. Drops idle-attached CPU
      // from 5 wakeups/sec to <1/sec while preserving snappy busy-tick latency.
      currentPollMs = nextPollMs({ prevMs: currentPollMs, sawNewBytes, baseMs: basePollMs });

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, currentPollMs);
        const onAbort = (): void => { clearTimeout(t); resolve(); };
        if (opts.signal.aborted) { clearTimeout(t); resolve(); return; }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    stream.close();
  }
}

export interface TunnelEventStats {
  lastEventAt: string | null;
  eventCount24h: number;
  eventCount24hByRepo: Record<string, number>;
}

/** Accumulate the github.* counts from one raw JSONL line into `acc`. */
function accumulateGithubStat(
  line: string,
  cutoffIso: string,
  acc: TunnelEventStats,
): void {
  if (!line.trim()) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  // CTL-300: canonical envelope — repo lives at attributes."vcs.repository.name".
  // CTL-1834: the NAME comes from the shared boundary, not from the v2 key alone —
  // this counter previously could not see a v1- or v3-shaped github.* line at all.
  const attrs = evt.attributes as Record<string, unknown> | undefined;
  const eventName = getEventName(evt);
  if (!eventName.startsWith("github.")) return;

  const ts = typeof evt.ts === "string" ? evt.ts : null;
  if (ts === null) return;
  if (acc.lastEventAt === null || ts > acc.lastEventAt) acc.lastEventAt = ts;
  if (ts >= cutoffIso) {
    acc.eventCount24h++;
    const repo = attrs ? attrs["vcs.repository.name"] : undefined;
    if (typeof repo === "string" && repo.length > 0) {
      acc.eventCount24hByRepo[repo] = (acc.eventCount24hByRepo[repo] ?? 0) + 1;
    }
  }
}

/**
 * Synchronously computes github.* tunnel stats over the last 24h.
 *
 * CTL-1215: when a shared event ring is supplied AND it retains history reaching
 * back past the 24h cutoff (`oldestTs() <= cutoff`), the counts are computed by
 * scanning the in-memory ring — no `readFileSync` of the (178 MB+) current-month
 * file. When no ring is supplied, or the ring underflows the window (cold start /
 * very high event rate), it falls back to the original two-file scan unchanged,
 * so counts are always correct (underflow degrades to current behavior, never to
 * wrong counts).
 *
 * Reads the current month's JSONL and, when the 24h window spans a month
 * boundary, the previous month's file too. Uses JSON.parse per line (no jq
 * subprocess) since we only need counts, not filtered content.
 */
export function readTunnelEventStats(
  catalystDir: string,
  ring?: EventRing | null,
  now: () => Date = () => new Date(),
): TunnelEventStats {
  const nowDate = now();
  const cutoff24h = new Date(nowDate.getTime() - 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff24h.toISOString();

  const acc: TunnelEventStats = {
    lastEventAt: null,
    eventCount24h: 0,
    eventCount24hByRepo: {},
  };

  // Ring fast-path: only when the ring's retained history fully covers the
  // window. oldestTs() === cutoff or earlier means no in-window event predates
  // the ring. A null oldestTs (empty ring) cannot cover the window → fallback.
  const oldest = ring ? ring.oldestTs() : null;
  if (ring && oldest !== null && oldest <= cutoffIso) {
    for (const line of ring.query()) {
      accumulateGithubStat(line, cutoffIso, acc);
    }
    return acc;
  }

  // File fallback (no ring, or ring underflows the 24h window). CTL-1515:
  // bounded chunked scan instead of a whole-file `readFileSync` (a ~1.7 GB
  // contiguous transient bun/mimalloc never returns). Counts are byte-identical
  // to the old read + `split("\n")` — `accumulateGithubStat` already no-ops on
  // blank lines.
  const _t0 = performance.now();
  let _fallbackBytes = 0;
  const currentPath = monthlyPath(catalystDir, nowDate);
  const prevPath = monthlyPath(catalystDir, cutoff24h);
  const paths = currentPath === prevPath ? [currentPath] : [prevPath, currentPath];

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    try {
      _fallbackBytes += scanFileLines(filePath, (line) => {
        accumulateGithubStat(line, cutoffIso, acc);
      });
    } catch {
      continue;
    }
  }
  recordFullRead("tunnelStats", _fallbackBytes, performance.now() - _t0);

  return acc;
}
