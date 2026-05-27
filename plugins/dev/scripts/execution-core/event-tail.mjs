// event-tail.mjs — byte-correct event-log tail parsing (CTL-673). Leaf module:
// no execution-core deps. Shared by daemon.mjs (live tail), event-scan.mjs
// (incremental counters), and reaper.mjs (boot replay).
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

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
    // A single reusable buffer for the common full-chunk reads; short final
    // reads get a right-sized buffer so toString never sees stale tail bytes.
    const buf = Buffer.alloc(Math.min(chunkSize, Math.max(1, size - pos)) || 1);
    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const slice = want === buf.length ? buf : Buffer.alloc(want);
      readSync(fd, slice, 0, want, pos);
      const { events, leftover: next } = parseEventTailChunk(slice.toString("utf8"), carry);
      for (const ev of events) onEvent(ev);
      carry = next;
      pos += want;
    }
    return { endOffset: size, leftover: carry };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already gone */
    }
  }
}
