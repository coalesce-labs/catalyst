// event-cursor.mjs — durable event-log tailer cursor (CTL-539).
//
// monitor.mjs's byte-offset tailer persists {logPath, byteOffset} here on every
// drain; on startup it resumes from the saved offset instead of re-seeding at
// EOF, so events that arrived while the daemon was down reach the fast path
// promptly. The cursor is a latency optimization only — every resolveStartOffset
// failure mode falls back to EOF, and the periodic reconcile is the correctness
// backstop regardless. Leaf module: depends only on config.mjs.

import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { getCursorPath, log } from "./config.mjs";

// loadCursor — read the persisted cursor, or null when absent/corrupt/invalid.
export function loadCursor() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(getCursorPath(), "utf8"));
  } catch {
    return null; // no cursor file yet, or unreadable/malformed — caller seeds EOF
  }
  if (typeof raw?.logPath !== "string" || !Number.isInteger(raw?.byteOffset)) {
    log.warn({ raw }, "event-cursor: malformed cursor — ignoring");
    return null;
  }
  return { logPath: raw.logPath, byteOffset: raw.byteOffset };
}

// saveCursor — atomic tmp+rename write. Best-effort: a write failure is logged
// but never thrown — the tailer must not crash because a cursor write failed.
export function saveCursor({ logPath, byteOffset }) {
  const file = getCursorPath();
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ logPath, byteOffset }));
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    log.warn(
      { err: err.message },
      "event-cursor: cursor write failed — fast path will re-seed at EOF next restart",
    );
  }
}

// resolveStartOffset — PURE. Decide the tailer's startup byte offset. Resume
// from the saved cursor only when it is for the current log file and its offset
// is in-range [0, fileSize]; otherwise seed at EOF (skip history). EOF is always
// a correct fallback because the periodic reconcile poll catches missed events.
export function resolveStartOffset({ cursor, logPath, fileSize }) {
  if (
    cursor &&
    cursor.logPath === logPath &&
    Number.isInteger(cursor.byteOffset) &&
    cursor.byteOffset >= 0 &&
    cursor.byteOffset <= fileSize
  ) {
    return cursor.byteOffset;
  }
  return fileSize;
}
