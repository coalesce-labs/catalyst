// linear-feed-parity.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-parity.test.mjs

import { describe, expect, test } from "bun:test";
import { classOf, compareStreams, edgeKey, explain } from "./linear-feed-parity.mjs";

const ev = (name, ticket, keys = [], ts = "2026-08-16T01:00:00Z") => ({
  ts,
  attributes: { "event.name": name, "linear.issue.identifier": ticket },
  body: { payload: { ticket, updatedFromKeys: keys } },
});

describe("⭐ the join key is (ticket, changed-fields) — NEVER the event name", () => {
  test("the same change keys identically from both producers, despite different names", () => {
    // Smee names a state+priority update `state_changed` via the ladder; the feed
    // calls it `updated`. Same key, so they match instead of reporting a diff.
    const smee = ev("linear.issue.state_changed", "CTL-1", ["state", "priority"]);
    const feed = ev("linear.issue.updated", "CTL-1", ["priority", "state"]);
    expect(edgeKey(smee)).toBe(edgeKey(feed));
  });

  test("field order does not affect the key", () => {
    expect(edgeKey(ev("linear.issue.updated", "CTL-1", ["b", "a"]))).toBe(
      edgeKey(ev("linear.issue.updated", "CTL-1", ["a", "b"])),
    );
  });

  test("comments key on the ticket, not on fields", () => {
    expect(edgeKey(ev("linear.comment.created", "CTL-1"))).toBe("CTL-1|comment");
  });

  test("an event with no ticket has no key rather than a bogus one", () => {
    expect(edgeKey({})).toBeNull();
    expect(edgeKey(null)).toBeNull();
  });
});

describe("coverage classes match the sink's classification", () => {
  test("updated fans out per field; others are single classes", () => {
    expect(classOf(ev("linear.issue.updated", "CTL-1", ["estimate", "priority"]))).toEqual([
      "linear.issue.updated:estimate",
      "linear.issue.updated:priority",
    ]);
    expect(classOf(ev("linear.issue.state_changed", "CTL-1", ["state"]))).toEqual(["linear.issue.state_changed"]);
    expect(classOf(ev("linear.issue.updated", "CTL-1", []))).toEqual(["linear.issue.updated:none"]);
  });
});

describe("⛔ explained asymmetries are PREDICATES, not prose", () => {
  test("a smee name no handler consumes is explained", () => {
    for (const n of ["linear.issue.priority_changed", "linear.issue.assignee_changed", "linear.issue.delegate_changed"]) {
      expect(explain("smee", "k", ev(n, "CTL-1", ["priority"]))).toContain("smee-only-name");
    }
  });

  test("a feed edge of only ladder-named fields is explained as MORE COMPLETE", () => {
    const why = explain("feed", "k", ev("linear.issue.updated", "CTL-1", ["priority"]));
    expect(why).toBe("feed-more-complete:ladder-named-differently");
  });

  test("a feed state edge is flagged as a net-edge-collapse candidate", () => {
    expect(explain("feed", "k", ev("linear.issue.updated", "CTL-1", ["state"]))).toBe("net-edge-collapse-candidate");
  });

  test("⭐ an asymmetry matching NO predicate is UNEXPLAINED — suspicion is the default", () => {
    expect(explain("feed", "k", ev("linear.issue.updated", "CTL-1", ["title"]))).toBeNull();
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["title"]))).toBeNull();
  });
});

describe("compareStreams", () => {
  test("identical streams are clean with zero diffs", () => {
    const a = [ev("linear.issue.updated", "CTL-1", ["estimate"])];
    const b = [ev("linear.issue.updated", "CTL-1", ["estimate"])];
    const r = compareStreams({ smee: a, feed: b });
    expect(r.clean).toBe(true);
    expect(r.unexplained).toEqual([]);
    expect(r.matchedKeys).toBe(1);
  });

  test("⭐ a genuine feed-only edge is UNEXPLAINED and fails the window", () => {
    const r = compareStreams({
      smee: [],
      feed: [ev("linear.issue.updated", "CTL-9", ["title"])],
    });
    expect(r.clean).toBe(false);
    expect(r.unexplained).toHaveLength(1);
    expect(r.unexplained[0]).toMatchObject({ side: "feed-only", why: null });
  });

  test("⭐ a genuine smee-only edge is UNEXPLAINED — a MISSED dispatch is the worst case", () => {
    // This is the failure the whole window exists to catch: smee saw a change the
    // feed did not, so post-cutover that ticket would not have dispatched.
    const r = compareStreams({
      smee: [ev("linear.issue.state_changed", "CTL-7", ["state"])],
      feed: [],
    });
    expect(r.clean).toBe(false);
    expect(r.unexplained[0]).toMatchObject({ side: "smee-only" });
  });

  test("explained asymmetries do NOT fail the window, but are reported", () => {
    const r = compareStreams({
      smee: [ev("linear.issue.priority_changed", "CTL-2", ["priority"])],
      feed: [],
    });
    expect(r.clean).toBe(true);
    expect(r.explained).toHaveLength(1);
    expect(r.explained[0].why).toContain("smee-only-name");
  });

  test("the window bounds which events are compared", () => {
    const early = ev("linear.issue.updated", "CTL-1", ["estimate"], "2026-08-16T00:00:00Z");
    const late = ev("linear.issue.updated", "CTL-2", ["estimate"], "2026-08-16T02:00:00Z");
    const r = compareStreams({
      smee: [early, late], feed: [early, late],
      since: Date.parse("2026-08-16T01:00:00Z"),
    });
    expect(r.counts.smee).toBe(1);
    expect(r.counts.feed).toBe(1);
  });

  test("smee events outside the dispatch/ladder name set are ignored entirely", () => {
    const r = compareStreams({ smee: [ev("github.pr.merged", "CTL-1")], feed: [] });
    expect(r.counts.smee).toBe(0);
    expect(r.clean).toBe(true);
  });

  test("both-sides class counts are reported for the coverage gate", () => {
    const r = compareStreams({
      smee: [ev("linear.issue.updated", "CTL-1", ["estimate"])],
      feed: [ev("linear.issue.updated", "CTL-1", ["estimate"])],
    });
    expect(r.classes.smee["linear.issue.updated:estimate"]).toBe(1);
    expect(r.classes.feed["linear.issue.updated:estimate"]).toBe(1);
  });

  test("empty input is clean but reports nothing matched — not a pass by vacuity", () => {
    const r = compareStreams({ smee: [], feed: [] });
    expect(r.matchedKeys).toBe(0);
    expect(r.counts).toEqual({ smee: 0, feed: 0 });
    // `clean` alone must never be read as "parity proven" — the coverage gate is
    // what makes an empty comparison insufficient.
    expect(r.clean).toBe(true);
  });
});

describe("⭐ untracked-by-design smee fields are EXPLAINED, not widened into the edge source", () => {
  test("an edge of only untracked fields is explained, with the reason", () => {
    const why = explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["updatedAt", "sortOrder"]));
    expect(why).toStartWith("smee-only-fields:");
    expect(why).toContain("every mirror rewrite");
  });

  test("completedAt is explained — its consumer reads the replica directly", () => {
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["completedAt"]))).toContain("reads the replica directly");
  });

  test("⛔ a MIXED edge is NOT explained away — the tracked part should have matched", () => {
    // The dangerous shortcut would be "contains an untracked field → explained",
    // which would hide a genuinely missed dispatch riding alongside bookkeeping.
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["updatedAt", "title"]))).toBeNull();
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["stateId", "sortOrder"]))).toBeNull();
  });
});

describe("⭐ the join strips bookkeeping and aliases field names — found on live data", () => {
  test("the SAME edit keys identically despite updatedAt riding along", () => {
    // Live evidence: smee `CTL-1894|estimate,updatedAt` vs feed `CTL-1894|estimate`
    // were counted as two one-sided diffs. `updatedAt` is on every smee payload, so
    // leaving it in the key means almost nothing ever matches.
    const smee = ev("linear.issue.updated", "CTL-1894", ["estimate", "updatedAt"]);
    const feed = ev("linear.issue.updated", "CTL-1894", ["estimate"]);
    expect(edgeKey(smee)).toBe(edgeKey(feed));
  });

  test("stateId and state are the same change under two names", () => {
    expect(edgeKey(ev("linear.issue.state_changed", "CTL-1", ["stateId"]))).toBe(
      edgeKey(ev("linear.issue.updated", "CTL-1", ["state"])),
    );
  });

  test("a real multi-field smee edge matches its feed counterpart", () => {
    const smee = ev("linear.issue.state_changed", "CTC-1", ["completedAt", "sortOrder", "stateId", "updatedAt"]);
    const feed = ev("linear.issue.updated", "CTC-1", ["state"]);
    expect(edgeKey(smee)).toBe(edgeKey(feed));
  });

  test("coverage classes align across both vocabularies", () => {
    expect(classOf(ev("linear.issue.updated", "CTL-1", ["stateId", "updatedAt"]))).toEqual([
      "linear.issue.updated:state",
    ]);
  });

  test("an edge of ONLY bookkeeping still explains as smee-only-fields", () => {
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["updatedAt", "sortOrder"]))).toStartWith(
      "smee-only-fields:",
    );
  });
});

describe("⭐ bot-authored comments are feed-only BY DESIGN (measured)", () => {
  const botComment = (ticket) => ({
    ts: "2026-08-16T01:00:00Z",
    attributes: { "event.name": "linear.comment.created", "linear.issue.identifier": ticket },
    body: { payload: { ticket, isBot: true } },
  });

  test("a bot-authored feed comment is explained, citing the requirement", () => {
    const why = explain("feed", "k", botComment("CTC-596"));
    expect(why).toContain("bot-authored");
    expect(why).toContain("CTL-1891");
  });

  test("a HUMAN feed-only comment stays UNEXPLAINED — that would be a real diff", () => {
    const human = { ...botComment("CTC-1"), body: { payload: { ticket: "CTC-1", isBot: false } } };
    expect(explain("feed", "k", human)).toBeNull();
  });

  test("issue creation gets its own predicate, not net-edge-collapse", () => {
    const created = ev("linear.issue.updated", "CTC-596", ["description", "priority", "projectId", "state", "teamId", "title"]);
    expect(explain("feed", "k", created)).toStartWith("feed-created-synthetic-edge");
  });

  test("a plain state edge is still the collapse candidate, not a creation", () => {
    expect(explain("feed", "k", ev("linear.issue.updated", "CTL-1", ["state"]))).toBe("net-edge-collapse-candidate");
  });
});
