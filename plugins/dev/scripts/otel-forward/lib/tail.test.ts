import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer } from "./tail.ts";

describe("createTailer", () => {
  test("emits canonical lines AND flat reap-intent lines, skips unparseable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const file = join(dir, "2026-05.jsonl");
    // flat event (has `event`, no `attributes`) — now forwarded for normalization
    writeFileSync(
      file,
      JSON.stringify({ ts: "2026-05-08T00:00:00Z", event: "phase.terminal.reap-requested" }) + "\n"
    );
    // canonical event — forwarded as before
    appendFileSync(
      file,
      JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "test" } }) + "\n"
    );
    // malformed line — not forwarded
    appendFileSync(file, "not-json\n");
    // object with neither event nor attributes — not forwarded
    appendFileSync(file, JSON.stringify({ ts: "2026-05-08T00:00:02Z", otherField: "x" }) + "\n");

    const emitted: string[] = [];
    const ac = new AbortController();
    const tailer = createTailer({
      filePath: file,
      offset: 0,
      onLine: (l) => emitted.push(l),
      signal: ac.signal,
      pollMs: 10,
    });
    await tailer.drain();
    ac.abort();

    expect(emitted.length).toBe(2);
    const flat = JSON.parse(emitted[0]);
    expect(flat.event).toBe("phase.terminal.reap-requested");
    const canonical = JSON.parse(emitted[1]);
    expect(canonical.attributes["event.name"]).toBe("test");
    rmSync(dir, { recursive: true });
  });

  test("currentOffset advances to file size after draining appended lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const file = join(dir, "2026-05.jsonl");
    const line =
      JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "test" } }) + "\n";
    writeFileSync(file, line);

    const ac = new AbortController();
    const tailer = createTailer({
      filePath: file,
      offset: 0,
      onLine: () => {},
      signal: ac.signal,
      pollMs: 10,
    });
    expect(tailer.currentOffset()).toBe(0);
    await tailer.drain();
    ac.abort();

    expect(tailer.currentOffset()).toBe(Buffer.byteLength(line, "utf8"));
    rmSync(dir, { recursive: true });
  });

  test("resumes from a non-zero starting offset and only reads bytes after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const file = join(dir, "2026-05.jsonl");
    const first =
      JSON.stringify({ ts: "2026-05-08T00:00:00Z", attributes: { "event.name": "already-read" } }) +
      "\n";
    const second =
      JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "new" } }) + "\n";
    writeFileSync(file, first + second);

    const emitted: string[] = [];
    const ac = new AbortController();
    const startOffset = Buffer.byteLength(first, "utf8");
    const tailer = createTailer({
      filePath: file,
      offset: startOffset,
      onLine: (l) => emitted.push(l),
      signal: ac.signal,
      pollMs: 10,
    });
    await tailer.drain();
    ac.abort();

    expect(emitted.length).toBe(1);
    expect(JSON.parse(emitted[0]).attributes["event.name"]).toBe("new");
    expect(tailer.currentOffset()).toBe(Buffer.byteLength(first + second, "utf8"));
    rmSync(dir, { recursive: true });
  });

  test("handles rollover by switching file path", async () => {
    // CTL-1216: the option is `eventLogFn`, not `monthFn` — the resolved file is
    // no longer necessarily a month.
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    let callCount = 0;
    const eventLogFn = () => {
      callCount++;
      return callCount === 1 ? join(dir, "2026-W17.jsonl") : join(dir, "2026-W18.jsonl");
    };
    const tailer = createTailer({
      eventLogFn,
      offset: 0,
      onLine: () => {},
      signal: new AbortController().signal,
      pollMs: 10,
    });
    expect(tailer.currentPath()).toBe(join(dir, "2026-W17.jsonl"));
    rmSync(dir, { recursive: true });
  });

  test("CTL-1216: rollover DRAINS the old file's unread tail before switching", async () => {
    // The forwarder abandoned the old file at every boundary, so bytes appended
    // between its last poll and the rollover were never forwarded by anyone. The
    // checkpoint keeps advancing across that hole, so nothing downstream reports it.
    const dir = mkdtempSync(join(tmpdir(), "tail-drain-"));
    try {
      const fileA = join(dir, "2026-W17.jsonl");
      const fileB = join(dir, "2026-W18.jsonl");
      const a1 = JSON.stringify({ ts: "t", attributes: { "event.name": "a1" } });
      const a2 = JSON.stringify({ ts: "t", attributes: { "event.name": "a2" } });
      const b1 = JSON.stringify({ ts: "t", attributes: { "event.name": "b1" } });

      writeFileSync(fileA, a1 + "\n");
      writeFileSync(fileB, b1 + "\n");

      let rolled = false;
      const emitted: string[] = [];
      const ac = new AbortController();
      const tailer = createTailer({
        eventLogFn: () => (rolled ? fileB : fileA),
        offset: 0,
        onLine: (l) => emitted.push(l),
        signal: ac.signal,
        pollMs: 5,
      });

      const run = tailer.run();
      await new Promise((r) => setTimeout(r, 40)); // consumes a1
      appendFileSync(fileA, a2 + "\n"); // written AFTER the last poll
      rolled = true; // ...and the boundary happens before it is read
      await new Promise((r) => setTimeout(r, 60));
      ac.abort();
      await run;

      const names = emitted.map((l) => JSON.parse(l).attributes["event.name"]);
      // a2 is the byte that used to vanish forever. b1 is the new file's head.
      expect(names).toContain("a2");
      expect(names).toContain("b1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
