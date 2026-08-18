// github-feed-parity-source.mjs — CTL-2022. Which stream is "the feed side"?
//
// ⛔ WHY THIS IS A SEPARATE MODULE. `github-feed-parity-run.mjs` is a CLI: it has
// top-level `await`, it reads `process.argv`, and it ends in `process.exit`. Importing
// it from a test RUNS it. So the two decisions this ticket adds — which stream to read,
// and what a `would-dispatch` marker means — live here, where they can be driven
// directly. Same split the file already makes for `compareGithubStreams`: the pure part
// is testable, the I/O part is not.
//
// ── THE DEFECT THIS EXISTS TO PREVENT ──────────────────────────────────────
// The producer's sink has TWO branches. In `shadow` it writes raw output to the shadow
// FILE and a `would-dispatch` MARKER to the event log. In `enforce` it writes the REAL
// event to the EVENT LOG. The runner read the shadow file unconditionally, so at
// enforce it measured a stream that enforce does not dispatch from.
//
// Measured on mini-2, enforce window 2026-08-18 18:58:16Z-19:44:15Z: shadow file
// carried 125 `check_suite.completed` + 28 `push`; the event log's `cloud-feed` channel
// carried ZERO of each. The ledger said `clean = true · exit 0` for the whole outage.

/** The two streams that can be "the feed side". */
export const FEED_SOURCES = Object.freeze(["shadow", "event-log"]);

/**
 * selectFeedSource — resolve which stream the feed side should be read from.
 *
 * ⛔ THERE IS NO DEFAULT FOR "I COULD NOT RESOLVE THE MODE". Defaulting to `shadow` is
 * precisely the choice that reads clean during an enforce outage, and defaulting to
 * `event-log` would report a total gap on every healthy shadow host. Both defaults are
 * confidently wrong in one direction, so an unresolved mode is INCONCLUSIVE and the
 * caller must be told to pass `--feed-source`.
 *
 * An explicit request always wins — an operator re-reading a PAST window needs to pick
 * the side that was live then, which today's mode cannot tell them.
 */
export function selectFeedSource({ requestedSource = null, mode = null } = {}) {
  if (requestedSource !== null && requestedSource !== undefined) {
    if (!FEED_SOURCES.includes(requestedSource)) {
      return { ok: false, reason: `unknown-feed-source:${requestedSource}`, source: null };
    }
    return { ok: true, source: requestedSource, why: "explicit" };
  }
  if (typeof mode !== "string" || mode.length === 0) {
    return { ok: false, reason: "mode-unresolved", source: null };
  }
  // ⚠️ ONLY `enforce` reads the event log. `off` and `shadow` both write the shadow
  // file, and an UNRECOGNISED mode reads the shadow file too — it is the side that
  // exists in every configuration, so an unknown mode degrades to "measure what is
  // definitely being written" rather than to "report everything as missing".
  return { ok: true, source: mode === "enforce" ? "event-log" : "shadow", why: `mode:${mode}` };
}

/**
 * isCloudFeedEvent — the feed's own copy on the unified event log.
 *
 * ⛔ IDENTIFIED BY ITS POSITIVE PROVENANCE STAMP, never by elimination. The runner's
 * smee reader already states this rule for the other direction ("Our own copy is
 * excluded by its positive provenance stamp, never by elimination"); reading the feed
 * side as "everything that isn't smee" would sweep in mirrored copies from other hosts
 * and any future producer.
 */
export function isCloudFeedEvent(e) {
  const n = e?.attributes?.["event.name"];
  if (typeof n !== "string" || !n.startsWith("github.")) return false;
  return e?.body?.payload?.source === "cloud-feed";
}

/**
 * markerEventName — the CONSUMED name a `would-dispatch` marker stands in for, or null
 * when the event is not a marker.
 *
 * ⛔ MARKERS ARE EVIDENCE OF A GAP, NOT SILENCE. At enforce, a covered name the producer
 * downgraded leaves nothing under its real name, so without counting markers a DROPPED
 * name is indistinguishable from a QUIET one — which is exactly how 153 dropped edges
 * read as agreement. Both key spellings are accepted because the payload and the
 * attribute carry the same value and a caller may have either shape in hand.
 */
export function markerEventName(e, markerName) {
  if (e?.attributes?.["event.name"] !== markerName) return null;
  const inner =
    e?.body?.payload?.eventName ?? e?.attributes?.["catalyst.github_feed.event_name"] ?? null;
  return typeof inner === "string" && inner.length > 0 ? inner : "(unknown)";
}
