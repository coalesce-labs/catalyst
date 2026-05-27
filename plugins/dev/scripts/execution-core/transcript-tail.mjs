// transcript-tail.mjs — CTL-650 Phase 2. Per-session transcript state tracker.
//
// Maintains, per Claude session, exactly the fields classifyWaitState() needs —
// derived by INCREMENTALLY tailing the session's transcript JSONL with the
// CTL-673 scanEventsChunked primitive (byte cursor + leftover, O(new bytes) per
// poll, never re-reading the whole file). Tracks the last assistant turn's
// stop_reason / last content-block type / last tool / last text, plus the count
// of user|tool_result entries seen since that assistant turn. Resets the cursor
// on truncation/rotation, mirroring the daemon's live tailer (daemon.mjs:300-305).

import { openSync, fstatSync, closeSync } from "node:fs";
import { scanEventsChunked } from "./event-tail.mjs";

/**
 * freshState — the zeroed tracker state. Exposed so applyEntry can be unit-tested
 * directly without constructing a tracker.
 */
export function freshState() {
  return {
    stopReason: null,
    lastBlockType: null,
    lastTool: null,
    lastText: null,
    postUserOrResultCount: 0,
  };
}

// hasToolResultBlock — true when a transcript entry carries a tool_result content
// block. Claude transcripts deliver tool results inside a type:"user" message, so
// the prototype counted any line matching `"type":"user"` OR `"tool_result"`; we
// reproduce that by treating either signal as one post-assistant entry.
function hasToolResultBlock(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content)) {
    return content.some((b) => b?.type === "tool_result");
  }
  return false;
}

/**
 * applyEntry — pure reducer folding one transcript entry into the tracker state.
 * `assistant` entries set the last-turn fields and reset the post-assistant
 * counter; `user`/`tool_result` entries increment it. Mutates and returns state.
 */
export function applyEntry(state, entry) {
  if (entry?.type === "assistant") {
    const content = entry.message?.content;
    const last = Array.isArray(content) && content.length ? content[content.length - 1] : undefined;
    state.stopReason = entry.message?.stop_reason ?? null;
    state.lastBlockType = last?.type ?? null;
    state.lastTool = last?.name ?? null;
    state.lastText = last?.text ?? null;
    state.postUserOrResultCount = 0;
  } else if (entry?.type === "user" || entry?.type === "tool_result" || hasToolResultBlock(entry)) {
    state.postUserOrResultCount += 1;
  }
  return state;
}

// statSizeOrNull — current byte size of the file, or null when it cannot be
// stat'd (missing/transient). Used only to detect truncation/rotation.
function statSizeOrNull(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    return size;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
  }
}

/**
 * createTranscriptTracker — a stateful per-session tracker over a transcript path.
 * `poll()` reads only the bytes appended since the last poll and folds them into
 * the state; `snapshot()` returns the classifyWaitState() input object.
 *
 * `scan` and `statSize` are injectable seams (default to the real primitives) so
 * the reducer can be driven without real I/O in tests.
 *
 * @param {object} opts
 * @param {string} opts.path                 transcript JSONL path
 * @param {Function} [opts.scan=scanEventsChunked]
 * @param {Function} [opts.statSize=statSizeOrNull]
 */
export function createTranscriptTracker({ path, scan = scanEventsChunked, statSize = statSizeOrNull } = {}) {
  const state = freshState();
  let cursor = 0;
  let leftover = "";

  function poll() {
    // Truncation/rotation: a file shorter than our cursor was replaced — restart
    // from 0 and drop the partial line stitched from the now-vanished bytes
    // (mirror daemon.mjs:300-305).
    const size = statSize(path);
    if (size != null && size < cursor) {
      cursor = 0;
      leftover = "";
    }
    const { endOffset, leftover: nextLeftover } = scan({
      path,
      fromOffset: cursor,
      leftover,
      onEvent: (entry) => applyEntry(state, entry),
    });
    cursor = endOffset;
    leftover = nextLeftover;
  }

  function snapshot() {
    // hasTranscript is always true here: a tracker only exists because the
    // watcher resolved a transcript path. The "no transcript" case is handled
    // upstream by not constructing a tracker at all.
    return {
      hasTranscript: true,
      lastBlockType: state.lastBlockType,
      lastTool: state.lastTool,
      stopReason: state.stopReason,
      lastText: state.lastText,
      postUserOrResultCount: state.postUserOrResultCount,
    };
  }

  return { poll, snapshot };
}
