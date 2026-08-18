// github-feed-parity-source.test.mjs — CTL-2022.
//
// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-parity-source.test.mjs

import { describe, expect, test } from "bun:test";
import {
  FEED_SOURCES,
  selectFeedSource,
  isCloudFeedEvent,
  markerEventName,
} from "./github-feed-parity-source.mjs";
import { EVENT_WOULD_DISPATCH } from "./github-feed-timer.mjs";

describe("⛔ selectFeedSource — enforce reads the stream that dispatches", () => {
  test("enforce -> event-log", () => {
    expect(selectFeedSource({ mode: "enforce" })).toEqual({
      ok: true, source: "event-log", why: "mode:enforce",
    });
  });

  test("shadow and off -> shadow, unchanged from today", () => {
    for (const mode of ["shadow", "off"]) {
      expect(selectFeedSource({ mode }).source).toBe("shadow");
    }
  });

  test("⚠️ an UNRECOGNISED mode reads the shadow file, not the event log", () => {
    // Both are written in `shadow`/`off`, only one is written in `enforce`. Degrading to
    // the side that exists in EVERY configuration beats degrading to "report everything
    // as missing", which is a false alarm on every healthy host.
    expect(selectFeedSource({ mode: "ENFORCE" }).source).toBe("shadow");
    expect(selectFeedSource({ mode: "banana" }).source).toBe("shadow");
  });
});

describe("⛔ an unresolved mode is INCONCLUSIVE — there is no safe default", () => {
  // Defaulting to `shadow` is the choice that read clean through the 2026-08-18 enforce
  // outage; defaulting to `event-log` reports a total gap on every healthy shadow host.
  // Both are confidently wrong in one direction.
  test("null / undefined / empty mode all refuse, by name", () => {
    for (const mode of [null, undefined, ""]) {
      const r = selectFeedSource({ mode });
      expect(r.ok).toBe(false);
      expect(r.source).toBeNull();
      expect(r.reason).toBe("mode-unresolved");
    }
  });

  test("a non-string mode refuses rather than coercing", () => {
    for (const mode of [0, 1, {}, [], true]) {
      expect(selectFeedSource({ mode }).ok).toBe(false);
    }
  });

  test("no arguments at all refuses", () => {
    expect(selectFeedSource().ok).toBe(false);
    expect(selectFeedSource({}).ok).toBe(false);
  });
});

describe("an explicit request wins — a PAST window needs the side that was live then", () => {
  test("both valid values are honoured over the mode", () => {
    for (const source of FEED_SOURCES) {
      const r = selectFeedSource({ requestedSource: source, mode: "shadow" });
      expect(r).toEqual({ ok: true, source, why: "explicit" });
    }
  });

  test("an invalid request refuses by NAME rather than falling through to the mode", () => {
    // Falling through would silently ignore a typo and answer from the host's current
    // mode — an operator asking for one window and being handed another.
    const r = selectFeedSource({ requestedSource: "eventlog", mode: "enforce" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown-feed-source:eventlog");
    expect(r.source).toBeNull();
  });
});

describe("⛔ isCloudFeedEvent identifies the feed's copy by its POSITIVE stamp", () => {
  const feed = {
    attributes: { "event.name": "github.pr.merged" },
    body: { payload: { source: "cloud-feed" } },
  };
  test("a stamped github.* event is the feed's", () => {
    expect(isCloudFeedEvent(feed)).toBe(true);
  });

  test("⛔ an UNSTAMPED github.* event is NOT — never by elimination", () => {
    // A webhook copy, a mirrored copy from another host, or a future producer would all
    // be swept in by "everything that isn't smee".
    expect(isCloudFeedEvent({ attributes: { "event.name": "github.pr.merged" }, body: { payload: {} } })).toBe(false);
    expect(isCloudFeedEvent({ attributes: { "event.name": "github.pr.merged" } })).toBe(false);
    expect(isCloudFeedEvent({ attributes: { "event.name": "github.pr.merged" }, body: { payload: { source: "webhook" } } })).toBe(false);
  });

  test("a non-github stamped event is not the feed side", () => {
    expect(isCloudFeedEvent({ attributes: { "event.name": "linear.issue.updated" }, body: { payload: { source: "cloud-feed" } } })).toBe(false);
  });

  test("junk does not throw", () => {
    for (const e of [null, undefined, {}, { attributes: null }, 42]) {
      expect(isCloudFeedEvent(e)).toBe(false);
    }
  });
});

describe("⛔ markerEventName — a marker is evidence of a GAP, not silence", () => {
  const marker = (inner) => ({
    attributes: { "event.name": EVENT_WOULD_DISPATCH, "catalyst.github_feed.event_name": inner },
    body: { payload: { eventName: inner } },
  });

  test("it returns the CONSUMED name the marker stands in for", () => {
    expect(markerEventName(marker("github.check_suite.completed"), EVENT_WOULD_DISPATCH)).toBe(
      "github.check_suite.completed",
    );
  });

  test("either key spelling resolves — payload or attribute alone", () => {
    expect(markerEventName(
      { attributes: { "event.name": EVENT_WOULD_DISPATCH }, body: { payload: { eventName: "github.push" } } },
      EVENT_WOULD_DISPATCH,
    )).toBe("github.push");
    expect(markerEventName(
      { attributes: { "event.name": EVENT_WOULD_DISPATCH, "catalyst.github_feed.event_name": "github.push" } },
      EVENT_WOULD_DISPATCH,
    )).toBe("github.push");
  });

  test("⚠️ a marker with NO inner name is still counted, as (unknown)", () => {
    // Dropping it would restore the exact failure: an unattributable marker is still a
    // dispatch the producer declined, and silence is what this whole change is about.
    expect(markerEventName({ attributes: { "event.name": EVENT_WOULD_DISPATCH } }, EVENT_WOULD_DISPATCH))
      .toBe("(unknown)");
  });

  test("a non-marker returns null — including a real github event", () => {
    expect(markerEventName({ attributes: { "event.name": "github.pr.merged" } }, EVENT_WOULD_DISPATCH)).toBeNull();
    expect(markerEventName({}, EVENT_WOULD_DISPATCH)).toBeNull();
    expect(markerEventName(null, EVENT_WOULD_DISPATCH)).toBeNull();
  });

  test("⭐ the marker name is the REAL one, imported not re-typed", () => {
    // If the producer renames the marker, this fails here rather than silently making
    // every dropped dispatch class invisible again.
    expect(EVENT_WOULD_DISPATCH).toBe("github-feed.would-dispatch");
  });
});
