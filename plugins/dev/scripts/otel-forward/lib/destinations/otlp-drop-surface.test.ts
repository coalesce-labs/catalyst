// otlp-drop-surface.test.ts — CTL-1818. The wiring: every discard the OTLP sender makes
// must land on the host-local surface, INCLUDING the discards that emit no event at all.
//
// `emitDrop` returns early on two conditions before it writes
// `catalyst.observability.forward_dropped` — no `eventLogPath`, and `isSelfBatch` — so those
// discards are today invisible on every surface: they never ride the DLQ (aged records are
// dropped before send), the checkpoint keeps advancing, and no event is written either.
// The accounting therefore has to happen BEFORE both guards; these tests pin that ordering.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test lib/destinations/otlp-drop-surface.test.ts
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { OtlpSender } from "./otlp.ts";
import { dropSurfaceSnapshot, resetDropSurfaceForTest, configureDropSurface } from "../drop-surface.ts";

const SAMPLE_EVENT: CanonicalEvent = {
  ts: "2026-08-13T00:00:00Z",
  id: "11111111-2222-4333-8444-555555555555",
  observedTs: "2026-08-13T00:00:00Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: null,
  spanId: null,
  resource: {
    "service.name": "catalyst.session",
    "service.namespace": "catalyst" as const,
    "service.version": "8.2.0",
    "host.name": "test-host",
    "host.id": "test-id-0000",
  },
  attributes: { "event.name": "session.heartbeat" },
  body: { message: "heartbeat", payload: null },
};

const makeAged = (): CanonicalEvent => ({
  ...SAMPLE_EVENT,
  ts: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
});
const makeFresh = (): CanonicalEvent => ({ ...SAMPLE_EVENT, ts: new Date().toISOString() });
const makeAgedSelf = (): CanonicalEvent => ({
  ...makeAged(),
  resource: { ...SAMPLE_EVENT.resource, "service.name": "catalyst.otel-forward" },
  attributes: { "event.name": "catalyst.observability.forward_dropped" },
});

describe("OtlpSender → host-local drop surface (CTL-1818)", () => {
  let dir: string;
  let savedCatalystDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-drop-surface-"));
    savedCatalystDir = process.env.CATALYST_DIR;
    // Pin the default marker location into the temp dir so the suite can never clobber a
    // real ~/catalyst/otel-forward-drops.json on a developer machine.
    process.env.CATALYST_DIR = dir;
    resetDropSurfaceForTest();
    configureDropSurface({ windowMs: 60_000, thresholdRecords: 1_000_000, sustainMs: 60_000 });
  });
  afterEach(() => {
    resetDropSurfaceForTest();
    if (savedCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = savedCatalystDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an aged drop with NO event log configured still increments the surface", async () => {
    // The event sink is unavailable here, which is precisely the case emitDrop's first guard
    // returns on today — leaving the discard with no surface whatsoever.
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "dlq-noeventlog.jsonl"),
      lokiAcceptWindowMs: 3_600_000,
      // deliberately no eventLogPath
    });

    await sender.flush([makeAged(), makeAged()]);

    expect(dropSurfaceSnapshot().totals.aged).toEqual({ events: 1, records: 2 });
    expect(existsSync(join(dir, "otel-forward-drops.json"))).toBe(true);
  });

  test("a self-batch aged drop is counted even though its event is loop-guarded away", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const eventLogPath = join(dir, "events-self.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "dlq-self.jsonl"),
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });

    await sender.flush([makeAgedSelf()]);

    // isSelfBatch suppresses the event (no re-amplification) — the surface must not be
    // suppressed with it, or the forwarder's own losses stay unmeasurable.
    const emitted = existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8").trim() : "";
    expect(emitted).toBe("");
    expect(dropSurfaceSnapshot().totals.aged).toEqual({ events: 1, records: 1 });
  });

  test("the surface still updates when the OTLP endpoint is unreachable", async () => {
    // The scenario an event-based consumer cannot satisfy: nothing can leave this host, so
    // any alarm that rides the forwarded stream reads clean.
    global.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath: join(dir, "dlq-unreachable.jsonl"),
      eventLogPath: join(dir, "events-unreachable.jsonl"),
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: 3_600_000,
    });

    await sender.flush([makeAged(), makeFresh()]);

    expect(dropSurfaceSnapshot().totals.aged).toEqual({ events: 1, records: 1 });
  });

  test("a terminal 4xx drop is counted under its own reason", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "dlq-terminal.jsonl"),
      eventLogPath: join(dir, "events-terminal.jsonl"),
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });

    await sender.flush([makeFresh(), makeFresh()]);

    expect(dropSurfaceSnapshot().totals.terminal_4xx).toEqual({ events: 1, records: 2 });
  });

  test("a delivered batch touches the surface at all — it stays at zero", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "dlq-ok.jsonl"),
      eventLogPath: join(dir, "events-ok.jsonl"),
      lokiAcceptWindowMs: 3_600_000,
    });

    await sender.flush([makeFresh()]);

    expect(dropSurfaceSnapshot().totals).toEqual({});
  });

  // POSITIVE CONTROL (the ticket's required scenario). With the recorder replaced by a
  // no-op — the test-only bypass — the exact same aged discard leaves the surface unchanged.
  // If this ever passes at the same time as the first test above, one of the two is lying.
  test("with the drop recorder bypassed, the same aged discard changes nothing", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "dlq-bypass.jsonl"),
      lokiAcceptWindowMs: 3_600_000,
      dropRecorder: () => {}, // bypass
    });

    await sender.flush([makeAged(), makeAged()]);

    expect(dropSurfaceSnapshot().totals).toEqual({});
    expect(existsSync(join(dir, "otel-forward-drops.json"))).toBe(false);
  });
});
