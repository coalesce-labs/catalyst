/**
 * event-ring.ts — CTL-1215.
 *
 * ONE process-wide, incrementally-maintained in-memory ring of the most-recent
 * raw event-log lines. Built on the same byte-offset tail mechanics as
 * `tailEventLog` (event-log-reader.ts) — openSync/readSync the EOF delta, split
 * on "\n", push — but it RETAINS a bounded window of lines so per-request
 * consumers can scan recent history WITHOUT `readFileSync`-ing the whole
 * (178 MB+) current-month file on every call.
 *
 * The template is the read-model pattern: one source loop, fan-out to many
 * queries at zero per-query file cost. Consumers that need a longer window than
 * the ring retains use `oldestTs()` to detect underflow and fall back to their
 * existing bounded file read (correctness over speed — underflow degrades to
 * current behavior, never to wrong counts).
 *
 * No producer/format change. jq-predicate queries reuse the EXACT wrapping the
 * CLI + createFilterStream use (`select(<pred>)`) via a synchronous `jq`
 * subprocess over the in-memory lines, so filter semantics stay identical.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface EventRingOpts {
  catalystDir: string;
  /** Max raw lines retained. Default 50k (~minutes-to-hours at fleet rate). */
  capLines?: number;
  /** Poll interval for the tail loop. Default 1s. */
  pollMs?: number;
  /** Max bytes back-read from the tail of an existing file at cold start. */
  tailBytes?: number;
  now?: () => Date;
}

export interface EventRingQuery {
  /** jq predicate (wrapped in select(...)); omitted = no jq filter. */
  predicate?: string;
  /** ISO timestamp; lines with ts < sinceTs are excluded (JS parse, no jq). */
  sinceTs?: string;
  /** Return at most this many newest-matching lines (newest-last). */
  limit?: number;
}

export interface EventRing {
  /** Idempotent; cold-fills from the file tail, then begins the poll loop. */
  start(): void;
  /** Clears the timer; for server.stop(). */
  stop(): void;
  /** Most-recent matching raw lines, newest-last, scanning the ring only. */
  query(opts?: EventRingQuery): string[];
  /** Oldest ts currently retained, or null when empty. For underflow detection. */
  oldestTs(): string | null;
  /** Current retained line count. */
  size(): number;
  /**
   * CTL-1224: register a listener fired synchronously with each batch of
   * newly-appended raw lines from the LIVE tick (NOT cold-fill / start()).
   * Returns a deregister fn. Cold-fill lines are backlog, not live events, so
   * firing them would replay history as live frames — they are deliberately
   * excluded. Listener exceptions are swallowed so one bad subscriber cannot
   * stall the shared tick loop for everyone.
   */
  onAppend(listener: (lines: string[]) => void): () => void;
  /** CTL-1224: current onAppend listener count. Test/debug seam only. */
  listenerCount(): number;
}

const DEFAULT_CAP_LINES = 50_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024; // 8 MB cold-start back-read

function monthlyPath(catalystDir: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(catalystDir, "events", `${y}-${m}.jsonl`);
}

/** Parse a line's `ts` field (string) without throwing; null on any failure. */
function lineTs(line: string): string | null {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    return typeof ts === "string" ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Run a jq predicate over the given lines synchronously, returning the matches.
 * Uses the SAME `select(<pred>)` wrapping as createFilterStream / the CLI so
 * filter semantics are identical. A jq spawn failure fails open to [] (the
 * caller's fallback path covers correctness for the windowed consumers).
 */
function jqFilterSync(predicate: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  try {
    const r = Bun.spawnSync({
      cmd: ["jq", "-c", `select(${predicate})`],
      // jq dies on invalid JSON; the ring only ever holds lines that parsed at
      // ingest, but trailing blank lines are filtered before this call.
      stdin: new TextEncoder().encode(lines.join("\n") + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(r.stdout ?? new Uint8Array());
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export function createEventRing(opts: EventRingOpts): EventRing {
  const capLines = opts.capLines ?? DEFAULT_CAP_LINES;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const nowFn = opts.now ?? (() => new Date());

  // The ring: a plain array, newest at the end. Capped by trimming the front.
  let ring: string[] = [];
  let currentPath = "";
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  // CTL-1224: live fan-out listeners. Fired synchronously after a NOTIFYING
  // push (tick appends only — never cold-fill) with the batch of new lines.
  const appendListeners = new Set<(lines: string[]) => void>();

  // `notify` distinguishes live tick appends (true) from cold-fill backlog
  // (false). When true, registered onAppend listeners receive the batch of
  // actually-pushed (non-empty) lines AFTER the front-trim.
  function pushLines(lines: string[], notify: boolean): void {
    const added: string[] = [];
    for (const l of lines) {
      if (l.length > 0) {
        ring.push(l);
        added.push(l);
      }
    }
    if (ring.length > capLines) {
      ring = ring.slice(ring.length - capLines);
    }
    if (notify && added.length > 0) {
      for (const fn of appendListeners) {
        try {
          fn(added);
        } catch {
          /* a bad subscriber must not stall the shared tick loop (CTL-1224) */
        }
      }
    }
  }

  // Read [from, size) of `path` and push the (non-partial) lines. Returns the
  // new offset. When `from > 0` the first split fragment may be a partial line —
  // but we only call with from>0 on the incremental delta read, where `from` is
  // always a previous EOF (a line boundary), so no partial occurs there. The
  // cold-start back-read passes from>0 and drops the first fragment explicitly.
  // `notify` is threaded to pushLines so cold-fill (notify=false) never replays
  // history as live frames; only the live tick (notify=true) fans out.
  function readDelta(
    path: string,
    from: number,
    size: number,
    dropFirst: boolean,
    notify: boolean,
  ): void {
    if (size <= from) return;
    const fd = openSync(path, "r");
    const len = size - from;
    const buf = Buffer.alloc(len);
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    let parts = buf.toString("utf8").split("\n");
    if (dropFirst && parts.length > 0) parts = parts.slice(1);
    pushLines(parts, notify);
  }

  function coldFill(path: string): void {
    if (!existsSync(path)) {
      offset = 0;
      return;
    }
    const size = statSync(path).size;
    if (size <= tailBytes) {
      // Whole file fits the cold-start budget — read it all.
      readDelta(path, 0, size, false, /* notify */ false);
    } else {
      // Back-read only the tail; drop the first (partial) line.
      readDelta(path, size - tailBytes, size, true, /* notify */ false);
    }
    offset = size;
  }

  function tick(): void {
    const expectedPath = monthlyPath(opts.catalystDir, nowFn());
    if (expectedPath !== currentPath) {
      // Month rollover: keep the existing ring (cross-month history stays
      // queryable until aged out), reset offset for the new file.
      currentPath = expectedPath;
      offset = 0;
    }
    if (!existsSync(currentPath)) return;
    const size = statSync(currentPath).size;
    if (size > offset) {
      readDelta(currentPath, offset, size, false, /* notify */ true);
      offset = size;
    } else if (size < offset) {
      // truncated/replaced — restart from beginning
      offset = 0;
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      currentPath = monthlyPath(opts.catalystDir, nowFn());
      coldFill(currentPath);
      timer = setInterval(tick, pollMs);
      // Bun/Node: don't keep the process alive for this background poller.
      if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },
    query(q: EventRingQuery = {}): string[] {
      let lines = ring;
      if (q.predicate && q.predicate.trim()) {
        lines = jqFilterSync(q.predicate, lines);
      }
      if (q.sinceTs) {
        const since = q.sinceTs;
        lines = lines.filter((l) => {
          const ts = lineTs(l);
          return ts !== null && ts >= since;
        });
      }
      if (typeof q.limit === "number") {
        return lines.slice(Math.max(0, lines.length - q.limit));
      }
      // Return a copy so callers can't mutate the ring.
      return lines === ring ? ring.slice() : lines;
    },
    oldestTs(): string | null {
      for (const l of ring) {
        const ts = lineTs(l);
        if (ts !== null) return ts;
      }
      return null;
    },
    size(): number {
      return ring.length;
    },
    onAppend(listener: (lines: string[]) => void): () => void {
      appendListeners.add(listener);
      return () => {
        appendListeners.delete(listener);
      };
    },
    listenerCount(): number {
      return appendListeners.size;
    },
  };
}
