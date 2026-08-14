// event-tail.mjs — byte-correct event-log tail parsing (CTL-673). Leaf module:
// no execution-core deps. Shared by daemon.mjs (live tail), event-scan.mjs
// (incremental counters), and reaper.mjs (boot replay).
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_CHUNK = 1 << 20; // 1 MiB — bounds peak memory regardless of file size.

// ─── CTL-1809: torn-line counter ─────────────────────────────────────────────
//
// parseEventTailChunk's `catch { continue; }` below is a DROP, and until now it was a
// completely silent one: this module backs the daemon's live tail, event-scan's incremental
// counters, the reaper's boot replay, reaper-metrics and transcript-tail, and not one of
// them could distinguish a damaged event log from a quiet one.
//
// COUNT AND ADVANCE, deliberately. A torn line is permanently corrupt — parking the byte
// cursor on it would wedge every reader above on damage that will never resolve. The
// module's own contract at the top of parseEventTailChunk already states the invariant
// ("their bytes are already behind the byte cursor and will never be revisited"); this only
// makes the drop audible.
//
// The count is a LOWER BOUND on corruption, never proof of cleanliness: the CTL-1809 RCA
// reproduced a splice that parses as valid JSON with a matching declared length and three
// different events inside it, which no parser can detect. The write side
// (lib/canonical-event.sh's one-write(2) primitive) is the fix; this is the tripwire.
//
// Module-level rather than a parameter: parseEventTailChunk is positional and called from
// five readers, and a per-call callback would have to be threaded through all of them to
// report anything. Zero-dependency by design — this is a leaf module, so the warning goes
// straight to stderr (which lands in the caller's launchd-captured `.log`, Alloy-shipped to
// Loki INDEPENDENTLY of the event log whose damage it reports).
let tornLineTotal = 0;
const tornWarned = new Set();

/** Process-total torn (unparseable) complete lines seen by parseEventTailChunk. */
export function tornLineCount() {
  return tornLineTotal;
}

/** Test seam — resets the process counter and the sparse-warn key set. */
export function resetTornLineCount() {
  tornLineTotal = 0;
  tornWarned.clear();
}

// Count every occurrence, log sparsely — the same discipline as
// otel-forward/lib/sparse-warn.ts, hand-rolled here because this module must stay
// dependency-free (it is imported by the daemon, the reaper and standalone scan CLIs).
// First sighting per distinct 60-byte prefix, capped at 20 keys, then 10/100/1000…
// heartbeats on the running total so a sustained tear still reports a live, accurate count
// without flooding the log surface it is reporting on.
//
// EXPORTED because a process can hold more than one reader of the SAME log and must not
// hold more than one count of it. The broker is exactly that case: its BOOT replay comes
// through tailParsedEvents (counted here), while its LIVE tail — the path that carries
// essentially every routed event — hand-rolls its own read loop in broker/tailer.mjs and
// calls this directly. Sharing the counter and the sparse-warn key budget is correct there:
// the two paths are one detector reading one file, so a torn line seen at boot and the same
// prefix seen live should not each spend a key. The "one flood must not exhaust another
// detector's budget" rule applies ACROSS readers (separate processes / separate files), not
// within one process's view of one log.
export function noteTornLine(line) {
  tornLineTotal += 1;
  const key = line.slice(0, 60);
  let warn = false;
  if (!tornWarned.has(key) && tornWarned.size < 20) {
    tornWarned.add(key);
    warn = true;
  } else if (tornLineTotal >= 10 && Math.log10(tornLineTotal) % 1 === 0) {
    warn = true;
  }
  if (!warn) return;
  try {
    process.stderr.write(
      `[catalyst] WARNING: TORN event-log line — did not parse as JSON; counted and skipped ` +
        `(torn_lines_total=${tornLineTotal}, bytes=${line.length}): ${key}\n`
    );
  } catch {
    /* a reporting hook must never break the tail */
  }
}

// parseEventTailChunk — (moved from daemon.mjs, unchanged). Stitches `leftover`
// (the partial line carried from the previous read) onto the front of `chunk`,
// returns parsed events for the COMPLETE lines and the new trailing partial
// line. Malformed/blank complete lines are skipped — their bytes are already
// behind the byte cursor and will never be revisited.
//
// `chunk` is the utf8-decoded NEW bytes only. Decoding only the new bytes (vs.
// JS-string-slicing the whole file) is what makes this byte-correct: a
// multi-byte char upstream of the cursor can no longer shift code-unit indexes.
// CTL-1529: `lineFilter` is an OPTIONAL cheap pre-JSON.parse gate — the
// `line.includes("node.heartbeat")` idiom the whole-file heartbeat readers used
// before they were bounded. Preserving it keeps a bounded scan from paying a
// full JSON.parse for every unrelated line in the window. Default null = parse
// every complete line (the pre-CTL-1529 behavior).
export function parseEventTailChunk(chunk, leftover = "", lineFilter = null) {
  const text = leftover + chunk;
  const lines = text.split("\n");
  // The final element is the trailing partial line (empty if the chunk ended
  // exactly on a newline) — hold it back until the next read completes it.
  const newLeftover = lines.pop() ?? "";
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    if (lineFilter && !lineFilter(line)) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // CTL-1809: count and warn before skipping. This is a COMPLETE line (the trailing
      // partial was popped off above), so an unparseable one here is real damage, not a
      // read that raced a writer.
      noteTornLine(line);
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
  // CTL-1529: optional cheap pre-parse line gate (see parseEventTailChunk).
  lineFilter = null,
  // CTL-1529: optional instrumentation fired once per readSync with
  // { bytes, offset }. Exists so a test can PROVE the peak transient is one
  // chunk regardless of file size (the property this whole module exists for).
  // Default null = zero cost.
  onRead = null,
  // CTL-1529 (Codex P2): ONE-SHOT scans must not silently drop a final complete
  // record that lacks a trailing newline. The chunked reader deliberately holds
  // that text back in `leftover` because an INCREMENTAL reader (event-scan.mjs,
  // reaper-metrics.mjs, transcript-tail.mjs) will complete it on the next pass
  // from `endOffset`. A scan that runs ONCE to EOF has no next pass, so for it the
  // held-back text is not a partial line — it is the newest event, and precisely
  // the one a crash-truncated log is missing. The `readFileSync(...).split("\n")`
  // readers this module replaced parsed it, and tailParsedEvents preserves it, so
  // dropping it is a regression against both.
  //
  // Set TRUE only for a scan that reads to EOF exactly once. `leftover` is still
  // returned verbatim (an emit does not consume it) so the flag can never corrupt
  // a byte cursor if someone sets it on a resuming reader by mistake.
  emitTrailingLine = false,
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
      const { events, leftover: next } = parseEventTailChunk(chunkStr, carry, lineFilter);
      for (const ev of events) onEvent(ev);
      carry = next;
    };
    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const slice = want === buf.length ? buf : Buffer.alloc(want);
      readSync(fd, slice, 0, want, pos);
      if (onRead) onRead({ bytes: want, offset: pos });
      feed(decoder.write(slice));
      pos += want;
    }
    const flushed = decoder.end();
    if (flushed) feed(flushed);
    // CTL-1529 (Codex P2): the final complete-but-unterminated record. Same gates a
    // complete line gets (skip-mode, lineFilter, parse-or-skip) so a genuinely
    // partial mid-write line is still dropped rather than half-parsed.
    if (emitTrailingLine && !skipping && carry && (!lineFilter || lineFilter(carry))) {
      try {
        onEvent(JSON.parse(carry));
      } catch {
        /* genuinely partial mid-write line — skip, same as the old split path */
        // CTL-1809 deliberately does NOT count this one. `carry` is the text after the last
        // newline, i.e. a line a writer may be in the middle of appending right now. Feeding
        // it to the torn counter would report a healthy in-flight write as log corruption on
        // every scan of an actively-written log — a detector that alarms constantly is one
        // nobody reads. Only COMPLETE lines (the loop in parseEventTailChunk) are counted.
      }
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

// ─── CTL-1529: the TIME-covering bounded tail ────────────────────────────────
//
// DEFAULT_TAIL_MAX_BYTES — the hard ceiling on how far back scanEventsSince will
// walk before giving up on covering its window.
//
// DERIVATION. The busiest host in the fleet (mini) writes ~883 MB/month to the
// monthly event log ≈ 34 MB/day ≈ 1.4 MB/hour ≈ 236 KB per 10-minute
// HEARTBEAT_GRACE_MS window. 64 MiB is therefore ~45 days of that host's
// *average* traffic and ~270x the bytes a single grace window needs — headroom
// sized for a pathological BURST (the CTL-671 phantom ticket emitted ~24,560
// `phase.*` events in 3 days), not for the average. It is deliberately NOT sized
// to "whatever the log happens to be": the point of the cap is that the read cost
// stops growing with the file. Peak RESIDENT memory is one `chunkSize` buffer
// regardless of this value — the cap bounds WORK (bytes read), not memory.
export const DEFAULT_TAIL_MAX_BYTES = 64 * 1024 * 1024;

// Sentinel used to abort scanEventsChunked from inside onEvent once the probe has
// what it needs. scanEventsChunked closes its fd in a `finally`, so throwing out
// of onEvent is leak-free.
const PROBE_DONE = Symbol("probe-done");

// probeOldestTs — the ts of the FIRST complete event at or after `fromOffset`.
// `skipFirstLine` (for fromOffset > 0) guarantees that first event is a whole,
// untruncated line, so a cut line's independently-parseable suffix can never be
// mistaken for the window's oldest record. Returns null when the window holds no
// parseable event (⇒ the caller keeps expanding). Bounded: reuses the audited
// forward primitive and stops at the first hit.
// NOTE (CTL-1529, Codex P1 — deferred to CTL-1550, deliberately NOT fixed here):
// this returns the FIRST record after the offset and treats its ts as the window's
// oldest. That is exact only if the log is monotonic by `ts`, which it is not
// guaranteed to be — a backfilled record near EOF can overstate how far back the
// window reaches. The naive hardening (sample the first K records and require the
// NEWEST of them to predate the target) was implemented and REJECTED: in a normally
// ordered log those first K records run FORWARD in time, so their newest sits far
// later than the window's true start, coverage is denied, and the walk expands to
// the cap — which destroys the bounded-read property this whole module exists for.
// A sound fix needs an outlier-resistant statistic (median/k-th smallest) with a
// re-tuned perf budget. See CTL-1550.
function probeOldestTs({ path, fromOffset, chunkSize, onRead, tsOf }) {
  let found = null;
  try {
    scanEventsChunked({
      path,
      fromOffset,
      chunkSize,
      skipFirstLine: fromOffset > 0,
      onRead,
      // CTL-1529 (Codex P2): the probe reads to EOF once, so it must see the same
      // record set the forward scan below will. Otherwise a window whose ONLY
      // parseable record is the unterminated final line probes as empty and the
      // walk keeps doubling toward BOF for no reason.
      emitTrailingLine: true,
      onEvent: (e) => {
        const t = tsOf(e);
        if (typeof t === "string" && t.length > 0) {
          found = t;
          throw PROBE_DONE;
        }
      },
    });
  } catch (err) {
    if (err !== PROBE_DONE) throw err;
  }
  return found;
}

// scanEventsSince — read the tail of `path` bounded by WALL-CLOCK TIME rather
// than by a fixed byte budget, and report whether the window is provably deep
// enough to be trusted.
//
// WHY THIS EXISTS (CTL-1529). A fixed N-megabyte tail carries NO time guarantee:
// on a busy day 1 MB of this log spans ~14 minutes, on a quiet one ~36 minutes.
// Any consumer that reads "absent from the data" as evidence about the passage of
// time (liveness!) is silently wrong with a byte budget and exactly right with a
// time budget. So: walk a window backwards from EOF, doubling it, until the
// OLDEST record inside it predates `targetSinceMs` — then scan that window
// forward with the audited chunked reader.
//
// TWO thresholds, deliberately separate:
//   • `targetSinceMs`   — how far back we TRY to reach (the generous window).
//   • `requiredSinceMs` — how far back we MUST reach for the result to be
//     trustworthy (the guarantee). Defaults to targetSinceMs.
// The split matters when `maxBytes` truncates the walk somewhere between the two:
// the caller still gets a proven guarantee (`covered:true`) without having paid
// for the full target window.
//
// COVERAGE RULE — `covered` is true when EITHER
//   (a) the window's oldest record is at or before `requiredSinceMs`, OR
//   (b) the walk reached byte 0 (`reachedBof`) — the window IS the whole file, so
//       the result is byte-identical to the whole-file read it replaces.
// Clause (b) is load-bearing: `getEventLogPath()` is CURRENT-MONTH-only, so on
// the 1st of each UTC month the log holds only minutes of data. Without (b) every
// host would report "uncovered" for the first ~10 minutes of every month and lose
// both the dead-host failover and the dispatch shed.
//
// Cap exhaustion (offset > 0 and still short of `requiredSinceMs`) is the ONLY
// state that yields `covered:false`. It is REPORTED, never swallowed — the caller
// decides how to fail, and must fail conservatively.
//
// Peak transient memory is ONE `chunkSize` buffer, independent of file size.
// Missing/unreadable/empty file ⇒ { covered:true, reachedBof:true } and no events
// (there is nothing a whole-file read would have seen either).
export function scanEventsSince({
  path,
  targetSinceMs,
  requiredSinceMs = targetSinceMs,
  chunkSize = DEFAULT_CHUNK,
  initialWindow = chunkSize,
  maxBytes = DEFAULT_TAIL_MAX_BYTES,
  onEvent = () => {},
  lineFilter = null,
  onRead = null,
  tsOf = (e) => e?.ts,
} = {}) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { covered: true, reachedBof: true, fromOffset: 0, size: 0, windowBytes: 0, oldestTs: null };
  }
  if (size === 0) {
    return { covered: true, reachedBof: true, fromOffset: 0, size: 0, windowBytes: 0, oldestTs: null };
  }

  const cap = Math.max(1, Math.min(maxBytes, Number.MAX_SAFE_INTEGER));
  let window = Math.max(1, Math.min(initialWindow, cap));
  let fromOffset = 0;
  let oldestTs = null;
  let covered = false;
  let reachedBof = false;

  for (;;) {
    fromOffset = Math.max(0, size - window);
    reachedBof = fromOffset === 0;
    oldestTs = probeOldestTs({ path, fromOffset, chunkSize, onRead, tsOf });
    if (reachedBof) {
      // The window IS the whole file — identical to the whole-file read.
      covered = true;
      break;
    }
    const oldestMs = oldestTs === null ? NaN : Date.parse(oldestTs);
    if (Number.isFinite(oldestMs) && oldestMs <= targetSinceMs) {
      covered = true;
      break;
    }
    if (window >= cap) {
      // Cap exhausted. Still report the weaker guarantee honestly: if the window
      // we DID cover already reaches past requiredSinceMs, it is trustworthy.
      covered = Number.isFinite(oldestMs) && oldestMs <= requiredSinceMs;
      break;
    }
    window = Math.min(window * 2, cap);
  }

  scanEventsChunked({
    path,
    fromOffset,
    chunkSize,
    skipFirstLine: fromOffset > 0,
    lineFilter,
    onRead,
    // CTL-1529 (Codex P2): scanEventsSince is BY CONSTRUCTION a one-shot read to
    // EOF — it has no cursor and no next pass — so a final record without a
    // trailing newline is a real event, not a partial line. Every consumer of this
    // primitive (doctor's bg-fallback gate, the heartbeat tail, the governance
    // readers, the recovery escalation sweep) inherits the fix here, at the one
    // place that can guarantee it.
    emitTrailingLine: true,
    onEvent,
  });

  return { covered, reachedBof, fromOffset, size, windowBytes: size - fromOffset, oldestTs };
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
    //
    // emitTrailingLine: a log whose final record lacks a trailing newline leaves
    // that record in `leftover` (never emitted as a complete line). Include it if
    // it parses — the replaced raw.split("\n") parsed it, and board-health/recovery
    // dedup must not miss the newest event in a truncated / crash-recovered log
    // (Codex P2). It arrives last, i.e. in file order, so the `.slice(-maxLines)`
    // below still returns the true tail.
    scanEventsChunked({
      path,
      fromOffset,
      skipFirstLine: fromOffset > 0,
      emitTrailingLine: true,
      onEvent: (e) => collected.push(e),
    });
    if (collected.length >= maxLines || fromOffset === 0) {
      return collected.slice(-maxLines);
    }
    window *= 2;
  }
  return []; // unreachable — the final attempt always uses fromOffset 0
}
