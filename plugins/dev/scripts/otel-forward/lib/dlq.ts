import { existsSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

export function appendToDlq(dlqPath: string, batch: unknown[]): void {
  appendFileSync(dlqPath, JSON.stringify(batch) + "\n");
}

export function drainDlq(dlqPath: string): unknown[][] {
  if (!existsSync(dlqPath)) return [];
  const lines = readFileSync(dlqPath, "utf8").split("\n").filter(Boolean);
  unlinkSync(dlqPath);
  return lines.map((l: string) => JSON.parse(l));
}

export function dlqDepth(dlqPath: string): number {
  if (!existsSync(dlqPath)) return 0;
  return readFileSync(dlqPath, "utf8").split("\n").filter(Boolean).length;
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
