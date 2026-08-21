// cloud-feed-capture.mjs — CTL-1847. Where a SUPPRESSED event goes.
//
// When the gate withholds an event from dispatch it is written here, never
// dropped. That is the whole difference between a cutover you can audit and one
// you can only argue about: after the flip, "did the feed miss this edge?" is a
// question about two files that both exist, not about an absence.
//
// The sink reuses linear-feed-shadow.mjs's `assertNotEventLog` rather than
// re-deriving the check. A second copy of a structural guard is a second thing
// that can drift out of agreement with the first, and this one exists precisely
// to be impossible to get wrong.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNotEventLog } from "./linear-feed-shadow.mjs";

/**
 * defaultCapturePath — <orchDir>/capture/linear-suppressed-<account>.jsonl
 */
export function defaultCapturePath(orchDir, account = "tenant-0") {
  return join(orchDir, "capture", `linear-suppressed-${account}.jsonl`);
}

/**
 * createCaptureSink — append-only JSONL sink for gate-suppressed events.
 *
 * Fail-OPEN by construction: `append` never throws. A capture sink that can
 * throw would let an unwritable disk take down the dispatch tail it is only
 * observing — the capture is evidence, and evidence must never be load-bearing
 * for the thing it is evidence about. Failures are COUNTED so the silence is
 * still measurable (`stats().failed`), because a fail-open sink that does not
 * count its failures reads exactly like a sink with nothing to write.
 *
 * @param {object} opts
 * @param {string} opts.path          destination file
 * @param {string} [opts.eventsDir]   the unified event-log dir, refused
 * @param {function} [opts.appendFn]  injectable for tests
 * @param {function} [opts.mkdirFn]   injectable for tests
 */
export function createCaptureSink({
  path,
  eventsDir = undefined,
  appendFn = appendFileSync,
  mkdirFn = mkdirSync,
} = {}) {
  // Throws at CONSTRUCTION if the path is event-log shaped — the same
  // structural refusal the shadow sink makes, for the same reason.
  const resolved = assertNotEventLog(path, { eventsDir });

  let written = 0;
  let failed = 0;
  const reasons = Object.create(null);

  try {
    mkdirFn(dirname(resolved), { recursive: true });
  } catch {
    // Deferred to the first append, which is fail-open anyway.
  }

  return {
    path: resolved,

    /**
     * append — record one suppressed event with the gate's verdict alongside it.
     * The verdict is stored NEXT TO the event rather than merged into it: the
     * captured line must remain a faithful copy of what the producer wrote, or
     * the parity harness would be diffing our annotations instead of the two
     * producers.
     */
    append(event, verdict = {}) {
      const line = { capturedAt: new Date().toISOString(), verdict, event };
      let text;
      try {
        text = `${JSON.stringify(line)}\n`;
      } catch {
        // A circular or otherwise unserializable event — count it, name it,
        // and move on rather than throwing into the dispatch tail.
        failed += 1;
        reasons["unserializable"] = (reasons["unserializable"] ?? 0) + 1;
        return false;
      }
      try {
        appendFn(resolved, text);
        written += 1;
        const r = verdict?.reason ?? "unknown";
        reasons[r] = (reasons[r] ?? 0) + 1;
        return true;
      } catch {
        failed += 1;
        return false;
      }
    },

    stats() {
      return { written, failed, reasons: { ...reasons } };
    },
  };
}
