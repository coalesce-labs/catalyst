import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMirrorTailClient,
  createHubChangeSource,
  readMirrorEventIds,
  type ChangeSource,
  type CoordinationDelta,
  type PullResult,
} from "./mirror-tail-client.ts";

function delta(seq: number, eventId: string, host = "laptop"): CoordinationDelta {
  return {
    seq,
    host,
    event_id: eventId,
    event_name: `phase.plan.complete.${eventId}`,
    ts: "2026-07-21T00:00:00Z",
    caused_by: null,
    attributes: { "event.name": `phase.plan.complete.${eventId}`, "event.stream_class": "coordination" },
    resource: { "service.name": "catalyst.execution-core" },
  };
}

function mirrorRows(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// A scripted ChangeSource that records the `since` values it was called with and
// returns queued results in order.
function scriptedSource(results: PullResult[]): ChangeSource & { calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    async pullChanges(since: number): Promise<PullResult> {
      calls.push(since);
      return results[Math.min(i++, results.length - 1)];
    },
  };
}

describe("createMirrorTailClient (CTL-1488 Phase 5)", () => {
  let dir: string, mirrorPath: string, ac: AbortController;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1488-mtc-"));
    mirrorPath = join(dir, "coordination.jsonl");
    ac = new AbortController();
  });
  afterEach(() => { ac.abort(); rmSync(dir, { recursive: true, force: true }); });

  test("first tick with no saved lastHubSeq triggers a since=0 full drain", async () => {
    const src = scriptedSource([{ ok: true, deltas: [delta(1, "evt-a")], headSeq: 1 }]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick();
    expect(src.calls[0]).toBe(0); // full drain
    expect(client.currentHubSeq()).toBe(1);
    expect(mirrorRows(mirrorPath).length).toBe(1);
  });

  test("steady-state uses the advanced cursor on the next tick", async () => {
    const src = scriptedSource([
      { ok: true, deltas: [delta(1, "evt-a")], headSeq: 1 },
      { ok: true, deltas: [delta(2, "evt-b")], headSeq: 2 },
    ]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick();
    await client.tick();
    expect(src.calls).toEqual([0, 1]); // second tick pulls since=lastHubSeq=1
    expect(client.currentHubSeq()).toBe(2);
    expect(mirrorRows(mirrorPath).length).toBe(2);
  });

  test("an HTTP-409 cursor_underflow triggers a full resync (re-pull from since=0)", async () => {
    const src = scriptedSource([
      { ok: false, underflow: true },
      { ok: true, deltas: [delta(5, "evt-x")], headSeq: 5 },
    ]);
    // Seed a non-zero cursor so the first pull uses it and the underflow forces back to 0.
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal, startHubSeq: 3 });
    await client.tick();
    expect(src.calls).toEqual([3, 0]); // pulled at 3 → underflow → resync at 0
    expect(client.currentHubSeq()).toBe(5);
    expect(mirrorRows(mirrorPath).map((r) => r.id)).toEqual(["evt-x"]);
  });

  test("a transient fetch error is a no-op tick (logged, retried next tick, never crashes)", async () => {
    const src = scriptedSource([{ ok: false, error: true }, { ok: true, deltas: [delta(1, "evt-a")], headSeq: 1 }]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick(); // error — must not throw
    expect(mirrorRows(mirrorPath).length).toBe(0);
    expect(client.currentHubSeq()).toBeNull(); // cursor not advanced on error
    await client.tick(); // recovers
    expect(mirrorRows(mirrorPath).length).toBe(1);
  });

  test("emits an inbound coordination_mirror_tail_degraded event once at the consecutive-failure threshold (CTL-1488 remediate)", async () => {
    const eventLogPath = join(dir, "events.jsonl");
    // 6 consecutive failing pulls; threshold 3.
    const src = scriptedSource(Array.from({ length: 6 }, () => ({ ok: false, error: true }) as PullResult));
    const client = createMirrorTailClient({
      mirrorPath, source: src, signal: ac.signal,
      logError: () => {}, eventLogPath, degradedThreshold: 3,
    });
    for (let i = 0; i < 6; i++) await client.tick();
    const events = existsSync(eventLogPath)
      ? readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    // Emitted exactly ONCE (at the crossing), not per-tick spam.
    expect(events.length).toBe(1);
    expect(events[0].attributes["event.name"]).toBe("catalyst.observability.coordination_mirror_tail_degraded");
    expect(events[0].severityText).toBe("ERROR");
    expect(events[0].body.payload.consecutiveFailures).toBe(3);
  });

  test("a successful pull resets the failure counter so the degraded event does not fire on intermittent errors", async () => {
    const eventLogPath = join(dir, "events.jsonl");
    // error, error, SUCCESS, error, error — never 3 consecutive.
    const src = scriptedSource([
      { ok: false, error: true },
      { ok: false, error: true },
      { ok: true, deltas: [delta(1, "evt-a")], headSeq: 1 },
      { ok: false, error: true },
      { ok: false, error: true },
    ]);
    const client = createMirrorTailClient({
      mirrorPath, source: src, signal: ac.signal,
      logError: () => {}, eventLogPath, degradedThreshold: 3,
    });
    for (let i = 0; i < 5; i++) await client.tick();
    expect(existsSync(eventLogPath)).toBe(false); // never crossed 3 consecutive
  });

  test("merges OTHER hosts' rows and dedups the host's OWN rows by event.id (never double-appends)", async () => {
    // Seed the mirror with a local row the host wrote itself (id evt-a, local_seq 1).
    writeFileSync(mirrorPath, JSON.stringify({ id: "evt-a", local_seq: 1, attributes: { "event.name": "x" } }) + "\n");
    // The hub echoes evt-a back (the host's own event) AND a genuinely remote evt-b.
    const src = scriptedSource([{ ok: true, deltas: [delta(1, "evt-a", "mini"), delta(2, "evt-b", "laptop")], headSeq: 2 }]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick();
    const ids = mirrorRows(mirrorPath).map((r) => r.id);
    expect(ids).toEqual(["evt-a", "evt-b"]); // evt-a NOT double-appended; evt-b merged in
    // The inbound row carries hub_seq (not local_seq — it wasn't locally tailed).
    const evtB = mirrorRows(mirrorPath).find((r) => r.id === "evt-b")!;
    expect(evtB.hub_seq).toBe(2);
    expect(evtB.local_seq).toBeUndefined();
  });

  test("incremental dedup: a local row appended OUT-OF-BAND after startup is not double-appended when echoed (review #4)", async () => {
    // The seen-id set is kept in memory and refreshed incrementally each tick. This guards the
    // correctness edge a naive read-once-at-startup set would break: the local publisher appends its
    // OWN rows to the same mirror after the client started, and the source later echoes them back.
    const src = scriptedSource([
      { ok: true, deltas: [delta(1, "evt-a", "laptop")], headSeq: 1 }, // tick 1: one remote row
      // tick 2: the source echoes back evt-c (a row the LOCAL publisher wrote out-of-band between
      // ticks) plus a genuinely new remote evt-d. evt-c must dedup against the out-of-band append.
      { ok: true, deltas: [delta(3, "evt-c", "mini"), delta(4, "evt-d", "laptop")], headSeq: 4 },
    ]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick();
    expect(mirrorRows(mirrorPath).map((r) => r.id)).toEqual(["evt-a"]);

    // Local publisher writes its own row to the SAME mirror, out-of-band from this client.
    appendFileSync(mirrorPath, JSON.stringify({ id: "evt-c", local_seq: 2, attributes: { "event.name": "x" } }) + "\n");

    await client.tick();
    const ids = mirrorRows(mirrorPath).map((r) => r.id);
    expect(ids).toEqual(["evt-a", "evt-c", "evt-d"]); // evt-c appears once (the local append), not doubled
    expect(ids.filter((id) => id === "evt-c").length).toBe(1);
  });

  test("a mirror truncation/rotation (size < mirrorOffset) resets seenIds and rescans from 0 (coverage of the shrink branch)", async () => {
    // Accumulate mirrorOffset by ingesting two own-rows, then rotate the mirror out from under the
    // client (writeFileSync '' → size 0 < mirrorOffset). The next tick must hit the shrink branch:
    // reset seenIds + rescan from 0. Proof the reset actually fired: re-sending evt-a AFTER the
    // rotation re-appends it (a stale, non-reset seenIds would dedup it away, leaving only evt-c).
    const src = scriptedSource([
      { ok: true, deltas: [delta(1, "evt-a"), delta(2, "evt-b")], headSeq: 2 },
      { ok: true, deltas: [delta(1, "evt-a"), delta(3, "evt-c")], headSeq: 3 },
    ]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal });
    await client.tick();
    expect(mirrorRows(mirrorPath).map((r) => r.id)).toEqual(["evt-a", "evt-b"]);

    writeFileSync(mirrorPath, ""); // rotation/truncation — mirror shrinks below the ingested offset

    await client.tick();
    const ids = mirrorRows(mirrorPath).map((r) => r.id);
    expect(ids).toEqual(["evt-a", "evt-c"]); // evt-a re-appended (seenIds rescanned from the now-empty mirror)
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids survive the rescan
    expect(client.currentHubSeq()).toBe(3); // cursor still tracked across the rotation
  });

  test("a local mirror-write fault in mergeDeltas routes through recordFailure, not a silent throw (review #5)", async () => {
    // Point the mirror under a regular FILE so mkdirSync(dirname)/appendFileSync inside mergeDeltas
    // throws (ENOTDIR) — the ENOSPC/EACCES local-I/O edge. The throw must be caught and surfaced as
    // the same coordination_mirror_tail_degraded signal as a pull outage, never an unhandled rejection.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const wedgedMirror = join(blocker, "coordination.jsonl"); // parent is a file → writes fault
    const eventLogPath = join(dir, "events.jsonl");
    const src = scriptedSource([
      { ok: true, deltas: [delta(1, "evt-a")], headSeq: 1 },
      { ok: true, deltas: [delta(2, "evt-b")], headSeq: 2 },
    ]);
    const client = createMirrorTailClient({
      mirrorPath: wedgedMirror, source: src, signal: ac.signal,
      logError: () => {}, eventLogPath, degradedThreshold: 2,
    });
    await client.tick(); // merge throws → recordFailure #1, must NOT throw out of tick
    expect(client.currentHubSeq()).toBeNull(); // cursor NOT advanced on a merge fault
    await client.tick(); // recordFailure #2 → crosses threshold → degraded event
    const events = existsSync(eventLogPath)
      ? readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    expect(events.length).toBe(1);
    expect(events[0].attributes["event.name"]).toBe("catalyst.observability.coordination_mirror_tail_degraded");
  });

  test("a resync pull that THROWS is a no-op tick (recordFailure, cursor stays null) — coverage of the resync-throws branch", async () => {
    let call = 0;
    const throwingResync: ChangeSource = {
      async pullChanges(since: number) {
        call++;
        if (call === 1) return { ok: false, underflow: true } as PullResult; // force resync
        throw new Error("resync boom");
      },
    };
    const client = createMirrorTailClient({ mirrorPath, source: throwingResync, signal: ac.signal, logError: () => {}, startHubSeq: 3 });
    await client.tick(); // underflow → resync pull throws — must not crash
    expect(client.currentHubSeq()).toBeNull(); // reset to null on underflow, never re-advanced
    expect(mirrorRows(mirrorPath).length).toBe(0);
  });

  test("a resync pull that returns a transient error is a no-op tick — coverage of the resync-error branch", async () => {
    const src = scriptedSource([
      { ok: false, underflow: true }, // force resync
      { ok: false, error: true }, // resync itself fails transiently
    ]);
    const client = createMirrorTailClient({ mirrorPath, source: src, signal: ac.signal, logError: () => {}, startHubSeq: 3 });
    await client.tick();
    expect(client.currentHubSeq()).toBeNull();
    expect(mirrorRows(mirrorPath).length).toBe(0);
  });
});

describe("createHubChangeSource", () => {
  test("pullChanges GETs <hubUrl>/coordination/changes?since= and parses NDJSON deltas", async () => {
    let calledUrl = "";
    const fetchImpl = async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(delta(7, "evt-7")) + "\n", { status: 200 });
    };
    const src = createHubChangeSource({ hubUrl: "https://hub.example", fetchImpl });
    const res = await src.pullChanges(4);
    expect(calledUrl).toBe("https://hub.example/coordination/changes?since=4");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.deltas.map((d) => d.event_id)).toEqual(["evt-7"]);
      expect(res.headSeq).toBe(7);
    }
  });

  test("a 409 response maps to underflow", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "cursor_underflow", resync: true }), { status: 409 });
    const src = createHubChangeSource({ hubUrl: "https://hub.example", fetchImpl });
    const res = await src.pullChanges(999);
    expect(res).toEqual({ ok: false, underflow: true });
  });

  test("a network/non-2xx error maps to error (never throws)", async () => {
    const fetchImpl = async () => new Response("boom", { status: 502 });
    const src = createHubChangeSource({ hubUrl: "https://hub.example", fetchImpl });
    expect(await src.pullChanges(0)).toEqual({ ok: false, error: true });
    const throwing = createHubChangeSource({
      hubUrl: "https://hub.example",
      fetchImpl: async () => { throw new Error("dns"); },
    });
    expect(await throwing.pullChanges(0)).toEqual({ ok: false, error: true });
  });
});

describe("readMirrorEventIds", () => {
  test("collects the id field from every mirror line; absent file → empty set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1488-ids-"));
    const p = join(dir, "coordination.jsonl");
    expect(readMirrorEventIds(p).size).toBe(0);
    writeFileSync(p, JSON.stringify({ id: "a" }) + "\n" + JSON.stringify({ id: "b" }) + "\n" + "not json\n");
    const ids = readMirrorEventIds(p);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.size).toBe(2); // malformed line skipped
    rmSync(dir, { recursive: true, force: true });
  });
});
