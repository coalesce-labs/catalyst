import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

export function appendToDlq(dlqPath: string, batch: unknown[]): void {
  appendFileSync(dlqPath, JSON.stringify(batch) + "\n");
}

export function drainDlq(dlqPath: string): unknown[][] {
  if (!existsSync(dlqPath)) return [];
  // EVENT-LOG-FULL-READ-OK(CTL-1529): the DLQ's contract here is "hand me EVERY
  // queued batch and delete the file", so there is no prefix that satisfies it —
  // bounding this one means converting the drain to a streaming read-and-rewrite,
  // which is a behaviour change to the delivery path, not a read-shape fix.
  // Retained deliberately as a follow-up; see the allowlist entry in
  // execution-core/event-log-read-guard.test.mjs. drainDlqBounded (below) is the
  // path production actually uses; this one has no non-test caller.
  const lines = readFileSync(dlqPath, "utf8").split("\n").filter(Boolean);
  unlinkSync(dlqPath);
  return lines.map((l: string) => JSON.parse(l));
}

// CTL-1529: counting lines does not need the file's contents in memory. The old
// implementation was `readFileSync(dlqPath, "utf8").split("\n").filter(Boolean).length`
// — a whole-file read plus a whole-file string SPLIT (two copies of the file) —
// called on otel-forward's `emitLag` timer, i.e. on a schedule, forever. The DLQ
// grows precisely during an OTLP outage, so that read was largest exactly when it
// ran most consequentially. This counts newline bytes through a fixed 64 KiB
// buffer: peak transient is one buffer regardless of DLQ size.
//
// Semantics are IDENTICAL to the old expression, deliberately: `filter(Boolean)`
// drops empty segments, which is the same as counting maximal runs of
// non-newline bytes — including an unterminated final line.
const DEPTH_CHUNK_BYTES = 64 * 1024;

export function dlqDepth(dlqPath: string): number {
  if (!existsSync(dlqPath)) return 0;
  let fd: number | null = null;
  try {
    fd = openSync(dlqPath, "r");
    const buf = Buffer.allocUnsafe(DEPTH_CHUNK_BYTES);
    let lines = 0;
    let inLine = false;
    let read: number;
    while ((read = readSync(fd, buf, 0, DEPTH_CHUNK_BYTES, null)) > 0) {
      for (let i = 0; i < read; i++) {
        if (buf[i] === 0x0a) {
          if (inLine) lines++;
          inLine = false;
        } else {
          inLine = true;
        }
      }
    }
    if (inLine) lines++; // unterminated final line still counts (parity with filter(Boolean))
    return lines;
  } catch {
    // Parity with the old behaviour on an unreadable path: report 0 rather than
    // throwing out of a best-effort telemetry tick.
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface DrainBoundedOpts {
  maxBatches?: number;
  onBatchDelivered?: (batch: unknown[]) => void;
}

// CTL-1060: bounded-per-cycle DLQ drain. Reads up to maxBatches queued batches,
// sends each via sendBatch, and stops at the first failure — requeuing that batch
// plus all remaining ones. Prevents the unbounded recursive drain that caused the
// 58k-event loss when ~589 backlogged batches blocked a single flush for hours.
export const DEFAULT_MAX_DRAIN_BATCHES = 50;

export async function drainDlqBounded(
  dlqPath: string,
  sendBatch: (batch: unknown[]) => Promise<void>,
  opts: DrainBoundedOpts = {}
): Promise<{ drained: number; remaining: number }> {
  if (!existsSync(dlqPath)) return { drained: 0, remaining: 0 };
  // EVENT-LOG-FULL-READ-OK(CTL-1529): the drain reads at most `maxBatches` lines
  // but must REWRITE the survivors (`lines.slice(survivorStart)`), so it needs the
  // whole tail as well as the head — a prefix read cannot preserve the file.
  // Bounding it is a streaming read-and-rewrite (same shape as the
  // lib/scrub-test-events.mjs case) and is a follow-up, not part of this ticket's
  // read-shape sweep. See the allowlist entry in
  // execution-core/event-log-read-guard.test.mjs for the full tradeoff.
  const lines = readFileSync(dlqPath, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return { drained: 0, remaining: 0 };

  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_DRAIN_BATCHES;
  let drained = 0;
  let failedAt = -1;

  for (let i = 0; i < lines.length && i < maxBatches; i++) {
    const batch = JSON.parse(lines[i]) as unknown[];
    try {
      await sendBatch(batch);
      opts.onBatchDelivered?.(batch);
      drained++;
    } catch {
      failedAt = i;
      break;
    }
  }

  // Survivors = failed batch (if any) + everything past the cap
  const survivorStart = failedAt >= 0 ? failedAt : Math.min(drained, maxBatches);
  const survivors = lines.slice(survivorStart);

  if (survivors.length === 0) {
    unlinkSync(dlqPath);
  } else {
    writeFileSync(dlqPath, survivors.join("\n") + "\n");
  }

  return { drained, remaining: survivors.length };
}
