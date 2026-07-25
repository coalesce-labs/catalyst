// event-tail.mjs — byte-correct event-log tail parsing (CTL-673). Leaf module:
// no execution-core deps. Shared by daemon.mjs (live tail), event-scan.mjs
// (incremental counters), and reaper.mjs (boot replay).
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_CHUNK = 1 << 20; // 1 MiB — bounds peak memory regardless of file size.

// parseEventTailChunk — (moved from daemon.mjs, unchanged). Stitches `leftover`
// (the partial line carried from the previous read) onto the front of `chunk`,
// returns parsed events for the COMPLETE lines and the new trailing partial
// line. Malformed/blank complete lines are skipped — their bytes are already
// behind the byte cursor and will never be revisited.
//
// `chunk` is the utf8-decoded NEW bytes only. Decoding only the new bytes (vs.
// JS-string-slicing the whole file) is what makes this byte-correct: a
// multi-byte char upstream of the cursor can no longer shift code-unit indexes.
export function parseEventTailChunk(chunk, leftover = "") {
  const text = leftover + chunk;
  const lines = text.split("\n");
  // The final element is the trailing partial line (empty if the chunk ended
  // exactly on a newline) — hold it back until the next read completes it.
  const newLeftover = lines.pop() ?? "";
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue; // skip a malformed complete line, keep tailing
    }
  }
  return { events, leftover: newLeftover };
}

// scanEventsChunked — read [fromOffset, EOF) in bounded chunks via a file
// descriptor, parse each complete line, and invoke onEvent(event) for it.
// Returns { endOffset, leftover } so a caller can resume from endOffset on the
// next call. Missing file / stat error → no-op returning
// { endOffset: fromOffset, leftover }. Reads only NEW bytes — never
// re-materializes the whole file.
export function scanEventsChunked({
  path,
  fromOffset = 0,
  leftover = "",
  chunkSize = DEFAULT_CHUNK,
  onEvent,
  // CTL-1514: when starting mid-file (fromOffset > 0) the bytes before the first
  // newline are the tail of some earlier line; its suffix can independently parse
  // as valid JSON and pollute the result. Set true to discard everything up to
  // and including the first newline so scanning always begins on a line boundary.
  skipFirstLine = false,
} = {}) {
  let fd;
  let size;
  try {
    fd = openSync(path, "r");
    size = fstatSync(fd).size;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
    return { endOffset: fromOffset, leftover };
  }
  try {
    let pos = fromOffset;
    let carry = leftover;
    let skipping = skipFirstLine && fromOffset > 0;
    // CTL-1514: decode bytes through a StringDecoder so a multibyte UTF-8 sequence
    // split across a chunk boundary is stitched (its trailing bytes are buffered
    // until the next read) instead of each fragment decoding to U+FFFD — which
    // would silently corrupt an event field while the JSON still parsed.
    const decoder = new StringDecoder("utf8");
    // A single reusable buffer for the common full-chunk reads; short final reads
    // get a right-sized buffer so the decoder never sees stale tail bytes.
    const buf = Buffer.alloc(Math.min(chunkSize, Math.max(1, size - pos)) || 1);
    const feed = (chunkStr) => {
      if (skipping) {
        const nl = chunkStr.indexOf("\n");
        if (nl === -1) return; // still inside the leading partial line — discard it
        chunkStr = chunkStr.slice(nl + 1); // resume after the first line boundary
        skipping = false;
      }
      const { events, leftover: next } = parseEventTailChunk(chunkStr, carry);
      for (const ev of events) onEvent(ev);
      carry = next;
    };
    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const slice = want === buf.length ? buf : Buffer.alloc(want);
      readSync(fd, slice, 0, want, pos);
      feed(decoder.write(slice));
      pos += want;
    }
    const flushed = decoder.end();
    if (flushed) feed(flushed);
    return { endOffset: size, leftover: carry };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already gone */
    }
  }
}

// tailParsedEvents — return the last `maxLines` parsed JSON events from `path`,
// in file order, WITHOUT reading the whole file when the tail fits in a small
// window near EOF (CTL-1514). scanEventsChunked reads forward from an offset, so
// this seeds an estimated start offset near EOF and scans forward to EOF; if
// fewer than `maxLines` valid events came back AND there is more file before the
// window, it doubles the window and rescans from scratch (never accumulates
// across attempts — a larger window can reveal one more real line that a smaller
// window's leading fragment cut off). Bounded to `maxDoublings` retries, after
// which it forces fromOffset:0 (a full scan) so correctness never depends on the
// estimate: a file with fewer than maxLines lines, or one containing a
// pathologically long line, still returns the true last-N tail. Missing/empty
// file ⇒ []; never throws.
export function tailParsedEvents({
  path,
  maxLines = 800,
  bytesPerLineEstimate = 2048,
  maxDoublings = 8,
} = {}) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size === 0) return [];

  let window = Math.max(bytesPerLineEstimate * maxLines, 64 * 1024);
  for (let attempt = 0; attempt <= maxDoublings; attempt++) {
    const fromOffset = attempt === maxDoublings ? 0 : Math.max(0, size - window);
    const collected = [];
    // skipFirstLine when seeking mid-file: the bytes before the first newline are
    // a partial line whose suffix could parse as a bogus event (CTL-1514).
    scanEventsChunked({ path, fromOffset, skipFirstLine: fromOffset > 0, onEvent: (e) => collected.push(e) });
    if (collected.length >= maxLines || fromOffset === 0) {
      return collected.slice(-maxLines);
    }
    window *= 2;
  }
  return []; // unreachable — the final attempt always uses fromOffset 0
}
