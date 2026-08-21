// linear-feed-shadow.mjs — CTL-1847, the shadow sink.
//
// During the shadow window the producer must emit somewhere the parity harness can
// read and NOTHING can act on. This is that somewhere.
//
// ── ⛔ SHADOW MEANS SHADOW, ENFORCED NOT PROMISED ────────────────────────────
// The single catastrophic failure for this file is writing into
// `~/catalyst/events/YYYY-MM.jsonl`. That log is read by the broker, the monitor,
// `catalyst-events wait-for`, the HUD and the reaper — a shadow event landing there
// is not a bad measurement, it is a REAL DISPATCH from an unvalidated producer,
// during the window whose entire purpose is to find out whether the producer is
// correct.
//
// So the refusal is structural: `createShadowSink` REJECTS a path that resolves
// inside the event-log directory, or that matches the event-log filename pattern,
// and it does so at construction rather than at write time — a guard that fires on
// the first write has already been handed a live config. A comment saying "don't
// point this at the event log" is not a control; this is.
//
// ── PER-CLASS COUNTS ARE THE POINT, NOT A NICETY ────────────────────────────
// The shadow window's exit criterion is coverage: every event class the daemon acts
// on, observed at least N times, with zero unexplained diffs. That is only
// checkable if the sink counts what it wrote, BY CLASS, as it writes it. The daemon
// acts on exactly three names (measured): `linear.issue.state_changed`,
// `linear.comment.created`, and `linear.issue.updated` — the last fanning out into
// the payload variants the eligible projection reads, which is where field-mapping
// bugs actually live. So `updated` is counted per variant, not as one bucket.
//
// Counting happens at the sink rather than in the harness because the sink is the
// one place that sees every emission exactly once. The harness compares streams; if
// it also had to derive coverage it would be deriving it from the thing it is
// supposed to be auditing.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVENT_ISSUE_UPDATED } from "./linear-feed-event.mjs";

/** Matches the unified event log's filename, e.g. `2026-08.jsonl`. */
const EVENT_LOG_BASENAME = /^\d{4}-\d{2}\.jsonl$/;

/**
 * Refuse any path that could be the unified event log.
 *
 * Two independent tests, because either alone is defeatable: the directory check
 * catches `~/catalyst/events/anything.jsonl`, and the basename check catches a
 * month-named log placed somewhere unexpected. Exported so the runner can assert
 * the same rule before it ever constructs a sink.
 */
export function assertNotEventLog(path, { eventsDir } = {}) {
  const abs = resolve(path);
  if (EVENT_LOG_BASENAME.test(abs.split("/").pop() ?? "")) {
    throw new Error(`shadow sink refuses an event-log-shaped filename: ${abs}`);
  }
  const dir = eventsDir ? resolve(eventsDir) : null;
  if (dir && (abs === dir || abs.startsWith(`${dir}/`))) {
    throw new Error(`shadow sink refuses a path inside the event log directory: ${abs}`);
  }
  if (/\/catalyst\/events(\/|$)/.test(dirname(abs))) {
    throw new Error(`shadow sink refuses a path inside the event log directory: ${abs}`);
  }
  return abs;
}

/**
 * The coverage class for one emitted event.
 *
 * ⚠️ `updated:none` is a REAL class, not a bucket for junk. Measured on the live
 * replica over a two-day window: 61 of ~700 CTL edges changed none of the modeled
 * columns — not state, assignee, priority, estimate, project, cycle, parent, title,
 * due-date, description, labels, archived, trashed, or auto-closed. Whatever they
 * record lives only in the history row's `raw`. They are almost certainly not
 * dispatch-relevant, but they are EMITTED AND NAMED rather than dropped, so the
 * parity harness still diffs them against smee's output. Do not "clean this up" by
 * discarding them — an unattributed edge that both producers agree on is evidence;
 * a silently discarded one is a hole in the comparison.
 *
 * `state_changed` and `comment.created` are single classes. `issue.updated` is
 * counted as `updated:<key>` per changed field — one event touching two fields
 * counts toward BOTH, because coverage asks "has this field's mapping been
 * exercised", not "how many events were there".
 */
export function coverageClassesOf(event) {
  const name = event?.attributes?.["event.name"] ?? null;
  if (name !== EVENT_ISSUE_UPDATED) return name ? [name] : [];
  const keys = event?.body?.payload?.updatedFromKeys;
  if (!Array.isArray(keys) || keys.length === 0) return [`${name}:none`];
  return keys.map((k) => `${name}:${k}`);
}

/**
 * A sink that appends one JSON line per event and counts coverage as it goes.
 *
 * The write is a single `appendFileSync` of a line built in memory — atomic well
 * past any line size this produces (CTL-1809's cap concerns the bash `printf >>`
 * path; the JS writers were explicitly out of scope there because `appendFileSync`
 * is atomic far beyond it).
 */
export function createShadowSink({ path, eventsDir, appendFn = appendFileSync, mkdirFn = mkdirSync } = {}) {
  const abs = assertNotEventLog(path, { eventsDir });
  mkdirFn(dirname(abs), { recursive: true });

  const counts = new Map();
  let written = 0;
  let failed = 0;

  const emit = (event) => {
    const line = `${JSON.stringify(event)}\n`;
    // Count only AFTER the write succeeds: a coverage number that includes events
    // the harness will never see is worse than a smaller honest one, because the
    // exit criterion is read off these counts.
    try {
      appendFn(abs, line);
    } catch (err) {
      failed += 1;
      throw err; // the sweep's last-contiguous-success rule needs the throw
    }
    written += 1;
    for (const cls of coverageClassesOf(event)) {
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
  };

  return {
    emit,
    path: abs,
    /** `{ written, failed, classes: {cls: n} }` — the harness's coverage input. */
    stats() {
      return { written, failed, classes: Object.fromEntries([...counts.entries()].sort()) };
    },
    /**
     * Which of the required classes are still short of `min`. The shadow window
     * exits on this being empty (plus zero unexplained diffs), so it names the
     * cells to go manufacture rather than reporting a bare pass/fail.
     */
    missing(required, min = 1) {
      const out = [];
      for (const cls of required ?? []) {
        const n = counts.get(cls) ?? 0;
        if (n < min) out.push({ cls, seen: n, need: min });
      }
      return out;
    },
  };
}
