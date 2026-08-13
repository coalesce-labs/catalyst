// otlp-degenerate-exactness.test.ts — CTL-1823.
//
// The defect this suite pins: CTL-1817 incremented `degenerateRecordCount` inside
// `buildOtlpPayload`, which is the SERIALIZER. It runs once per `rawSend` ATTEMPT (it sits
// inside `withHttpRetry`) and again on every DLQ drain — so the same record was re-counted on
// every OTLP retry and once more on replay. The counter therefore INFLATED exactly during
// backend trouble, i.e. precisely when an operator would read it. An inflating counter is
// worse than a missing one: it invites a wrong conclusion about the scope of the loss.
//
// The fix moves the count to BATCH ACCEPT (`OtlpSender.flush` entry) — the one point at which
// each record is seen exactly once (index.ts's `flushDest` hands `buffer.splice(0)` to a single
// `flush()`, so no record enters twice).
//
// WHY THESE TESTS DRIVE `OtlpSender.flush` AND NOT THE MAPPER: a test that calls
// `buildOtlpPayload` directly cannot observe the defect at all — the retry loop and the drain
// are exactly the machinery that produced the double-count, and calling the mapper skips both.
// That mistake was the round-1 P1 on CTL-1817. Every exactness assertion below therefore runs
// through the real public path with a transport that really fails and really retries, and each
// carries its own positive control asserting the retry/drain actually happened — a "counted
// once" that passes because the transport never retried would be vacuous.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OtlpSender,
  buildOtlpPayload,
  degenerateRecordTotal,
  noteDegenerateRecords,
  resetDegenerateRecordTotal,
} from "./otlp.ts";
import { dlqDepth } from "../dlq.ts";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";

// CTL-1818: a flush can reach the host-local drop surface, whose marker defaults to
// `$CATALYST_DIR/otel-forward-drops.json`. Pin CATALYST_DIR into a throwaway directory so a
// local `bun test` cannot overwrite a real ~/catalyst marker belonging to a running forwarder.
// Re-asserted per test, not only at file scope: bun runs every test file in one process and
// the drop-surface suite restores CATALYST_DIR to whatever it found first.
const TEST_CATALYST_DIR = mkdtempSync(join(tmpdir(), "otlp-degen-catalyst-dir-"));
process.env.CATALYST_DIR = TEST_CATALYST_DIR;

const dir = mkdtempSync(join(tmpdir(), "otlp-degen-exactness-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(TEST_CATALYST_DIR, { recursive: true, force: true });
});

const ENDPOINT = "http://127.0.0.1:4318";
// Never let the CTL-1506 age partition remove a record before it reaches the network path —
// this suite is about the retry/drain path, not about aging.
const NO_AGING = Number.MAX_SAFE_INTEGER;

/** The degenerate shape: a bare `name` envelope — no `attributes`, no `body`. */
const degenerate = (name: string): CanonicalEvent =>
  ({ name, ts: new Date().toISOString(), severityText: "INFO", severityNumber: 9 }) as unknown as CanonicalEvent;

/** A healthy v2 record — resolves a body AND carries attributes, so it is never degenerate. */
const healthy = (name: string): CanonicalEvent =>
  ({
    ts: new Date().toISOString(),
    severityText: "INFO",
    severityNumber: 9,
    resource: { "service.name": "catalyst.execution-core", "service.namespace": "catalyst" },
    attributes: { "event.name": name },
    body: { message: name },
  }) as unknown as CanonicalEvent;

/** A pino-shaped recorder so the alarm sink can be asserted without writing a real log. */
function makeLog() {
  const calls: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const mk = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    calls.push({ level, obj, msg });
  return { calls, warn: mk("warn"), error: mk("error"), info: mk("info") };
}

beforeEach(() => {
  process.env.CATALYST_DIR = TEST_CATALYST_DIR;
  resetDegenerateRecordTotal();
});

describe("CTL-1823 — the count is a RECORD count, not a send-attempt count", () => {
  test("a degenerate record survives three send attempts and is counted exactly once", async () => {
    let attempts = 0;
    global.fetch = mock(() => {
      attempts++;
      // 503 is retryable (classifyStatus), so the first two attempts re-enter rawSend —
      // and therefore re-enter the serializer, which is where the old counter lived.
      return Promise.resolve(new Response(null, { status: attempts < 3 ? 503 : 200 }));
    }) as unknown as typeof fetch;

    const sender = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath: join(dir, "retry-dlq.jsonl"),
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { baseMs: 0, maxElapsedMs: 60_000 },
      retryClock: { sleep: async () => {} },
    });
    await sender.flush([degenerate("phase.rescue.escalated.PROJ-1832")]);

    // POSITIVE CONTROL — without this, "counted once" would also pass on a transport that
    // never retried, which is the vacuous version of this test.
    expect(attempts).toBe(3);
    expect(degenerateRecordTotal()).toBe(1);
  });

  test("a DLQ replay does not count the record a second time", async () => {
    const dlqPath = join(dir, "replay-dlq.jsonl");

    // Phase A — backend down. The record is counted on accept, then dead-lettered.
    global.fetch = mock(() => Promise.reject(new Error("backend down"))) as unknown as typeof fetch;
    const failing = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath,
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });
    await failing.flush([degenerate("phase.rescue.escalated.PROJ-1832")]);
    expect(degenerateRecordTotal()).toBe(1);
    // POSITIVE CONTROL — the record really is queued for replay; otherwise phase B would
    // "not double-count" only because there was nothing left to replay.
    expect(dlqDepth(dlqPath)).toBe(1);

    // Phase B — backend healthy. A fresh flush delivers, which triggers the bounded drain,
    // which re-sends (and so re-serializes) the dead-lettered degenerate record.
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;
    const healthySender = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath,
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });
    await healthySender.flush([healthy("recovery.tick")]);

    // POSITIVE CONTROL — the drain actually consumed the entry.
    expect(dlqDepth(dlqPath)).toBe(0);
    expect(degenerateRecordTotal()).toBe(1);
  });

  // The ticket's required anti-vacuity control: a dedupe that suppressed genuinely distinct
  // records would satisfy every assertion above and be plainly wrong. The fix is a RELOCATION
  // of the count, not a dedupe, so two different records in one batch must still count twice.
  test("two genuinely distinct degenerate records in one batch each count", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;

    const sender = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath: join(dir, "distinct-dlq.jsonl"),
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });
    await sender.flush([
      degenerate("phase.rescue.escalated.PROJ-1"),
      degenerate("phase.rescue.dispatched.PROJ-2"),
    ]);

    expect(degenerateRecordTotal()).toBe(2);
  });

  test("a healthy batch never moves the counter, even at batch accept", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;

    const sender = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath: join(dir, "healthy-dlq.jsonl"),
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });
    await sender.flush([healthy("recovery.tick"), healthy("session.heartbeat")]);

    expect(degenerateRecordTotal()).toBe(0);
  });

  // Pins the RELOCATION itself, from the other side: serialization is no longer an accounting
  // event. If a future edit moves the increment back into the mapper, this fails immediately
  // rather than only under a retrying transport.
  test("the mapper itself no longer counts — serialization is not an accounting event", () => {
    buildOtlpPayload([degenerate("phase.rescue.escalated.PROJ-1832")]);
    expect(degenerateRecordTotal()).toBe(0);
  });
});

describe("CTL-1823 — the warning cannot flood the log surface it protects", () => {
  test("10,000 degenerate records of one shape are all counted, through the real flush path", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;

    const sender = new OtlpSender({
      endpoint: ENDPOINT,
      dlqPath: join(dir, "flood-dlq.jsonl"),
      lokiAcceptWindowMs: NO_AGING,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });
    await sender.flush(
      Array.from({ length: 10_000 }, () => degenerate("phase.rescue.escalated.PROJ-1832")),
    );

    expect(degenerateRecordTotal()).toBe(10_000);
  });

  // Sparsity is a property of the counting seam itself, so it is asserted at that seam with an
  // injected recorder log (the same shape drop-surface.test.ts uses). The exactness tests above
  // are what prove `flush` routes through this seam in production.
  test("the count is exact while the alarm is sparse — 10,000 records, 5 log lines", () => {
    const log = makeLog();
    noteDegenerateRecords(
      Array.from({ length: 10_000 }, () => degenerate("phase.rescue.escalated.PROJ-1832")),
      { log },
    );

    expect(degenerateRecordTotal()).toBe(10_000);
    const warns = log.calls.filter((c) => c.level === "warn");
    // First sighting of the shape (total 1), then the log10 heartbeats at 10/100/1000/10000.
    expect(warns.length).toBe(5);
    expect(warns[0]!.obj.event).toBe("phase.rescue.escalated.PROJ-1832");
    // The LAST line still carries the true running total — a sparse alarm must not become an
    // undercount, which is the failure mode the sparsification could have introduced.
    expect(warns[warns.length - 1]!.obj.degenerate_total).toBe(10_000);
  });

  // POSITIVE CONTROL for the sparsity test: the gate must still speak for a shape it has never
  // seen. A gate that simply never warned would pass "bounded" trivially.
  test("a newly-seen shape still produces its first-sighting warning", () => {
    const log = makeLog();
    noteDegenerateRecords([degenerate("phase.orphan-pr.detected.3324")], { log });

    const warns = log.calls.filter((c) => c.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj.event).toBe("phase.orphan-pr.detected.3324");
  });
});
