import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanonicalEventWriter } from "../lib/event-writer";
import type { CanonicalEvent } from "../lib/canonical-event";

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
    id: "00000000-0000-4000-8000-000000000000",
    observedTs: "2026-05-08T18:00:00.000Z",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": "catalyst.github",
      "service.namespace": "catalyst",
      "service.version": "8.2.0",
      "host.name": "test-host",
      "host.id": "0000000000000000",
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

  // ── CTL-1529: the legacy-rotation probe is BOUNDED ────────────────────────
  //
  // `isLegacyFirstLine` needed ONE line and read the whole file to get it. The
  // file is the monthly event log — 344,818,089 bytes on mini — and `server.ts`
  // constructs THREE writers, each with its own `rotated` Set, so a single
  // monitor process paid that read three times at startup. It is the exact
  // defect CTL-1529 exists to remove, and it lived in a directory the guard
  // already scanned (the argument was an opaque `filePath`, three hops from
  // anything spelled like the event log, so the guard could not see it).
  describe("CTL-1529 — the legacy probe reads a bounded prefix, not the whole file", () => {
    const BIG = 8 * 1024 * 1024;
    const fixed = new Date("2026-05-08T18:00:00Z");
    const target = () => join(workdir, "2026-05.jsonl");

    /** Write a monthly file whose first line is `first`, padded out to ~8 MiB. */
    function writeBigMonth(first: string): void {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), first + "\n" + "z".repeat(BIG) + "\n");
    }

    it("reads only a small prefix of a multi-megabyte log to classify the first line", async () => {
      writeBigMonth(JSON.stringify(sampleEvent()));
      const readSyncSpy = spyOn(fs, "readSync");
      const readFileSyncSpy = spyOn(fs, "readFileSync");
      try {
        const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
        await writer.append(sampleEvent({ body: { message: "second" } }));

        // The whole-file API is never used on the log at all.
        const fullReads = readFileSyncSpy.mock.calls.filter((c) => c[0] === target());
        expect(fullReads).toEqual([]);

        // And the bounded API asked for at most one initial probe (64 KiB),
        // regardless of the file being 8 MiB.
        const requested = bytesRequested(readSyncSpy.mock.calls as unknown[][]);
        expect(requested).toBeGreaterThan(0);
        expect(requested).toBeLessThanOrEqual(64 * 1024);
        expect(requested).toBeLessThan(BIG);
      } finally {
        readSyncSpy.mockRestore();
        readFileSyncSpy.mockRestore();
      }
      // …and the semantics are unchanged: a canonical first line is not rotated.
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(false);
    });

    it("still rotates a LEGACY first line in a multi-megabyte log (bounding did not blind it)", async () => {
      writeBigMonth(JSON.stringify({ ts: "2026-05-07T00:00:00Z", event: "session-started" }));
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(true);
    });

    it("FAIL-SAFE: an undecidably long first line does NOT rotate, and says so", async () => {
      // The one deliberate behavior change. Old code read the whole file, found
      // an unparseable first line, and RENAMED the live log. The bounded probe
      // gives up at 1 MiB — and "I could not read enough" must never be
      // conflated with "this is legacy", because only one of them destroys the
      // path every reader is tailing.
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "x".repeat(2 * 1024 * 1024) + "\n");
      const warnings: string[] = [];
      const writer = new CanonicalEventWriter({
        baseDir: workdir,
        now: () => fixed,
        logger: { warn: (m) => warnings.push(m) },
      });
      await writer.append(sampleEvent());
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(false);
      expect(warnings.some((w) => w.includes("first-line probe exceeded"))).toBe(true);
      // The append still lands.
      expect(readFileSync(target(), "utf8")).toContain("github.pr.merged");
    });

    it("a SHORT unparseable first line still rotates (the fail-safe is only for the cap)", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "not json at all\n");
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(true);
    });

    it("preserves the old split().find() semantics: leading blank lines are skipped", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "\n\n" + JSON.stringify({ ts: "x", event: "legacy" }) + "\n");
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      // The first NON-EMPTY line is legacy ⇒ rotate (a naive "bytes before the
      // first \n" probe would have seen "" and skipped rotation).
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(true);
    });

    it("preserves the old semantics: a first line with NO trailing newline still classifies", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), JSON.stringify({ ts: "x", event: "legacy" })); // no "\n"
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(true);
    });

    it("an empty file is not legacy (nothing to rotate)", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "");
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(existsSync(join(workdir, "2026-05.jsonl.legacy"))).toBe(false);
    });
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
