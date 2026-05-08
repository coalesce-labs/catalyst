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

function monthlyPath(catalystDir: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(catalystDir, "events", `${y}-${m}.jsonl`);
}

export interface ReadBacklogOpts {
  catalystDir: string;
  predicate: string;
  limit: number;
  now?: () => Date;
}

export async function readBacklog(opts: ReadBacklogOpts): Promise<string[]> {
  const now = opts.now ?? (() => new Date());
  const path = monthlyPath(opts.catalystDir, now());
  if (!existsSync(path)) return [];

  // Current monthly files are ~17MB at end-of-month; reading the whole file is
  // fast enough. If files grow significantly we can switch to chunked reads
  // from the end of the file.
  const text = readFileSync(path, "utf8");
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
  const pollMs = opts.pollMs ?? 200;
  const nowFn = opts.now ?? (() => new Date());

  if (opts.signal.aborted) return;

  const stream = createFilterStream(opts.predicate);
  stream.onMatch(opts.onEvent);

  let currentPath = monthlyPath(opts.catalystDir, nowFn());
  // Seek to EOF — we only emit *new* lines.
  let offset = existsSync(currentPath) ? statSync(currentPath).size : 0;

  try {
    while (!opts.signal.aborted) {
      // Detect month rollover
      const expectedPath = monthlyPath(opts.catalystDir, nowFn());
      if (expectedPath !== currentPath) {
        currentPath = expectedPath;
        offset = 0;
      }

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

          const text = buf.toString("utf8");
          const lines = text.split("\n").filter((l) => l.length > 0);
          for (const l of lines) stream.write(l);
          await stream.flush();
        } else if (size < offset) {
          // File truncated/replaced — restart from beginning
          offset = 0;
        }
      }

      // Sleep with abort responsiveness
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        const onAbort = (): void => {
          clearTimeout(t);
          resolve();
        };
        if (opts.signal.aborted) {
          clearTimeout(t);
          resolve();
          return;
        }
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

/**
 * Synchronously scans monthly event log files for github.* events.
 *
 * Reads the current month's JSONL and, when the 24h window spans a month
 * boundary, the previous month's file too. Uses JSON.parse per line (no jq
 * subprocess) since we only need counts, not filtered content.
 */
export function readTunnelEventStats(
  catalystDir: string,
  now: () => Date = () => new Date(),
): TunnelEventStats {
  const nowDate = now();
  const cutoff24h = new Date(nowDate.getTime() - 24 * 60 * 60 * 1000);

  const currentPath = monthlyPath(catalystDir, nowDate);
  const prevPath = monthlyPath(catalystDir, cutoff24h);
  const paths = currentPath === prevPath ? [currentPath] : [prevPath, currentPath];

  let lastEventAt: string | null = null;
  let eventCount24h = 0;
  const eventCount24hByRepo: Record<string, number> = {};

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // CTL-300: canonical envelope — event name lives at attributes."event.name"
      // and repo lives at attributes."vcs.repository.name".
      const attrs = evt.attributes as Record<string, unknown> | undefined;
      const eventName = attrs ? attrs["event.name"] : undefined;
      if (typeof eventName !== "string" || !eventName.startsWith("github.")) {
        continue;
      }

      const ts = typeof evt.ts === "string" ? evt.ts : null;
      if (ts !== null) {
        if (lastEventAt === null || ts > lastEventAt) lastEventAt = ts;
        if (ts >= cutoff24h.toISOString()) {
          eventCount24h++;
          const repo = attrs ? attrs["vcs.repository.name"] : undefined;
          if (typeof repo === "string" && repo.length > 0) {
            eventCount24hByRepo[repo] = (eventCount24hByRepo[repo] ?? 0) + 1;
          }
        }
      }
    }
  }

  return { lastEventAt, eventCount24h, eventCount24hByRepo };
}
