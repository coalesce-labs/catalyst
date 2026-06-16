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
import { createEventRing } from "../lib/event-ring";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "event-ring-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function eventsDir(): string {
  const d = join(workdir, "events");
  mkdirSync(d, { recursive: true });
  return d;
}

function monthFile(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(workdir, "events", `${y}-${m}.jsonl`);
}

function line(event: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts,
    attributes: { "event.name": event },
    body: { payload: {} },
    ...extra,
  });
}

interface ParsedLine {
  ts?: string;
  attributes: { "event.name": string };
  i?: number;
}

function eventName(l: string): string {
  return (JSON.parse(l) as ParsedLine).attributes["event.name"];
}

function field(l: string): ParsedLine {
  return JSON.parse(l) as ParsedLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms));
}

describe("createEventRing", () => {
  it("cold-start back-read pre-fills from an existing file; query returns the tail newest-last", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const lines = Array.from({ length: 5 }, (_, i) =>
      line(`evt-${i}`, "2026-06-04T00:00:00Z"),
    );
    writeFileSync(monthFile(now), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const got = ring.query({ limit: 3 });
      expect(got.length).toBe(3);
      expect(eventName(got[0])).toBe("evt-2");
      expect(eventName(got[2])).toBe("evt-4");
    } finally {
      ring.stop();
    }
  });

  it("caps the ring at capLines; oldest lines are dropped", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const cap = 50;
    const lines = Array.from({ length: cap + 100 }, (_, i) =>
      line(`evt-${i}`, "2026-06-04T00:00:00Z"),
    );
    writeFileSync(monthFile(now), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, capLines: cap, now: () => now });
    ring.start();
    try {
      expect(ring.size()).toBe(cap);
      const all = ring.query({ limit: 10_000 });
      expect(all.length).toBe(cap);
      // newest survives, oldest 100 gone
      expect(eventName(all[all.length - 1])).toBe(`evt-${cap + 100 - 1}`);
      expect(all.some((l) => eventName(l) === "evt-0")).toBe(false);
    } finally {
      ring.stop();
    }
  });

  it("picks up newly appended lines on the next poll tick", async () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    writeFileSync(monthFile(now), line("first", "2026-06-04T00:00:00Z") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => now });
    ring.start();
    try {
      appendFileSync(monthFile(now), line("second", "2026-06-04T00:01:00Z") + "\n");
      // wait for at least one poll tick to ingest the append
      for (let i = 0; i < 50 && ring.size() < 2; i++) await sleep(10);
      const got = ring.query({ limit: 10 });
      expect(got.map((l) => eventName(l))).toContain("second");
    } finally {
      ring.stop();
    }
  });

  it("month rollover: keeps prior-month lines queryable and ingests the new-month file", async () => {
    eventsDir();
    let current = new Date("2026-05-31T23:59:00Z");
    writeFileSync(monthFile(current), line("may-evt", "2026-05-31T23:59:00Z") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => current });
    ring.start();
    try {
      // advance the injected clock across the month boundary, write June file
      current = new Date("2026-06-01T00:01:00Z");
      writeFileSync(monthFile(current), line("jun-evt", "2026-06-01T00:01:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 2; i++) await sleep(10);
      const names = ring.query({ limit: 100 }).map((l) => eventName(l));
      expect(names).toContain("may-evt"); // prior month stays in ring
      expect(names).toContain("jun-evt"); // new month ingested after rollover
    } finally {
      ring.stop();
    }
  });

  it("oldestTs returns the earliest retained ts, null when empty", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      expect(ring.oldestTs()).toBeNull();
    } finally {
      ring.stop();
    }

    writeFileSync(
      monthFile(now),
      [
        line("a", "2026-06-04T00:00:01Z"),
        line("b", "2026-06-04T00:00:02Z"),
      ].join("\n") + "\n",
    );
    const ring2 = createEventRing({ catalystDir: workdir, now: () => now });
    ring2.start();
    try {
      expect(ring2.oldestTs()).toBe("2026-06-04T00:00:01Z");
    } finally {
      ring2.stop();
    }
  });

  it("jq-predicate query matches createFilterStream semantics", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const lines = [
      line("github.pr.merged", "2026-06-04T00:00:01Z"),
      line("linear.issue.created", "2026-06-04T00:00:02Z"),
      line("github.pr.opened", "2026-06-04T00:00:03Z"),
    ];
    writeFileSync(monthFile(now), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const got = ring.query({
        predicate: '(.attributes."event.name") | startswith("github.")',
        limit: 100,
      });
      expect(got.length).toBe(2);
      expect(got.every((l) => eventName(l).startsWith("github."))).toBe(true);
    } finally {
      ring.stop();
    }
  });

  it("sinceTs filter excludes lines with ts < sinceTs", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const lines = [
      line("old", "2026-06-04T00:00:01Z"),
      line("new", "2026-06-04T00:00:05Z"),
    ];
    writeFileSync(monthFile(now), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const got = ring.query({ sinceTs: "2026-06-04T00:00:03Z", limit: 100 });
      const names = got.map((l) => eventName(l));
      expect(names).toContain("new");
      expect(names).not.toContain("old");
    } finally {
      ring.stop();
    }
  });

  it("query honors limit (last N matching, newest-last)", () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const lines = Array.from({ length: 30 }, (_, i) =>
      line("github.pr.merged", "2026-06-04T00:00:00Z", { i }),
    );
    writeFileSync(monthFile(now), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, now: () => now });
    ring.start();
    try {
      const got = ring.query({
        predicate: '(.attributes."event.name") == "github.pr.merged"',
        limit: 5,
      });
      expect(got.length).toBe(5);
      expect(field(got[0]).i).toBe(25);
      expect(field(got[4]).i).toBe(29);
    } finally {
      ring.stop();
    }
  });
});

// CTL-1224: live fan-out hook. onAppend fires synchronously per tick batch with
// ONLY the newly-appended lines, never on cold-fill, and a throwing listener
// must not stall the shared tick loop.
describe("createEventRing onAppend (live fan-out hook)", () => {
  it("T1 — fires for live (tick) appends only, with the batch of new lines", async () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    writeFileSync(monthFile(now), line("a", "2026-06-04T00:00:00Z") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => now });
    ring.start();
    const batches: string[][] = [];
    ring.onAppend((lines) => batches.push(lines));
    try {
      appendFileSync(monthFile(now), line("b", "2026-06-04T00:01:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 2; i++) await sleep(10);
      expect(ring.size()).toBe(2);
      // Listener received the new line "b" only — cold-fill "a" never replayed.
      const all = batches.flat();
      expect(all.map((l) => eventName(l))).toEqual(["b"]);
      expect(all.some((l) => eventName(l) === "a")).toBe(false);
    } finally {
      ring.stop();
    }
  });

  it("T2 — does NOT fire during cold-fill / start()", async () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    const seed = Array.from({ length: 5 }, (_, i) =>
      line(`seed-${i}`, "2026-06-04T00:00:00Z"),
    );
    writeFileSync(monthFile(now), seed.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => now });
    ring.start(); // cold-fills 5
    expect(ring.size()).toBe(5);

    const batches: string[][] = [];
    ring.onAppend((lines) => batches.push(lines));
    try {
      // No new ticks have occurred since registering → no delivery yet.
      await sleep(40);
      expect(batches.flat()).toEqual([]);

      // A genuine live append fires exactly the one new line.
      appendFileSync(monthFile(now), line("live", "2026-06-04T00:02:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 6; i++) await sleep(10);
      expect(ring.size()).toBe(6);
      expect(batches.flat().map((l) => eventName(l))).toEqual(["live"]);
    } finally {
      ring.stop();
    }
  });

  it("T3 — deregister stops delivery", async () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    writeFileSync(monthFile(now), line("a", "2026-06-04T00:00:00Z") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => now });
    ring.start();
    const batches: string[][] = [];
    const unsubscribe = ring.onAppend((lines) => batches.push(lines));
    unsubscribe();
    try {
      appendFileSync(monthFile(now), line("b", "2026-06-04T00:01:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 2; i++) await sleep(10);
      expect(ring.size()).toBe(2); // ring still ingested
      expect(batches.flat()).toEqual([]); // but no delivery after deregister
    } finally {
      ring.stop();
    }
  });

  it("T4 — a throwing listener does not kill the tick loop", async () => {
    eventsDir();
    const now = new Date("2026-06-04T00:00:00Z");
    writeFileSync(monthFile(now), line("a", "2026-06-04T00:00:00Z") + "\n");

    const ring = createEventRing({ catalystDir: workdir, pollMs: 10, now: () => now });
    ring.start();
    ring.onAppend(() => {
      throw new Error("boom");
    });
    const good: string[] = [];
    ring.onAppend((lines) => good.push(...lines));
    try {
      appendFileSync(monthFile(now), line("b", "2026-06-04T00:01:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 2; i++) await sleep(10);
      appendFileSync(monthFile(now), line("c", "2026-06-04T00:02:00Z") + "\n");
      for (let i = 0; i < 50 && ring.size() < 3; i++) await sleep(10);
      expect(ring.size()).toBe(3); // loop survived the throw, kept ingesting
      // well-behaved listener still received both live appends
      expect(good.map((l) => eventName(l))).toEqual(["b", "c"]);
    } finally {
      ring.stop();
    }
  });
});
