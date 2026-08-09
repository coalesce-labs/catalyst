import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

  // ── CTL-1529: the count is chunked, and byte-for-byte identical to the
  // whole-file `readFileSync(...).split("\n").filter(Boolean).length` it replaced.
  // The ORACLE below is that exact old expression, so any divergence in the new
  // chunked scanner fails here rather than silently mis-reporting DLQ depth (the
  // number otel-forward publishes as a lag metric).
  const oracleDepth = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).length;

  test("matches the old whole-file expression ACROSS a chunk boundary (>64 KiB)", () => {
    // The DLQ grows precisely during an OTLP outage — the multi-chunk path is the
    // realistic one, and it is the only path the single-chunk tests never take.
    const dir = mkdtempSync(join(tmpdir(), "dlqdepth-big-"));
    const path = join(dir, "dlq.jsonl");
    const pad = "x".repeat(1000);
    const n = 300; // ~300 KB ⇒ ~5 chunks at DEPTH_CHUNK_BYTES = 64 KiB
    for (let i = 0; i < n; i++) appendToDlq(path, [{ ts: `e${i}`, pad }] as any);
    expect(dlqDepth(path)).toBe(n);
    expect(dlqDepth(path)).toBe(oracleDepth(path));
    rmSync(dir, { recursive: true });
  });

  test("an UNTERMINATED final line counts, exactly as filter(Boolean) did", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlqdepth-partial-"));
    const path = join(dir, "dlq.jsonl");
    writeFileSync(path, '[{"ts":"a"}]\n[{"ts":"b"}]'); // no trailing newline
    expect(dlqDepth(path)).toBe(2);
    expect(dlqDepth(path)).toBe(oracleDepth(path));
    rmSync(dir, { recursive: true });
  });

  test("blank lines are NOT counted (parity with filter(Boolean)) and an empty file is 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlqdepth-blank-"));
    const withBlanks = join(dir, "blanks.jsonl");
    writeFileSync(withBlanks, '\n\n[{"ts":"a"}]\n\n[{"ts":"b"}]\n\n');
    expect(dlqDepth(withBlanks)).toBe(2);
    expect(dlqDepth(withBlanks)).toBe(oracleDepth(withBlanks));

    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(dlqDepth(empty)).toBe(0);
    expect(dlqDepth(empty)).toBe(oracleDepth(empty));
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

// CTL-1506 Phase 4: DrainOutcome "dropped" support
describe("drainDlqBounded — DrainOutcome (CTL-1506)", () => {
  test("callback returning 'dropped' consumes the entry, does NOT fire onBatchDelivered, continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-dropped-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "1" }] as any);
    appendToDlq(path, [{ ts: "2" }] as any);
    appendToDlq(path, [{ ts: "3" }] as any);

    const delivered: unknown[][] = [];
    let callCount = 0;
    const sendBatch = mock(async (b: unknown[]) => {
      callCount++;
      if (callCount === 2) return "dropped" as const; // batch 2 dropped
      return undefined; // deliver
    });

    const result = await drainDlqBounded(path, sendBatch, {
      onBatchDelivered: (b) => delivered.push(b),
    });

    expect(result.drained).toBe(2);
    expect(result.dropped).toBe(1);
    expect(result.remaining).toBe(0);
    expect(dlqDepth(path)).toBe(0);
    // onBatchDelivered NOT called for the dropped batch
    expect(delivered.length).toBe(2);
    expect((delivered[0][0] as { ts: string }).ts).toBe("1");
    expect((delivered[1][0] as { ts: string }).ts).toBe("3");
    rmSync(dir, { recursive: true });
  });

  test("callback returning void still counts as delivered (backward-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-void-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "1" }] as any);
    const sendBatch = mock(async () => {});
    const result = await drainDlqBounded(path, sendBatch);
    expect(result.drained).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("throwing callback stops and requeues failed batch + remainder (unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-throw-"));
    const path = join(dir, "dlq.jsonl");
    for (let i = 1; i <= 4; i++) appendToDlq(path, [{ ts: String(i) }] as any);
    let callCount = 0;
    const sendBatch = mock(async () => {
      callCount++;
      if (callCount === 2) throw new Error("fail");
    });
    const result = await drainDlqBounded(path, sendBatch);
    expect(result.drained).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(3);
    expect(dlqDepth(path)).toBe(3);
    rmSync(dir, { recursive: true });
  });

  test("mixed sequence: deliver → drop → throw → correct counts and file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-mixed-"));
    const path = join(dir, "dlq.jsonl");
    for (let i = 1; i <= 5; i++) appendToDlq(path, [{ ts: String(i) }] as any);
    let callCount = 0;
    const sendBatch = mock(async () => {
      callCount++;
      if (callCount === 2) return "dropped" as const;
      if (callCount === 3) throw new Error("fail");
    });
    const result = await drainDlqBounded(path, sendBatch);
    // batch 1: delivered, batch 2: dropped, batch 3: throws → failedAt=2
    // survivors = lines from index 2 onwards = batches 3,4,5
    expect(result.drained).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.remaining).toBe(3);
    expect(dlqDepth(path)).toBe(3);
    // Verify survivor file starts from the thrown batch (ts="3")
    const survivors = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ts: string }[]);
    expect(survivors[0][0].ts).toBe("3");
    expect(survivors[1][0].ts).toBe("4");
    expect(survivors[2][0].ts).toBe("5");
    rmSync(dir, { recursive: true });
  });
});
