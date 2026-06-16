import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBacklog, tailEventLog, readTunnelEventStats } from "../lib/event-log-reader";
import { createEventRing } from "../lib/event-ring";

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
