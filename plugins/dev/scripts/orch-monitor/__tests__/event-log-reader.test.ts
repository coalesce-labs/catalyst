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
import { readBacklog, tailEventLog } from "../lib/event-log-reader";

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
