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
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
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

  // Current monthly files are ~17MB at end-of-month; reading the whole file is
  // fast enough. If files grow significantly we can switch to chunked reads
  // from the end of the file.
  const _t0 = performance.now();
  const text = readFileSync(path, "utf8");
  recordFullRead("readBacklog", text.length, performance.now() - _t0);
  const allLines = text.split("\n").filter((l) => l.length > 0);

  if (!opts.predicate.trim()) {
    return allLines.slice(-opts.limit);
  }

  const stream = createFilterStream(opts.predicate);
  const matches: string[] = [];
  stream.onMatch((l) => matches.push(l));
  for (const l of allLines) stream.write(l);
  // Flushing the jq subprocess is a wait-on-stdout. For a 50k-line file we
  // need a few flush cycles to ensure all output drains.
  await stream.flush();
  await stream.flush();
  stream.close();
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
  // CTL-300: canonical envelope — event name lives at attributes."event.name"
  // and repo lives at attributes."vcs.repository.name".
  const attrs = evt.attributes as Record<string, unknown> | undefined;
  const eventName = attrs ? attrs["event.name"] : undefined;
  if (typeof eventName !== "string" || !eventName.startsWith("github.")) return;

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

  // File fallback (no ring, or ring underflows the 24h window).
  const _t0 = performance.now();
  let _fallbackBytes = 0;
  const currentPath = monthlyPath(catalystDir, nowDate);
  const prevPath = monthlyPath(catalystDir, cutoff24h);
  const paths = currentPath === prevPath ? [currentPath] : [prevPath, currentPath];

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    _fallbackBytes += text.length;
    for (const line of text.split("\n")) {
      accumulateGithubStat(line, cutoffIso, acc);
    }
  }
  recordFullRead("tunnelStats", _fallbackBytes, performance.now() - _t0);

  return acc;
}
