// event-mirror/index.test.ts — CTL-1654 Phase 4.
// Unit tests for the fan-in/dedup core of the event-mirror daemon.
// Tests inject a fake fetchFn so no real ssh runs.
// Run: cd plugins/dev/scripts/event-mirror && bun test

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorTick, type FetchFn } from "./index.ts";
import { newMirrorState, filterNewLines, extractEventId } from "./lib/state.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeEvent(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, ts: "2026-08-05T00:00:00Z", attributes: { "event.name": "test.evt" }, ...extra });
}

function makeFetch(byHost: Record<string, string[]>): FetchFn {
  return async (host, _cursor, _file) => {
    const lines = byHost[host] ?? [];
    const bytesRead = lines.reduce((acc, l) => acc + Buffer.byteLength(l + "\n", "utf8"), 0);
    return { lines, bytesRead };
  };
}

function makeCursorFetch(byHostOpts: Record<string, { lines: string[]; nextBytes: number }>): FetchFn {
  return async (host, _cursor, _file) => {
    const opts = byHostOpts[host] ?? { lines: [], nextBytes: 0 };
    return { lines: opts.lines, bytesRead: opts.nextBytes };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractEventId", () => {
  test("reads .id field", () => {
    expect(extractEventId(JSON.stringify({ id: "abc" }))).toBe("abc");
  });
  test("reads .event_id field", () => {
    expect(extractEventId(JSON.stringify({ event_id: "xyz" }))).toBe("xyz");
  });
  test("reads attributes[event.id]", () => {
    expect(extractEventId(JSON.stringify({ attributes: { "event.id": "eid" } }))).toBe("eid");
  });
  test("falls back to ts:name composite", () => {
    const line = JSON.stringify({ ts: "2026-08", attributes: { "event.name": "foo" } });
    expect(extractEventId(line)).toBe("2026-08:foo");
  });
  test("returns null for unparseable line", () => {
    expect(extractEventId("not json")).toBeNull();
  });
});

describe("filterNewLines — dedup by event id", () => {
  test("appends each event id at most once", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    const result = filterNewLines(state, [lineA, lineA], "2026-08.jsonl");
    expect(result).toHaveLength(1);
  });

  test("two calls with the same id — second call returns nothing", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    filterNewLines(state, [lineA], "2026-08.jsonl");
    const second = filterNewLines(state, [lineA], "2026-08.jsonl");
    expect(second).toHaveLength(0);
  });

  test("resets dedup ring on file change (month rollover)", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    filterNewLines(state, [lineA], "2026-07.jsonl");
    // Same id, new file → should pass through (ring reset).
    const result = filterNewLines(state, [lineA], "2026-08.jsonl");
    expect(result).toHaveLength(1);
  });

  test("lines without an id are always included", () => {
    const state = newMirrorState();
    // A line with no parseable id field.
    const noid = JSON.stringify({ ts: "x" });
    const r1 = filterNewLines(state, [noid], "2026-08.jsonl");
    const r2 = filterNewLines(state, [noid], "2026-08.jsonl");
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });
});

describe("mirrorTick — fan-in from multiple hosts", () => {
  function makeLocalFile(): string {
    return join(mkdtempSync(join(tmpdir(), "em-local-")), "2026-08.jsonl");
  }

  test("mirrors events from all fleet hosts", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const EV_B = fakeEvent("B");
    const result = await mirrorTick({
      hosts: ["mini", "mini-2"],
      state,
      fetchFn: makeFetch({ mini: [EV_A], "mini-2": [EV_B] }),
      localFile,
    });
    expect(result.byHost["mini"].healthy).toBe(true);
    expect(result.byHost["mini-2"].healthy).toBe(true);
    const written = readFileSync(localFile, "utf8");
    expect(written).toContain('"A"');
    expect(written).toContain('"B"');
  });

  test("appends each event id at most once across two ticks", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    // Tick 1: append A.
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeFetch({ mini: [EV_A] }),
      localFile,
    });
    // Tick 2: same line returned by remote (e.g. re-tail). Should NOT append again.
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeFetch({ mini: [EV_A] }),
      localFile,
    });
    const lines = readFileSync(localFile, "utf8").split("\n").filter(Boolean);
    const aLines = lines.filter(l => l.includes('"A"'));
    expect(aLines).toHaveLength(1);
  });

  test("advances per-host cursor", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const bytes = Buffer.byteLength(EV_A + "\n", "utf8");
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeCursorFetch({ mini: { lines: [EV_A], nextBytes: bytes } }),
      localFile,
    });
    expect(state.byHost["mini"].cursor).toBe(bytes);
  });

  test("unreachable host degrades, does not crash mirror", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const fetchFn: FetchFn = async (host, _cursor, _file) => {
      if (host === "dead") throw new Error("ssh: connect timeout");
      return { lines: [EV_A], bytesRead: Buffer.byteLength(EV_A + "\n", "utf8") };
    };
    const result = await mirrorTick({
      hosts: ["mini", "dead"],
      state,
      fetchFn,
      localFile,
    });
    expect(result.byHost["dead"].healthy).toBe(false);
    expect(result.byHost["mini"].healthy).toBe(true);
    // Events from mini still arrived.
    const written = readFileSync(localFile, "utf8");
    expect(written).toContain('"A"');
  });

  test("empty hosts list: no errors, no writes", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const result = await mirrorTick({
      hosts: [],
      state,
      fetchFn: makeFetch({}),
      localFile,
    });
    expect(result.appended).toBe(0);
    expect(existsSync(localFile)).toBe(false);
  });
});
