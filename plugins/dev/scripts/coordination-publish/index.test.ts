import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCoordinationPublisher,
  seedLocalSeqFromMirror,
  readCoordinationCheckpoint,
} from "./index.ts";

// A minimal canonical envelope with a stamped event.stream_class (Phase 2 output).
function evLine(name: string, streamClass: "coordination" | "telemetry", extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      ts: "2026-07-21T00:00:00Z",
      id: `id-${name}-${JSON.stringify(extra)}`,
      attributes: { "event.name": name, "event.stream_class": streamClass },
      body: { payload: {} },
      ...extra,
    }) + "\n"
  );
}

function mirrorRecords(mirrorPath: string): Array<Record<string, unknown>> {
  if (!existsSync(mirrorPath)) return [];
  return readFileSync(mirrorPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("createCoordinationPublisher — local-first mirror (CTL-1488 Phase 3)", () => {
  let dir: string, eventsDir: string, filePath: string, mirrorPath: string, checkpointPath: string;
  let ac: AbortController;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1488-cp-"));
    eventsDir = join(dir, "events");
    mkdirSync(eventsDir, { recursive: true });
    filePath = join(eventsDir, "2026-07.jsonl");
    mirrorPath = join(dir, "coordination.jsonl");
    checkpointPath = join(dir, "coordination-publish.checkpoint.json");
    ac = new AbortController();
  });
  afterEach(() => {
    ac.abort();
    rmSync(dir, { recursive: true, force: true });
  });

  test("coordination lines land in coordination.jsonl with strictly-increasing local_seq (before any network)", async () => {
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination", { id: "a" }));
    appendFileSync(filePath, evLine("phase.implement.complete.CTL-2", "coordination", { id: "b" }));

    let publishCalled = false;
    const pub = createCoordinationPublisher({
      mode: "shadow",
      filePath,
      mirrorPath,
      checkpointPath,
      signal: ac.signal,
      hubClient: { publish: async () => { publishCalled = true; } },
    });
    await pub.drain();

    const recs = mirrorRecords(mirrorPath);
    expect(recs.length).toBe(2);
    expect(recs[0].local_seq).toBe(1);
    expect(recs[1].local_seq).toBe(2);
    expect((recs[1].local_seq as number) > (recs[0].local_seq as number)).toBe(true);
    // The original envelope is preserved alongside local_seq.
    expect((recs[0].attributes as Record<string, unknown>)["event.name"]).toBe("phase.plan.complete.CTL-1");
    // shadow never touches the network.
    expect(publishCalled).toBe(false);
  });

  test("telemetry lines are tailed but never written to coordination.jsonl", async () => {
    writeFileSync(filePath, evLine("host.metrics.sampled", "telemetry"));
    appendFileSync(filePath, evLine("session.heartbeat", "telemetry"));
    appendFileSync(filePath, evLine("phase.pr.complete.CTL-3", "coordination", { id: "c" }));

    const pub = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub.drain();

    const recs = mirrorRecords(mirrorPath);
    expect(recs.length).toBe(1);
    expect((recs[0].attributes as Record<string, unknown>)["event.name"]).toBe("phase.pr.complete.CTL-3");
  });

  test("a line missing event.stream_class is treated as non-coordination (fail-closed)", async () => {
    writeFileSync(filePath, JSON.stringify({ ts: "t", id: "x", attributes: { "event.name": "phase.plan.complete.CTL-9" } }) + "\n");
    const pub = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub.drain();
    expect(mirrorRecords(mirrorPath).length).toBe(0);
  });

  test("restart resumes from checkpoint byte offset AND local_seq high-water (no dup/renumber)", async () => {
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination", { id: "a" }));
    const pub1 = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub1.drain();
    pub1.saveCheckpoint();
    expect(mirrorRecords(mirrorPath).length).toBe(1);
    expect(readCoordinationCheckpoint(checkpointPath)?.localSeq).toBe(1);

    // Append a new line and start a fresh publisher from the saved checkpoint.
    appendFileSync(filePath, evLine("phase.verify.complete.CTL-2", "coordination", { id: "b" }));
    const pub2 = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub2.drain();

    const recs = mirrorRecords(mirrorPath);
    expect(recs.length).toBe(2); // no re-append of the first line
    expect(recs[0].local_seq).toBe(1);
    expect(recs[1].local_seq).toBe(2); // continues the high-water, not restart at 1
  });

  test("a lagged-checkpoint restart does NOT double-append an already-mirrored line (dedup by event id)", async () => {
    // Round 1: mirror one coordination line, but DON'T save the checkpoint (simulate a crash before
    // the periodic checkpoint flush).
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination", { id: "evt-a" }));
    const pub1 = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub1.drain();
    expect(mirrorRecords(mirrorPath).length).toBe(1);
    // No saveCheckpoint() → the checkpoint is absent/behind.

    // Round 2: a fresh publisher with NO checkpoint re-reads from offset 0 (re-processing evt-a) and
    // also sees a genuinely new line. evt-a must NOT be re-appended; only evt-b lands.
    appendFileSync(filePath, evLine("phase.verify.complete.CTL-2", "coordination", { id: "evt-b" }));
    const pub2 = createCoordinationPublisher({ mode: "shadow", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub2.drain();
    const recs = mirrorRecords(mirrorPath);
    expect(recs.map((r) => r.id)).toEqual(["evt-a", "evt-b"]); // evt-a not doubled
    expect(recs.map((r) => r.local_seq)).toEqual([1, 2]); // continues the high-water, no renumber
  });

  test("mode 'off' resolves run() immediately and never writes the mirror", async () => {
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination"));
    const pub = createCoordinationPublisher({ mode: "off", filePath, mirrorPath, checkpointPath, signal: ac.signal });
    await pub.run(); // must resolve without hanging on the tail loop
    await pub.drain();
    expect(existsSync(mirrorPath)).toBe(false);
  });

  test("enforce buffers coordination records for the hub (still writes the mirror first)", async () => {
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination", { id: "a" }));
    const published: unknown[][] = [];
    const pub = createCoordinationPublisher({
      mode: "enforce",
      filePath,
      mirrorPath,
      checkpointPath,
      signal: ac.signal,
      hubClient: { publish: async (batch) => { published.push(batch); } },
    });
    await pub.drain();
    // Mirror written synchronously regardless of the hub.
    expect(mirrorRecords(mirrorPath).length).toBe(1);
    expect(pub.outboundDepth()).toBe(1);
    await pub.flushToHub();
    expect(published.length).toBe(1);
    expect((published[0] as Array<Record<string, unknown>>)[0].local_seq).toBe(1);
    expect(pub.outboundDepth()).toBe(0);
  });

  test("flushToHub retains the batch when publish() throws — no egress loss (CTL-1488 remediate)", async () => {
    writeFileSync(filePath, evLine("phase.plan.complete.CTL-1", "coordination", { id: "a" }));
    appendFileSync(filePath, evLine("phase.verify.complete.CTL-2", "coordination", { id: "b" }));
    let attempts = 0;
    const pub = createCoordinationPublisher({
      mode: "enforce", filePath, mirrorPath, checkpointPath, signal: ac.signal,
      // First publish throws (simulate the DLQ ENOSPC/corrupt-line edge where publish() is NOT
      // throw-proof); the second succeeds.
      hubClient: { publish: async () => { attempts++; if (attempts === 1) throw new Error("dlq ENOSPC"); } },
    });
    await pub.drain();
    expect(pub.outboundDepth()).toBe(2);

    // The throwing flush must NOT drop the batch from egress.
    await expect(pub.flushToHub()).rejects.toThrow("dlq ENOSPC");
    expect(pub.outboundDepth()).toBe(2); // batch retained, not spliced away

    // A subsequent flush delivers the retained rows exactly once.
    await pub.flushToHub();
    expect(pub.outboundDepth()).toBe(0);
    expect(attempts).toBe(2);
    // Mirror still holds both rows the whole time (local-first — never lost).
    expect(mirrorRecords(mirrorPath).length).toBe(2);
  });
});

describe("seedLocalSeqFromMirror", () => {
  let dir: string, mirrorPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctl1488-seed-")); mirrorPath = join(dir, "coordination.jsonl"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("absent mirror → 0", () => {
    expect(seedLocalSeqFromMirror(mirrorPath)).toBe(0);
  });
  test("reads the last line's local_seq", () => {
    writeFileSync(mirrorPath, JSON.stringify({ local_seq: 1 }) + "\n" + JSON.stringify({ local_seq: 7 }) + "\n");
    expect(seedLocalSeqFromMirror(mirrorPath)).toBe(7);
  });
  test("malformed last line → 0 (never throws)", () => {
    writeFileSync(mirrorPath, "{ not json\n");
    expect(seedLocalSeqFromMirror(mirrorPath)).toBe(0);
  });
});
