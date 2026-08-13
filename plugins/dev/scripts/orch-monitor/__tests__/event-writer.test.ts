import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanonicalEventWriter } from "../lib/event-writer";
import type { CanonicalEvent } from "../lib/canonical-event";

// CTL-1813: rotation destinations are now UNIQUE (a fixed `.legacy` is a rescue slot of
// depth one — the next rotation clobbers the previous month's only copy). Tests therefore
// look for ANY rotated sibling rather than one exact name.
function rotatedFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.legacy`));
}


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
    // CTL-1813: the destination is now unique, so resolve it rather than assuming the name.
    const rotated = rotatedFiles(workdir, "2026-05.jsonl");
    expect(rotated.length).toBe(1);
    expect(readFileSync(join(workdir, rotated[0]), "utf8")).toContain('"event":"session-started"');

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
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(0);
    });

    it("still rotates a LEGACY first line in a multi-megabyte log (bounding did not blind it)", async () => {
      writeBigMonth(JSON.stringify({ ts: "2026-05-07T00:00:00Z", event: "session-started" }));
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(1);
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
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(0);
      expect(warnings.some((w) => w.includes("first-line probe exceeded"))).toBe(true);
      // The append still lands.
      expect(readFileSync(target(), "utf8")).toContain("github.pr.merged");
    });

    // ⛔ CTL-1813 REVERSES this case. It previously asserted that a short unparseable first
    // line SHOULD rotate — "the fail-safe is only for the cap" — and that was a considered
    // decision, not an oversight: CTL-1529 reasoned that an unreadably-large probe means "I
    // could not look", while a short garbage line means the file really is junk.
    //
    // MEASUREMENT SINCE THEN FALSIFIES THAT PREMISE. CTL-1809 established that our own bash
    // appends TEAR above 1025 bytes (macOS BUFSIZ), so a short unparseable first line is now
    // a predictable product of the writer rather than evidence of a junk file. And the cost
    // is total: driven against this writer, one torn first line rotated 349 live events
    // aside, and a second torn line one rotation later overwrote the only surviving copy.
    //
    // CTL-1529's own words argue for the reversal — "'I could not read enough' must never be
    // conflated with 'this is legacy', because only one of them destroys the path every
    // reader is tailing." Damage is now in the first category too.
    it("CTL-1813: a SHORT unparseable first line does NOT rotate — damage is not a legacy log", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "not json at all\n");
      const warnings: string[] = [];
      const writer = new CanonicalEventWriter({
        baseDir: workdir,
        now: () => fixed,
        logger: { warn: (m) => warnings.push(m) },
      });
      await writer.append(sampleEvent());
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(0);
      // Silence is a defect: refusing must be audible, or a damaged log looks healthy.
      expect(warnings.some((w) => w.includes("does not parse as JSON"))).toBe(true);
      // Every pre-existing byte is still there, and the append still lands.
      const body = readFileSync(target(), "utf8");
      expect(body).toContain("not json at all");
      expect(body).toContain("github.pr.merged");
    });

    // THE LOAD-BEARING ONE: two rotations must not destroy the first month.
    it("CTL-1813: a second legacy rotation cannot clobber the first", async () => {
      mkdirSync(workdir, { recursive: true });
      // Round 1 — a genuine v1 line (parses, no `attributes`) rotates.
      writeFileSync(target(), JSON.stringify({ ts: "x", event: "MONTH_A" }) + "\n");
      await new CanonicalEventWriter({ baseDir: workdir, now: () => fixed }).append(sampleEvent());
      // Round 2 — a NEW writer (fresh in-process `rotated` set, as a restart would have) sees
      // another legacy line and rotates again.
      writeFileSync(target(), JSON.stringify({ ts: "y", event: "MONTH_B" }) + "\n");
      await new CanonicalEventWriter({ baseDir: workdir, now: () => fixed }).append(sampleEvent());

      const rotated = rotatedFiles(workdir, "2026-05.jsonl");
      expect(rotated.length).toBe(2);
      // With a fixed `.legacy` destination the second rename overwrote the first, and
      // MONTH_A was unrecoverable. Both must survive.
      const all = rotated.map((f) => readFileSync(join(workdir, f), "utf8")).join("");
      expect(all).toContain("MONTH_A");
      expect(all).toContain("MONTH_B");
    });

    it("preserves the old split().find() semantics: leading blank lines are skipped", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "\n\n" + JSON.stringify({ ts: "x", event: "legacy" }) + "\n");
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      // The first NON-EMPTY line is legacy ⇒ rotate (a naive "bytes before the
      // first \n" probe would have seen "" and skipped rotation).
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(1);
    });

    it("preserves the old semantics: a first line with NO trailing newline still classifies", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), JSON.stringify({ ts: "x", event: "legacy" })); // no "\n"
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(1);
    });

    it("an empty file is not legacy (nothing to rotate)", async () => {
      mkdirSync(workdir, { recursive: true });
      writeFileSync(target(), "");
      const writer = new CanonicalEventWriter({ baseDir: workdir, now: () => fixed });
      await writer.append(sampleEvent());
      expect(rotatedFiles(workdir, "2026-05.jsonl").length).toBe(0);
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
