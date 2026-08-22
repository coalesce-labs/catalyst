import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readBacklog,
  tailEventLog,
  readTunnelEventStats,
  scanFileLines,
  readTailUtf8,
  fullReadMetrics,
  recordFullRead,
} from "../lib/event-log-reader";
import { createEventRing } from "../lib/event-ring";

// bytesRequested — total `length` argument across readSync calls. The spy's
// call tuple resolves to the 3-arg `readSync(fd, buffer, opts)` overload under
// TS, so index positionally through `unknown[]` rather than fighting the
// overload set (CTL-1529).
function bytesRequested(calls: readonly unknown[][]): number {
  return calls.reduce<number>(
    (sum, c) => sum + (typeof c[3] === "number" ? c[3] : 0),
    0,
  );
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "event-log-reader-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function eventsDir(): string {
  const d = join(workdir, "events");
  mkdirSync(d, { recursive: true });
  return d;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function makeLine(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: "2026-05-04T00:00:00Z", event, ...extra });
}

// CTL-1216: this whole file's fixtures are month-shaped — 27 hard-coded
// `2026-05.jsonl`-style literals across five describes, with `now` mocked into
// May. It is pinned to `month` rather than rewritten, because what it tests is
// backlog/tail/stat behaviour, not the rotation scheme, and rewriting 27
// literals would add risk without adding coverage.
//
// The scheme-crossing behaviour IS covered, elsewhere and deliberately: the
// leaf's own suite (lib/event-log-paths.test.mjs) pins mixed-scheme window
// resolution, and execution-core/recovery-pass-context.test.mjs asserts a
// historical YYYY-MM.jsonl is read beside a YYYY-Www.jsonl (AC 3). Pinning here
// would only be a problem if it were the ONLY place the property lived.
beforeEach(() => {
  process.env.CATALYST_EVENT_LOG_ROTATION = "month";
});
afterEach(() => {
  delete process.env.CATALYST_EVENT_LOG_ROTATION;
});

describe("readBacklog", () => {
  it("returns empty array when file does not exist", async () => {
    const r = await readBacklog({
      catalystDir: workdir,
      predicate: "",
      limit: 100,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    expect(r).toEqual([]);
  });

  it("returns last N lines from current month file (no filter)", async () => {
    const dir = eventsDir();
    const lines = Array.from({ length: 5 }, (_, i) => makeLine(`evt-${i}`));
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const r = await readBacklog({
      catalystDir: workdir,
      predicate: "",
      limit: 3,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    expect(r.length).toBe(3);
    expect(JSON.parse(r[0]).event).toBe("evt-2");
    expect(JSON.parse(r[2]).event).toBe("evt-4");
  });

  it("applies predicate filter", async () => {
    const dir = eventsDir();
    const lines = [
      makeLine("github.pr.merged"),
      makeLine("linear.issue.created"),
      makeLine("github.pr.opened"),
      makeLine("session-started"),
    ];
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const r = await readBacklog({
      catalystDir: workdir,
      predicate: '.event | startswith("github.")',
      limit: 100,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    expect(r.length).toBe(2);
    expect(r.every((l) => (JSON.parse(l) as { event: string }).event.startsWith("github."))).toBe(true);
  });

  it("respects limit when many matches exist", async () => {
    const dir = eventsDir();
    const lines = Array.from({ length: 50 }, (_, i) =>
      makeLine("github.pr.merged", { i }),
    );
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const r = await readBacklog({
      catalystDir: workdir,
      predicate: '.event == "github.pr.merged"',
      limit: 10,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    expect(r.length).toBe(10);
    // Should be the last 10 (most recent)
    expect(JSON.parse(r[0]).i).toBe(40);
    expect(JSON.parse(r[9]).i).toBe(49);
  });
});

// CTL-1224: readBacklog ring fast-path + bounded file fallback. The SSE path
// passes the shared ring so N reconnecting clients no longer each readFileSync
// the whole current-month log. Behavioral parity is asserted by mutating the
// on-disk file AFTER the ring has cold-filled — if the result still matches the
// ring's pre-mutation contents, the disk was provably not read.
describe("readBacklog (ring fast-path)", () => {
  it("T5 — served from the ring does NO full file read (disk mutated post-coldfill)", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    // Seed N (> limit) matching lines so the ring covers the window.
    const lines = Array.from({ length: 20 }, (_, i) =>
      makeLine("github.pr.merged", { i }),
    );
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start(); // cold-fills the 20 lines into the in-memory ring
    try {
      expect(ring.size()).toBe(20);

      // Overwrite the on-disk file with a single UNRELATED line. If readBacklog
      // read the file, it would return [] (no github.* match) instead of the
      // ring's 10 newest github.pr.merged lines.
      writeFileSync(join(dir, "2026-05.jsonl"), makeLine("unrelated.event") + "\n");

      const r = await readBacklog({
        catalystDir: workdir,
        predicate: '.event == "github.pr.merged"',
        limit: 10,
        ring,
        now: () => now,
      });
      // Last 10 ring matches, newest-last — the file was NOT consulted.
      expect(r.length).toBe(10);
      expect(JSON.parse(r[0]).i).toBe(10);
      expect(JSON.parse(r[9]).i).toBe(19);
      expect(r.every((l) => (JSON.parse(l) as { event: string }).event === "github.pr.merged")).toBe(true);
    } finally {
      ring.stop();
    }
  });

  it("T6a — no ring falls back to the file read", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    const lines = Array.from({ length: 15 }, (_, i) =>
      makeLine("github.pr.merged", { i }),
    );
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const r = await readBacklog({
      catalystDir: workdir,
      predicate: '.event == "github.pr.merged"',
      limit: 10,
      ring: null,
      now: () => now,
    });
    expect(r.length).toBe(10);
    expect(JSON.parse(r[0]).i).toBe(5);
    expect(JSON.parse(r[9]).i).toBe(14);
  });

  it("T6b — ring smaller than limit underflows → file read (file's last N matches)", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    // File has MORE matching lines than the tiny ring will retain.
    const lines = Array.from({ length: 30 }, (_, i) =>
      makeLine("github.pr.merged", { i }),
    );
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    // capLines below the limit → ring.size() < limit → underflow → fallback.
    const ring = createEventRing({ catalystDir: workdir, capLines: 5, now: () => now });
    ring.start();
    try {
      expect(ring.size()).toBe(5); // ring holds fewer than the limit (10)

      const r = await readBacklog({
        catalystDir: workdir,
        predicate: '.event == "github.pr.merged"',
        limit: 10,
        ring,
        now: () => now,
      });
      // Must return the FILE's last 10 matches (25..29-region), proving it did
      // NOT silently return the short 5-line ring slice.
      expect(r.length).toBe(10);
      expect(JSON.parse(r[0]).i).toBe(20);
      expect(JSON.parse(r[9]).i).toBe(29);
    } finally {
      ring.stop();
    }
  });
});

describe("tailEventLog", () => {
  it("emits new lines appended to the current file", async () => {
    const dir = eventsDir();
    const file = join(dir, "2026-05.jsonl");
    writeFileSync(file, ""); // create empty file

    const ctrl = new AbortController();
    const got: string[] = [];
    const p = tailEventLog({
      catalystDir: workdir,
      predicate: "",
      signal: ctrl.signal,
      onEvent: (l) => got.push(l),
      pollMs: 20,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });

    await sleep(60);
    appendFileSync(file, makeLine("first") + "\n");
    await sleep(150);
    appendFileSync(file, makeLine("second") + "\n");
    await sleep(150);

    ctrl.abort();
    await p;

    const events = got.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(["first", "second"]);
  });

  it("applies predicate filter to live tail", async () => {
    const dir = eventsDir();
    const file = join(dir, "2026-05.jsonl");
    writeFileSync(file, "");

    const ctrl = new AbortController();
    const got: string[] = [];
    const p = tailEventLog({
      catalystDir: workdir,
      predicate: '.event == "match"',
      signal: ctrl.signal,
      onEvent: (l) => got.push(l),
      pollMs: 20,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });

    await sleep(60);
    appendFileSync(file, makeLine("match") + "\n");
    appendFileSync(file, makeLine("skip") + "\n");
    appendFileSync(file, makeLine("match") + "\n");
    await sleep(250);

    ctrl.abort();
    await p;

    expect(got.length).toBe(2);
    expect(got.every((l) => JSON.parse(l).event === "match")).toBe(true);
  });

  it("handles month rotation", async () => {
    const dir = eventsDir();
    const mayFile = join(dir, "2026-05.jsonl");
    const juneFile = join(dir, "2026-06.jsonl");
    writeFileSync(mayFile, "");

    let nowVal = new Date("2026-05-31T23:59:50Z");
    const ctrl = new AbortController();
    const got: string[] = [];
    const p = tailEventLog({
      catalystDir: workdir,
      predicate: "",
      signal: ctrl.signal,
      onEvent: (l) => got.push(l),
      pollMs: 20,
      now: () => nowVal,
    });

    await sleep(60);
    appendFileSync(mayFile, makeLine("may-event") + "\n");
    await sleep(150);

    // Rotate
    nowVal = new Date("2026-06-01T00:00:01Z");
    writeFileSync(juneFile, "");
    await sleep(60);
    appendFileSync(juneFile, makeLine("june-event") + "\n");
    await sleep(200);

    ctrl.abort();
    await p;

    const events = got.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("may-event");
    expect(events).toContain("june-event");
  });

  it("aborts cleanly via AbortSignal", async () => {
    const ctrl = new AbortController();
    const p = tailEventLog({
      catalystDir: workdir,
      predicate: "",
      signal: ctrl.signal,
      onEvent: () => {},
      pollMs: 20,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    ctrl.abort();
    await p; // should resolve without throwing
  });

  it("aborts immediately if signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await tailEventLog({
      catalystDir: workdir,
      predicate: "",
      signal: ctrl.signal,
      onEvent: () => {},
      pollMs: 20,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    // resolves immediately
  });
});

// CTL-300: readTunnelEventStats reads canonical envelopes — event name lives
// at .attributes."event.name" and repo lives at .attributes."vcs.repository.name".
function makeGithubLine(
  repo: string,
  ts: string,
  event = "github.pr.merged",
): string {
  return JSON.stringify({
    ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": "catalyst.github",
      "service.namespace": "catalyst",
      "service.version": "8.2.0",
    },
    attributes: { "event.name": event, "vcs.repository.name": repo },
    body: { payload: {} },
  });
}

describe("readTunnelEventStats", () => {
  it("returns null lastEventAt and zero counts when file is absent", () => {
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.lastEventAt).toBeNull();
    expect(r.eventCount24h).toBe(0);
    expect(r.eventCount24hByRepo).toEqual({});
  });

  it("returns null lastEventAt and zero counts for empty file", () => {
    eventsDir();
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), "");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.lastEventAt).toBeNull();
    expect(r.eventCount24h).toBe(0);
  });

  it("counts only github.* events and ignores others", () => {
    eventsDir();
    const lines = [
      makeGithubLine("org/a", "2026-05-04T11:00:00Z"),
      JSON.stringify({
        ts: "2026-05-04T11:01:00Z",
        attributes: { "event.name": "linear.issue.created" },
        body: {},
      }),
      JSON.stringify({
        ts: "2026-05-04T11:02:00Z",
        attributes: { "event.name": "session.started" },
        body: {},
      }),
      makeGithubLine("org/b", "2026-05-04T11:03:00Z"),
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(2);
    expect(r.lastEventAt).toBe("2026-05-04T11:03:00Z");
    expect(r.eventCount24hByRepo).toEqual({ "org/a": 1, "org/b": 1 });
  });

  it("excludes events older than 24h from counts but lastEventAt is the most recent github event overall", () => {
    eventsDir();
    const lines = [
      makeGithubLine("org/a", "2026-05-03T10:00:00Z"),  // >24h ago
      makeGithubLine("org/b", "2026-05-04T11:00:00Z"),  // within 24h
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(1);
    expect(r.eventCount24hByRepo).toEqual({ "org/b": 1 });
    expect(r.lastEventAt).toBe("2026-05-04T11:00:00Z");
  });

  it("crosses month boundary: reads previous month file for 24h window", () => {
    eventsDir();
    // now = May 1 00:30 UTC → 24h window starts April 30 00:30 UTC
    const aprilLine = makeGithubLine("org/x", "2026-04-30T01:00:00Z");
    const mayLine   = makeGithubLine("org/y", "2026-05-01T00:15:00Z");
    writeFileSync(join(workdir, "events", "2026-04.jsonl"), aprilLine + "\n");
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), mayLine + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-01T00:30:00Z"));
    expect(r.eventCount24h).toBe(2);
    expect(r.eventCount24hByRepo).toEqual({ "org/x": 1, "org/y": 1 });
  });

  it("accumulates per-repo counts across multiple events in same repo", () => {
    eventsDir();
    const lines = [
      makeGithubLine("org/a", "2026-05-04T10:00:00Z"),
      makeGithubLine("org/a", "2026-05-04T10:30:00Z"),
      makeGithubLine("org/b", "2026-05-04T11:00:00Z"),
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(3);
    expect(r.eventCount24hByRepo).toEqual({ "org/a": 2, "org/b": 1 });
  });

  it("skips malformed lines without throwing", () => {
    eventsDir();
    const lines = [
      "not json",
      makeGithubLine("org/a", "2026-05-04T11:00:00Z"),
      "{broken",
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(1);
  });

  it("ignores github.* events with no ts field", () => {
    eventsDir();
    const noTs = JSON.stringify({
      attributes: { "event.name": "github.pr.merged", "vcs.repository.name": "org/a" },
      body: {},
    });
    const withTs = makeGithubLine("org/b", "2026-05-04T11:00:00Z");
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), [noTs, withTs].join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(1);
    expect(r.lastEventAt).toBe("2026-05-04T11:00:00Z");
    expect(r.eventCount24hByRepo).toEqual({ "org/b": 1 });
  });

  it("counts github.* events with no vcs.repository.name in eventCount24h but not in eventCount24hByRepo", () => {
    eventsDir();
    const noRepo = JSON.stringify({
      ts: "2026-05-04T11:00:00Z",
      attributes: { "event.name": "github.push" },
      body: {},
    });
    const withRepo = makeGithubLine("org/a", "2026-05-04T11:30:00Z");
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), [noRepo, withRepo].join("\n") + "\n");
    const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(r.eventCount24h).toBe(2);
    expect(r.eventCount24hByRepo).toEqual({ "org/a": 1 });
  });
});

// CTL-1215 B2: ring fast-path + bounded file fallback.
describe("readTunnelEventStats (ring fast-path)", () => {
  it("ring that fully covers the 24h window returns counts identical to the file path", () => {
    eventsDir();
    const now = new Date("2026-05-04T12:00:00Z");
    const lines = [
      makeGithubLine("org/a", "2026-05-04T10:00:00Z"),
      makeGithubLine("org/a", "2026-05-04T10:30:00Z"),
      makeGithubLine("org/b", "2026-05-04T11:00:00Z"),
      // older than 24h → excluded from counts, still the lastEventAt candidate is newer
      makeGithubLine("org/c", "2026-05-03T09:00:00Z"),
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const fromFile = readTunnelEventStats(workdir, undefined, () => now);
      const fromRing = readTunnelEventStats(workdir, ring, () => now);
      expect(fromRing).toEqual(fromFile);
      expect(fromRing.eventCount24h).toBe(3);
      expect(fromRing.eventCount24hByRepo).toEqual({ "org/a": 2, "org/b": 1 });
    } finally {
      ring.stop();
    }
  });

  it("ring underflow (oldestTs newer than cutoff) falls back to the file path and stays correct", () => {
    eventsDir();
    const now = new Date("2026-05-04T12:00:00Z");
    // File has an in-window event the ring will NOT have seen.
    const oldInWindow = makeGithubLine("org/old", "2026-05-04T00:30:00Z"); // within 24h
    const recent = makeGithubLine("org/new", "2026-05-04T11:30:00Z");
    writeFileSync(
      join(workdir, "events", "2026-05.jsonl"),
      [oldInWindow, recent].join("\n") + "\n",
    );

    // Build a ring whose cold-start only saw the LAST line (tiny tailBytes), so
    // its oldestTs is newer than the 24h cutoff → underflow → file fallback.
    const ring = createEventRing({
      catalystDir: workdir,
      // back-read just past the recent line + its leading "\n" so the cold-fill
      // keeps ONLY the recent line (the first, partial fragment is dropped).
      tailBytes: recent.length + 5,
      now: () => now,
    });
    ring.start();
    try {
      // sanity: ring underflows the window
      expect(ring.oldestTs()).toBe("2026-05-04T11:30:00Z");
      const r = readTunnelEventStats(workdir, ring, () => now);
      // fallback must still count the older-in-window event from the file
      expect(r.eventCount24h).toBe(2);
      expect(r.eventCount24hByRepo).toEqual({ "org/old": 1, "org/new": 1 });
    } finally {
      ring.stop();
    }
  });
});

// CTL-1232: profiling counters for the full-log readFileSync fallback paths.
// These are the suspected driver of the monitor's high-water RSS — surfaced by
// GET /debug/memory so the offending path + cadence are visible in live traffic.
describe("full-read counters (CTL-1232)", () => {
  it("recordFullRead increments count and records bytes/ms/ts per label", () => {
    const label = "ctl1232-unit-test";
    const before = fullReadMetrics[label]?.count ?? 0;
    recordFullRead(label, 123, 4.5);
    expect(fullReadMetrics[label].count).toBe(before + 1);
    expect(fullReadMetrics[label].lastBytes).toBe(123);
    expect(fullReadMetrics[label].lastMs).toBe(4.5);
    expect(fullReadMetrics[label].lastTs.length).toBeGreaterThan(0);
    recordFullRead(label, 456, 6.7);
    expect(fullReadMetrics[label].count).toBe(before + 2);
    expect(fullReadMetrics[label].lastBytes).toBe(456);
  });

  it("readTunnelEventStats records a 'tunnelStats' full read on the file-fallback path (no ring)", () => {
    eventsDir();
    const before = fullReadMetrics.tunnelStats?.count ?? 0;
    readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
    expect(fullReadMetrics.tunnelStats?.count ?? 0).toBe(before + 1);
  });

  it("readTunnelEventStats does NOT record a full read when the ring covers the window (fast-path)", () => {
    eventsDir();
    const now = new Date("2026-05-04T12:00:00Z");
    const lines = [
      // an event older than the 24h cutoff so the ring's oldestTs covers the window
      makeGithubLine("org/old", "2026-05-03T09:00:00Z"),
      makeGithubLine("org/a", "2026-05-04T10:00:00Z"),
      makeGithubLine("org/b", "2026-05-04T11:00:00Z"),
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");
    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const before = fullReadMetrics.tunnelStats?.count ?? 0;
      readTunnelEventStats(workdir, ring, () => now); // ring fast-path → no file read
      expect(fullReadMetrics.tunnelStats?.count ?? 0).toBe(before);
    } finally {
      ring.stop();
    }
  });
});

// CTL-1515: the ring-underflow fallbacks must scan the current-month log in
// bounded CHUNKS (openSync/readSync) — never a single whole-file readFileSync
// (a ~1.7 GB contiguous transient bun/mimalloc never returns). These tests are
// a REINTRODUCTION GUARD: they count node:fs readSync/readFileSync so a revert
// to readFileSync fails CI. Spying the shared `fs` namespace is observed inside
// event-log-reader.ts even though it destructures its fs imports (Bun's node:fs
// is a singleton). NOTE: Bun's `mockRestore()` clears the recorded calls, so
// every count/assertion is captured into a plain variable BEFORE the spy is
// restored in `finally`.
describe("scanFileLines (CTL-1515)", () => {
  it("chunks a file larger than chunkBytes (>1 readSync, no readFileSync) and stitches a multibyte char split across a chunk boundary", () => {
    const dir = eventsDir();
    const file = join(dir, "scan.jsonl");
    // Deterministic byte layout so a chunk boundary provably bisects a 4-byte
    // emoji. "ab🚀cd" = 61 62 | F0 9F 9A 80 | 63 64 (🚀 occupies bytes 2..5).
    // With chunkBytes = 4 the first boundary at byte 4 falls INSIDE 🚀
    // (bytes 2,3 in chunk 1; bytes 4,5 in chunk 2) → the StringDecoder must
    // carry the partial sequence across the read.
    const lines = ["ab🚀cd", "second-é-line", "third"];
    const text = lines.join("\n") + "\n";
    writeFileSync(file, text);
    expect(Buffer.byteLength("🚀")).toBe(4); // 4-byte sequence, straddles byte 4

    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    // Assert INSIDE the try: Bun's mockRestore() clears the recorded calls, so
    // counts must be read while the spy is live. finally still restores the spy
    // even if an assertion throws.
    try {
      const got: string[] = [];
      const bytes = scanFileLines(file, (l) => got.push(l), 4);
      // (a) chunked: many readSync calls for a file far larger than the 4-byte chunk
      expect(readSyncSpy.mock.calls.length).toBeGreaterThan(1);
      // (b) NEVER a whole-file readFileSync
      expect(readFileSyncSpy.mock.calls.length).toBe(0);
      // Returns bytes scanned = file byte length
      expect(bytes).toBe(Buffer.byteLength(text));
      // Parity: same lines as split (scanFileLines omits the trailing empty of a
      // newline-terminated file, hence the .filter(l => l.length > 0)).
      expect(got).toEqual(text.split("\n").filter((l) => l.length > 0));
      // The multibyte line survived byte-exact (no dropped/corrupted char).
      expect(got[0]).toBe("ab🚀cd");
      expect(got[1]).toBe("second-é-line");
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  });

  it("emits a final line that lacks a trailing newline", () => {
    const dir = eventsDir();
    const file = join(dir, "no-trailing-nl.jsonl");
    writeFileSync(file, "one\ntwo\nthree"); // no trailing "\n"
    const got: string[] = [];
    scanFileLines(file, (l) => got.push(l), 3);
    expect(got).toEqual(["one", "two", "three"]);
  });
});

describe("readBacklog / readTunnelEventStats fallback: chunked scan, never readFileSync (CTL-1515)", () => {
  it("readBacklog empty-predicate fallback (no ring) uses readSync, never readFileSync", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    const lines = Array.from({ length: 8 }, (_, i) => makeLine(`evt-${i}`));
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    try {
      const r = await readBacklog({
        catalystDir: workdir,
        predicate: "",
        limit: 3,
        ring: null,
        now: () => now,
      });
      // Behavioral parity with the old readFileSync path: last 3 non-empty lines.
      expect(r.length).toBe(3);
      expect(JSON.parse(r[0]).event).toBe("evt-5");
      expect(JSON.parse(r[2]).event).toBe("evt-7");
      // Reintroduction guard: chunked scan ran, no whole-file read.
      expect(readSyncSpy.mock.calls.length).toBeGreaterThan(0);
      expect(readFileSyncSpy.mock.calls.length).toBe(0);
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  });

  it("readBacklog predicate fallback (no ring) uses readSync, never readFileSync", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    const lines = [
      makeLine("github.pr.merged", { i: 0 }),
      makeLine("linear.issue.created"),
      makeLine("github.pr.opened", { i: 1 }),
    ];
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");

    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    try {
      const r = await readBacklog({
        catalystDir: workdir,
        predicate: '.event | startswith("github.")',
        limit: 100,
        ring: null,
        now: () => now,
      });
      expect(r.length).toBe(2);
      expect(r.every((l) => (JSON.parse(l) as { event: string }).event.startsWith("github."))).toBe(true);
      expect(readSyncSpy.mock.calls.length).toBeGreaterThan(0);
      expect(readFileSyncSpy.mock.calls.length).toBe(0);
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  });

  it("predicate fallback returns only the last `limit` matches for a broad predicate — bounded + waits for jq (CTL-1515)", async () => {
    const dir = eventsDir();
    const now = new Date("2026-05-04T00:00:00Z");
    // 50 matching records; a broad predicate matches them all. The rolling buffer
    // must retain only the last `limit`, and stream.end() must wait for jq to emit
    // every match so the newest ones aren't cut off by a fixed-delay flush.
    const lines = Array.from({ length: 50 }, (_, i) => makeLine("github.pr.opened", { i }));
    writeFileSync(join(dir, "2026-05.jsonl"), lines.join("\n") + "\n");
    const r = await readBacklog({
      catalystDir: workdir,
      predicate: '.event | startswith("github.")',
      limit: 5,
      ring: null,
      now: () => now,
    });
    expect(r.length).toBe(5); // bounded to `limit`, not all 50
    // the newest 5 (i = 45..49), proving end() waited for jq's full output
    expect(r.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual([45, 46, 47, 48, 49]);
  });

  it("readTunnelEventStats file fallback (no ring) uses readSync, never readFileSync — counts unchanged", () => {
    eventsDir();
    const lines = [
      makeGithubLine("org/a", "2026-05-04T10:00:00Z"),
      makeGithubLine("org/a", "2026-05-04T10:30:00Z"),
      makeGithubLine("org/b", "2026-05-04T11:00:00Z"),
    ];
    writeFileSync(join(workdir, "events", "2026-05.jsonl"), lines.join("\n") + "\n");

    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    try {
      const r = readTunnelEventStats(workdir, undefined, () => new Date("2026-05-04T12:00:00Z"));
      // Byte-identical counts to the old split-based path.
      expect(r.eventCount24h).toBe(3);
      expect(r.eventCount24hByRepo).toEqual({ "org/a": 2, "org/b": 1 });
      // Reintroduction guard.
      expect(readSyncSpy.mock.calls.length).toBeGreaterThan(0);
      expect(readFileSyncSpy.mock.calls.length).toBe(0);
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  });
});

// ── CTL-1529: readTailUtf8 — the bounded replacement for "read it all, then
// slice the tail off". Two live sites shipped that shape; the worst of them ran
// against the 344 MB monthly event log on every service-health poll while its
// own comment claimed "Cap at 512KB to bound the read".
describe("readTailUtf8 (CTL-1529)", () => {
  const LINE = "y".repeat(99) + "\n"; // exactly 100 bytes per line

  function writeLines(name: string, n: number): string {
    const path = join(workdir, name);
    writeFileSync(path, LINE.repeat(n));
    return path;
  }

  it("returns the whole file when it is smaller than the cap (byte-identical to a full read)", () => {
    const path = writeLines("small.jsonl", 10);
    expect(readTailUtf8(path, 64 * 1024)).toBe(LINE.repeat(10));
  });

  it("returns only the tail when the file exceeds the cap, and READS only that much", () => {
    const path = writeLines("big.jsonl", 100_000); // 10 MB
    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    let out: string;
    try {
      out = readTailUtf8(path, 10_000); // 10 KB cap
      const requested = bytesRequested(readSyncSpy.mock.calls as unknown[][]);
      // CTL-1550 (P2): the boundary check reads one extra byte (the byte before
      // `from`) to determine whether the window starts on a record boundary.
      // That probe is 1 byte, so the total stays at most cap + 1.
      expect(requested).toBeLessThanOrEqual(10_001);
      expect(readFileSyncSpy.mock.calls.filter((c) => c[0] === path)).toEqual([]);
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
    // 10_000 / 100 = 100 lines requested. CTL-1550 fix: the cap lands exactly on
    // a line boundary (byte 9,989,999 is '\n'), so the first buffered line is a
    // COMPLETE record and must be kept. All 100 lines are returned.
    expect(out.length).toBe(10_000);
    expect(out).toBe(LINE.repeat(100));
  });

  it("(CTL-1550) keeps the first complete record when `from` is exactly on a line boundary", () => {
    // Two 50-byte lines. Cap = 50 → from = 50. Byte at position 49 is '\n', so
    // the first byte of the tail window is the very start of line 2 — a complete
    // record. The boundary check must detect this and keep the line.
    const L50 = "z".repeat(49) + "\n";
    const path = join(workdir, "boundary.jsonl");
    writeFileSync(path, L50.repeat(2)); // 100 bytes total
    const out = readTailUtf8(path, 50);
    expect(out).toBe(L50); // one complete line, not an empty string
    expect(out.length).toBe(50);
  });

  it("DROPS the leading fragment so a cut record cannot parse into a bogus event", () => {
    const path = join(workdir, "frag.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ ts: "2026-07-01T00:00:00Z", keep: false }) + "\n" +
        JSON.stringify({ ts: "2026-07-02T00:00:00Z", keep: true }) + "\n",
    );
    // A cap that starts mid-way through the FIRST record.
    const out = readTailUtf8(path, 40);
    expect(out.includes("keep\":false")).toBe(false);
    for (const line of out.split("\n").filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("a missing or empty file is \"\" and never throws", () => {
    expect(readTailUtf8(join(workdir, "nope.jsonl"), 1024)).toBe("");
    const empty = join(workdir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(readTailUtf8(empty, 1024)).toBe("");
  });
});
