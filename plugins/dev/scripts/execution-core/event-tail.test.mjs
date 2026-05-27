// event-tail.test.mjs — CTL-673 byte-correct tail parsing primitives.
//
//   parseEventTailChunk(chunk, leftover) → { events, leftover }
//   scanEventsChunked({ path, fromOffset, leftover, chunkSize, onEvent }) → { endOffset, leftover }
//
// parseEventTailChunk is moved verbatim from daemon.mjs (its contract is also
// guarded by daemon.test.mjs via the re-export). scanEventsChunked reads only
// the byte range [fromOffset, EOF) in bounded chunks so a resume never
// re-materializes already-scanned bytes.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-tail.test.mjs

import { describe, test, expect } from "bun:test";
import { writeFileSync, appendFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEventTailChunk, scanEventsChunked } from "./event-tail.mjs";

// parseEventTailChunk — preserve the daemon.mjs contract verbatim.
describe("parseEventTailChunk", () => {
  test("stitches leftover and holds back the trailing partial line", () => {
    const first = parseEventTailChunk('{"event":"a"}\n{"event":"b', "");
    expect(first.events).toEqual([{ event: "a" }]);
    expect(first.leftover).toBe('{"event":"b');
    const second = parseEventTailChunk('"}\n', first.leftover);
    expect(second.events).toEqual([{ event: "b" }]);
    expect(second.leftover).toBe("");
  });
  test("skips malformed complete lines but keeps the rest", () => {
    expect(parseEventTailChunk('not json\n{"event":"ok"}\n', "").events).toEqual([{ event: "ok" }]);
  });
  test("skips blank lines", () => {
    expect(parseEventTailChunk('\n\n{"event":"x"}\n', "").events).toEqual([{ event: "x" }]);
  });
});

// scanEventsChunked — read [fromOffset, EOF) in bounded chunks, emit parsed events.
describe("scanEventsChunked", () => {
  function tempLog(lines) {
    const dir = mkdtempSync(join(tmpdir(), "evttail-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  test("emits every complete event from offset 0", () => {
    const path = tempLog(['{"n":1}', '{"n":2}', '{"n":3}']);
    const seen = [];
    const { endOffset, leftover } = scanEventsChunked({ path, fromOffset: 0, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(endOffset).toBe(statSync(path).size);
    expect(leftover).toBe("");
  });

  test("resuming from a prior endOffset emits ONLY appended events", () => {
    const path = tempLog(['{"n":1}', '{"n":2}']);
    const first = scanEventsChunked({ path, fromOffset: 0, onEvent: () => {} });
    appendFileSync(path, '{"n":3}\n');
    const seen = [];
    scanEventsChunked({ path, fromOffset: first.endOffset, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ n: 3 }]); // never re-emits 1,2
  });

  test("stitches a line split across two chunks (tiny chunkSize)", () => {
    const path = tempLog(['{"event":"alpha"}']);
    const seen = [];
    scanEventsChunked({ path, fromOffset: 0, chunkSize: 4, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ event: "alpha" }]); // counted exactly once across chunk boundaries
  });

  test("carries a trailing partial line across an append (leftover threaded back in)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evttail-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"event":"par'); // half-written line, no newline
    const first = scanEventsChunked({ path, fromOffset: 0, onEvent: () => {} });
    expect(first.leftover).toBe('{"event":"par');
    appendFileSync(path, 'tial"}\n');
    const seen = [];
    scanEventsChunked({ path, fromOffset: first.endOffset, leftover: first.leftover, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ event: "partial" }]);
  });

  test("missing file is a no-op (endOffset 0)", () => {
    const r = scanEventsChunked({ path: join(tmpdir(), "does-not-exist-xyz.jsonl"), fromOffset: 0, onEvent: () => {} });
    expect(r.endOffset).toBe(0);
  });
});
