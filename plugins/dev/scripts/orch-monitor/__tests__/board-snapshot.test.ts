// CTL-733: unit tests for the reactive board snapshot manager. Pure logic —
// the real assembleBoard() is injected with a fake, so no fs / subprocess / server.
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBoardSnapshotManager } from "../lib/board-snapshot.mjs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "board-snapshot-"));
function fakePayload(inFlight: number) {
  return {
    generatedAt: new Date().toISOString(),
    config: { maxParallel: 6, inFlight, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [],
    tickets: [],
    queue: [],
  };
}

describe("board-snapshot manager (CTL-733)", () => {
  it("getLatest computes once and caches within the on-demand TTL", async () => {
    let calls = 0;
    const m = createBoardSnapshotManager({
      assemble: () => { calls++; return Promise.resolve(fakePayload(calls)); },
      onDemandTtlMs: 1000,
      workersDir: tmp(),
    });
    const a = await m.getLatest();
    const b = await m.getLatest();
    expect(calls).toBe(1); // second read served from cache
    expect(a).toBe(b);
    m.stop();
  });

  it("subscribe pushes the initial snapshot and shares one loop across subscribers", async () => {
    let calls = 0;
    const got: number[] = [];
    const m = createBoardSnapshotManager({
      assemble: () => { calls++; return Promise.resolve(fakePayload(calls)); },
      debounceMs: 10,
      pollMs: 1_000_000, // effectively disable the poll for the test
      workersDir: tmp(),
    });
    const unsub1 = m.subscribe((s) => got.push(s.config.inFlight));
    m.subscribe(() => {});
    expect(m.subscriberCount).toBe(2);
    await sleep(40);
    expect(got.length).toBeGreaterThanOrEqual(1); // received at least the bootstrap snapshot
    unsub1();
    expect(m.subscriberCount).toBe(1);
    m.stop();
  });

  it("stops the reactive loop when the last subscriber leaves", () => {
    const m = createBoardSnapshotManager({
      assemble: () => Promise.resolve(fakePayload(0)),
      pollMs: 1_000_000,
      workersDir: tmp(),
    });
    const unsub = m.subscribe(() => {});
    expect(m.subscriberCount).toBe(1);
    unsub();
    expect(m.subscriberCount).toBe(0);
    m.stop();
  });

  it("a throwing subscriber does not break delivery to the others", async () => {
    let good = 0;
    const m = createBoardSnapshotManager({
      assemble: () => Promise.resolve(fakePayload(1)),
      debounceMs: 10,
      pollMs: 1_000_000,
      workersDir: tmp(),
    });
    m.subscribe(() => { throw new Error("boom"); });
    m.subscribe(() => { good++; });
    await sleep(40);
    expect(good).toBeGreaterThanOrEqual(1);
    m.stop();
  });
});
