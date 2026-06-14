import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToDlq, drainDlq, dlqDepth, drainDlqBounded } from "./dlq.ts";

describe("dlq", () => {
  test("appends and drains batches", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "a" }, { ts: "b" }] as any);
    appendToDlq(path, [{ ts: "c" }] as any);
    const batches = drainDlq(path);
    expect(batches.length).toBe(2);
    expect((batches[0][0] as { ts: string }).ts).toBe("a");
    expect((batches[1][0] as { ts: string }).ts).toBe("c");
    rmSync(dir, { recursive: true });
  });

  test("drainDlq returns empty and does not crash when file absent", () => {
    expect(drainDlq("/nonexistent/dlq.jsonl")).toEqual([]);
  });
});

describe("dlqDepth", () => {
  test("returns 0 for absent file", () => {
    expect(dlqDepth("/nonexistent/dlq.jsonl")).toBe(0);
  });

  test("returns N for N appended batches", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlqdepth-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "a" }] as any);
    appendToDlq(path, [{ ts: "b" }] as any);
    appendToDlq(path, [{ ts: "c" }] as any);
    expect(dlqDepth(path)).toBe(3);
    rmSync(dir, { recursive: true });
  });
});

describe("drainDlqBounded", () => {
  test("drains all batches when all sends succeed, returns {drained:N, remaining:0}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drained-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "a" }] as any);
    appendToDlq(path, [{ ts: "b" }] as any);
    appendToDlq(path, [{ ts: "c" }] as any);
    const sendBatch = mock(async () => {});
    const result = await drainDlqBounded(path, sendBatch);
    expect(result.drained).toBe(3);
    expect(result.remaining).toBe(0);
    expect(dlqDepth(path)).toBe(0);
    expect(sendBatch).toHaveBeenCalledTimes(3);
    rmSync(dir, { recursive: true });
  });

  test("respects maxBatches cap: drains 2 of 5, leaves 3 in FIFO order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drainbounded-"));
    const path = join(dir, "dlq.jsonl");
    for (let i = 1; i <= 5; i++) appendToDlq(path, [{ ts: String(i) }] as any);
    const sent: unknown[][] = [];
    const sendBatch = mock(async (b: unknown[]) => { sent.push(b); });
    const result = await drainDlqBounded(path, sendBatch, { maxBatches: 2 });
    expect(result.drained).toBe(2);
    expect(result.remaining).toBe(3);
    expect(dlqDepth(path)).toBe(3);
    // First 2 were sent (FIFO)
    expect((sent[0][0] as { ts: string }).ts).toBe("1");
    expect((sent[1][0] as { ts: string }).ts).toBe("2");
    rmSync(dir, { recursive: true });
  });

  test("stops at first failure, requeues failed batch + remainder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drainpause-"));
    const path = join(dir, "dlq.jsonl");
    for (let i = 1; i <= 4; i++) appendToDlq(path, [{ ts: String(i) }] as any);
    let callCount = 0;
    const sendBatch = mock(async () => {
      callCount++;
      if (callCount === 2) throw new Error("network failure");
    });
    const result = await drainDlqBounded(path, sendBatch);
    // Drained 1, stopped, requeued 3 (failed + remaining 2)
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(3);
    expect(dlqDepth(path)).toBe(3);
    // sendBatch NOT called for batches after the failure
    expect(sendBatch).toHaveBeenCalledTimes(2);
    rmSync(dir, { recursive: true });
  });

  test("absent/empty DLQ is a no-op returning {drained:0, remaining:0}", async () => {
    const sendBatch = mock(async () => {});
    const result = await drainDlqBounded("/nonexistent/dlq.jsonl", sendBatch);
    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  test("onBatchDelivered fires for each successful send, not for failed/skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draindelivered-"));
    const path = join(dir, "dlq.jsonl");
    for (let i = 1; i <= 3; i++) appendToDlq(path, [{ ts: String(i) }] as any);
    const delivered: unknown[][] = [];
    let callCount = 0;
    const sendBatch = mock(async (b: unknown[]) => {
      callCount++;
      if (callCount === 2) throw new Error("fail");
    });
    await drainDlqBounded(path, sendBatch, {
      onBatchDelivered: (b) => delivered.push(b),
    });
    // Only first batch was delivered before failure
    expect(delivered.length).toBe(1);
    expect((delivered[0][0] as { ts: string }).ts).toBe("1");
    rmSync(dir, { recursive: true });
  });
});
