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
import { writeFileSync, appendFileSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseEventTailChunk,
  scanEventsChunked,
  tailParsedEvents,
  tornLineCount,
  resetTornLineCount,
} from "./event-tail.mjs";

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

  test("stitches a multibyte UTF-8 char split across a chunk boundary (CTL-1514, no U+FFFD)", () => {
    const path = tempLog(['{"e":"a🚀b"}']); // 🚀 = 4 bytes → straddles a 4-byte chunk boundary
    const seen = [];
    scanEventsChunked({ path, fromOffset: 0, chunkSize: 4, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ e: "a🚀b" }]); // char preserved byte-exact, not corrupted to �
  });

  test("skipFirstLine discards a leading partial line whose suffix is valid JSON (CTL-1514)", () => {
    // Full line 'XX{"n":7}' is invalid JSON, but its suffix '{"n":7}' parses. A
    // mid-line fromOffset must not surface that fragment as a bogus event.
    const path = tempLog(['XX{"n":7}', '{"n":2}']);
    const noSkip = [];
    scanEventsChunked({ path, fromOffset: 2, onEvent: (e) => noSkip.push(e) }); // byte 2 = '{'
    expect(noSkip).toEqual([{ n: 7 }, { n: 2 }]); // the fragment leaks through by default
    const skip = [];
    scanEventsChunked({ path, fromOffset: 2, skipFirstLine: true, onEvent: (e) => skip.push(e) });
    expect(skip).toEqual([{ n: 2 }]); // fragment discarded — only the complete line remains
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

describe("tailParsedEvents (CTL-1514)", () => {
  function tempLog(lines, { trailingNewline = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "evttail-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
    return path;
  }
  // trueTail — the correct semantics: parse EVERY valid line, then take the last
  // maxLines. tailParsedEvents must equal this exactly. (Note: the OLD
  // readBoardHealthEventTail did slice(-maxLines) on RAW lines first, so on a
  // newline-terminated log it lost one slot to the trailing "" — returning 799
  // for maxLines=800. tailParsedEvents intentionally returns the true last-N
  // valid events instead: same upper bound, never fewer. See plan §5.5.)
  function trueTail(path, maxLines) {
    const all = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        all.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return all.slice(-maxLines);
  }

  test("small file: returns the last N parsed events in order", () => {
    const path = tempLog(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}']);
    expect(tailParsedEvents({ path, maxLines: 3 })).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
  });

  test("large file: identical to the true parsed tail, exactly maxLines", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ n: i }));
    const path = tempLog(lines);
    const got = tailParsedEvents({ path, maxLines: 800 });
    expect(got).toEqual(trueTail(path, 800));
    expect(got).toHaveLength(800);
    expect(got[0]).toEqual({ n: 4200 });
    expect(got[799]).toEqual({ n: 4999 });
  });

  test("window-growth path converges to the correct tail (tiny estimate forces doublings)", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ n: i }));
    const path = tempLog(lines);
    // bytesPerLineEstimate=1 → the first window is far smaller than needed, so
    // the retry-doubling path (not the fast path) is exercised; result must still
    // be exactly the true tail.
    const got = tailParsedEvents({ path, maxLines: 800, bytesPerLineEstimate: 1 });
    expect(got).toEqual(trueTail(path, 800));
    expect(got).toHaveLength(800);
  });

  test("fewer total lines than maxLines: returns all of them", () => {
    const path = tempLog(['{"n":1}', '{"n":2}']);
    expect(tailParsedEvents({ path, maxLines: 800 })).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("includes a valid final record that lacks a trailing newline (CTL-1514, Codex P2)", () => {
    const path = tempLog(['{"n":1}', '{"n":2}'], { trailingNewline: false });
    // {"n":2} is the leftover (no trailing \n); it must still be returned.
    expect(tailParsedEvents({ path, maxLines: 2 })).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("malformed/blank lines in the tail are skipped and don't consume the maxLines budget", () => {
    const path = tempLog(['{"n":1}', "not-json", "", '{"n":2}', '{"n":3}']);
    expect(tailParsedEvents({ path, maxLines: 2 })).toEqual([{ n: 2 }, { n: 3 }]);
  });

  test("empty (0-byte) file → []", () => {
    const path = tempLog([], { trailingNewline: false });
    expect(tailParsedEvents({ path, maxLines: 800 })).toEqual([]);
  });

  test("missing file → [] (never throws)", () => {
    expect(tailParsedEvents({ path: join(tmpdir(), "nope-xyz-1514.jsonl"), maxLines: 800 })).toEqual([]);
  });

  test("a single line longer than the 1MiB internal chunk is returned intact", () => {
    const big = JSON.stringify({ big: "x".repeat(2 * 1024 * 1024) });
    const path = tempLog([big]);
    const got = tailParsedEvents({ path, maxLines: 1 });
    expect(got).toHaveLength(1);
    expect(got[0].big.length).toBe(2 * 1024 * 1024);
  });
});

// ─── CTL-1809: the torn-line drop must be counted, not silent ────────────────
//
// parseEventTailChunk's `catch { continue }` drops an unparseable COMPLETE line. That drop
// is correct — a torn line is permanently corrupt, and parking the byte cursor on it would
// wedge the daemon tail, the reaper's boot replay and every scan CLI on damage that will
// never resolve. But it used to be INVISIBLE, so a damaged event log and a quiet one read
// identically from every reader built on this module.
describe("torn-line counter (CTL-1809)", () => {
  test("counts each unparseable complete line and still advances past it", () => {
    resetTornLineCount();
    const { events } = parseEventTailChunk(
      '{"event":"a"}\nTORN{"attributes":{"event.na\n{"event":"b"}\n',
      ""
    );
    // ADVANCES: the valid event AFTER the torn line is still returned. This is the half that
    // separates count-and-advance from park-the-cursor — a reader that stalled on the torn
    // line would never reach {"event":"b"}.
    expect(events).toEqual([{ event: "a" }, { event: "b" }]);
    expect(tornLineCount()).toBe(1);
  });

  test("a clean chunk leaves the counter untouched (with a positive control)", () => {
    resetTornLineCount();
    parseEventTailChunk('{"event":"a"}\n{"event":"b"}\n', "");
    expect(tornLineCount()).toBe(0);
    // POSITIVE CONTROL: same instrument, same call, one torn line added. Without it, a
    // counter wired to nothing at all would also report 0 above and look correct.
    parseEventTailChunk("TORN\n", "");
    expect(tornLineCount()).toBe(1);
  });

  test("the trailing PARTIAL line is not counted — only complete lines are", () => {
    resetTornLineCount();
    // No trailing newline: `{"event":"b` is a write in flight, not corruption. Counting it
    // would make the detector alarm continuously against any actively-written log.
    const { events, leftover } = parseEventTailChunk('{"event":"a"}\n{"event":"b', "");
    expect(events).toEqual([{ event: "a" }]);
    expect(leftover).toBe('{"event":"b');
    expect(tornLineCount()).toBe(0);
  });

  test("counts through scanEventsChunked — the path the daemon and reaper actually use", () => {
    resetTornLineCount();
    const path = join(mkdtempSync(join(tmpdir(), "ctl1809-")), "e.jsonl");
    writeFileSync(path, '{"event":"a"}\nTORN{"att\n{"event":"b"}\n');
    const seen = [];
    scanEventsChunked({ path, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ event: "a" }, { event: "b" }]);
    expect(tornLineCount()).toBe(1);
  });
});
