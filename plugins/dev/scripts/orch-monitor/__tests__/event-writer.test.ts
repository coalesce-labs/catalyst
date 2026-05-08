import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanonicalEventWriter } from "../lib/event-writer";
import type { CanonicalEvent } from "../lib/canonical-event";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "event-writer-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function readMonth(baseDir: string, ts: Date): string {
  const y = ts.getUTCFullYear();
  const m = String(ts.getUTCMonth() + 1).padStart(2, "0");
  const path = join(baseDir, `${y}-${m}.jsonl`);
  return readFileSync(path, "utf8");
}

function sampleEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    ts: "2026-05-08T18:00:00.000Z",
    observedTs: "2026-05-08T18:00:00.000Z",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": "catalyst.github",
      "service.namespace": "catalyst",
      "service.version": "8.2.0",
    },
    attributes: {
      "event.name": "github.pr.merged",
      "event.entity": "pr",
      "event.action": "merged",
    },
    body: { message: "test" },
    ...overrides,
  };
}

describe("CanonicalEventWriter", () => {
  it("appends a single canonical JSONL line per call", async () => {
    const fixed = new Date("2026-05-08T18:00:00Z");
    const writer = new CanonicalEventWriter({
      baseDir: workdir,
      now: () => fixed,
    });
    await writer.append(sampleEvent());
    const contents = readMonth(workdir, fixed);
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.ts).toBe("2026-05-08T18:00:00.000Z");
    expect(parsed.attributes["event.name"]).toBe("github.pr.merged");
    expect(parsed.resource["service.namespace"]).toBe("catalyst");
    expect(parsed.severityNumber).toBe(9);
  });

  it("creates the baseDir directory if missing", async () => {
    const fixed = new Date("2026-05-08T18:00:00Z");
    const baseDir = join(workdir, "events");
    const writer = new CanonicalEventWriter({ baseDir, now: () => fixed });
    expect(existsSync(baseDir)).toBe(false);
    await writer.append(sampleEvent());
    expect(existsSync(baseDir)).toBe(true);
  });

  it("appends to the same monthly file across multiple writes", async () => {
    const fixed = new Date("2026-05-03T00:00:00Z");
    const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
    for (let i = 0; i < 5; i++) {
      await writer.append(sampleEvent({ body: { message: `msg ${i}` } }));
    }
    const lines = readMonth(workdir, fixed)
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
  });

  it("rolls over to a new file when the month changes", async () => {
    let now = new Date("2026-05-31T23:59:59Z");
    const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => now });
    await writer.append(sampleEvent({ body: { message: "may" } }));
    now = new Date("2026-06-01T00:00:00Z");
    await writer.append(sampleEvent({ body: { message: "june" } }));
    expect(readFileSync(join(workdir, "2026-05.jsonl"), "utf8")).toContain("may");
    expect(readFileSync(join(workdir, "2026-06.jsonl"), "utf8")).toContain("june");
  });

  it("rotates a pre-existing legacy file (no `attributes` field) on first canonical write", async () => {
    const fixed = new Date("2026-05-08T18:00:00Z");
    const target = join(workdir, "2026-05.jsonl");
    mkdirSync(workdir, { recursive: true });
    // Pre-existing legacy v1 line — flat schema, no `attributes`
    writeFileSync(
      target,
      JSON.stringify({
        ts: "2026-05-07T00:00:00Z",
        event: "session-started",
        session: "s1",
      }) + "\n",
    );
    const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
    await writer.append(sampleEvent());
    const legacyPath = join(workdir, "2026-05.jsonl.legacy");
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf8")).toContain('"event":"session-started"');

    const newContents = readFileSync(target, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(newContents.length).toBe(1);
    const parsed = JSON.parse(newContents[0] ?? "");
    expect(parsed.attributes["event.name"]).toBe("github.pr.merged");
  });

  it("does NOT rotate when the existing file is already canonical", async () => {
    const fixed = new Date("2026-05-08T18:00:00Z");
    const target = join(workdir, "2026-05.jsonl");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(target, JSON.stringify(sampleEvent()) + "\n");
    const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
    await writer.append(sampleEvent({ body: { message: "second" } }));
    const legacyPath = join(workdir, "2026-05.jsonl.legacy");
    expect(existsSync(legacyPath)).toBe(false);
    const lines = readFileSync(target, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });

  it("only rotates legacy file once per writer instance per path", async () => {
    const fixed = new Date("2026-05-08T18:00:00Z");
    const target = join(workdir, "2026-05.jsonl");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ event: "legacy", ts: "2026-05-07T00:00:00Z" }) + "\n",
    );
    const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
    await writer.append(sampleEvent());
    await writer.append(sampleEvent({ body: { message: "second" } }));
    const lines = readFileSync(target, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });

  it("write failure is logged but does not throw", async () => {
    const errors: string[] = [];
    const writer = new CanonicalEventWriter({
      baseDir: "/proc/cannot/write/here",
      logger: { error: (m) => errors.push(m) },
    });
    let threw = false;
    try {
      await writer.append(sampleEvent());
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
