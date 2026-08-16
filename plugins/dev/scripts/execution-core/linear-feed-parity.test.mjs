import { readFileSync } from "node:fs";
// linear-feed-parity.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-parity.test.mjs

import { describe, expect, test } from "bun:test";
import { classOf, compareStreams, edgeKey, explain, resolveWindow } from "./linear-feed-parity.mjs";

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

  test("⛔ a feed-only STATE edge is NOT explained — it could be a spurious dispatch", () => {
    // Deleted with its smee-side twin: explaining it unconditionally made the
    // window CLEAN while hiding a spurious or duplicate state dispatch, and a
    // net collapse cannot explain this direction anyway (two smee transitions
    // against one feed transition yields a SMEE surplus, not a feed one).
    expect(explain("feed", "k", ev("linear.issue.state_changed", "CTC-1", ["state"]))).toBeNull();
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

  test("a plain feed state edge is unexplained — it is not a creation either", () => {
    expect(explain("feed", "k", ev("linear.issue.state_changed", "CTC-1", ["state"]))).toBeNull();
  });
});

describe("⭐ net-edge collapse can ERASE a field, not just merge hops", () => {
  // Measured: CTC-167/CTC-593 entered and left a cycle between feed ticks. Smee saw
  // each hop; the feed saw net-nothing for cycleId and emitted only the state edge.
  // The replica confirms cycle_id ends null, so the feed is right about final state.
  // ⛔ THIS TEST USED TO PIN THE DEFECT (Codex P1 round 3). It asserted that a
  // reversible-field edge is explained as a round trip with NO corroboration —
  // which is exactly the behaviour that let a genuinely dropped cycleId update
  // read as explained and the window return clean. A test can encode a bug as
  // firmly as code does.
  test("⛔ an UNCORROBORATED reversible-field edge is NOT explained", () => {
    // One observed transition is not a round trip; it is an unmatched edge.
    expect(explain("smee", "k", ev("linear.issue.updated", "CTC-167", ["cycleId"]))).toBeNull();
    expect(explain("smee", "k", ev("linear.issue.updated", "CTC-167", ["cycleId"]), { fieldHops: new Map() })).toBeNull();
    expect(
      explain("smee", "k", ev("linear.issue.updated", "CTC-167", ["cycleId"]), {
        fieldHops: new Map([["CTC-167|cycleId", 1]]),
      }),
    ).toBeNull();
  });

  test("⛔ NOT explained even with 2+ observed transitions — counting is not verifying", () => {
    // The corroboration-by-count heuristic was itself unsound and is gone: two
    // cycleId updates can be A→B→C, or two unrelated changes across ticks whose
    // feed copies were BOTH dropped. The only sound check reads the replica, and
    // this module is pure — so the edge stays unexplained for a human.
    expect(
      explain("smee", "k", ev("linear.issue.updated", "CTC-167", ["cycleId"]), {
        fieldHops: new Map([["CTC-167|cycleId", 2]]),
      }),
    ).toBeNull();
    expect(
      explain("smee", "k", ev("linear.issue.updated", "CTC-167", ["cycleId", "projectId"]), {
        fieldHops: new Map([["CTC-167|cycleId", 9], ["CTC-167|projectId", 9]]),
      }),
    ).toBeNull();
  });

  test("a dropped single reversible-field edge now surfaces as UNEXPLAINED", () => {
    // The end-to-end shape of the retracted CLEAN: one smee cycleId edge, no
    // feed counterpart. Previously "explained"; now visible.
    const res = compareStreams({
      smee: [{ ts: "2026-08-16T10:00:00Z", attributes: { "event.name": "linear.issue.updated" }, body: { payload: { ticket: "CTC-509", updatedFromKeys: ["cycleId"] } } }],
      feed: [],
    });
    expect(res.unexplained).toHaveLength(1);
    expect(res.unexplained[0].key).toBe("CTC-509|cycleId");
    expect(res.clean).toBe(false);
  });

  test("⛔ a smee-only STATE edge is NOT explained away — it could hide a dispatch", () => {
    expect(explain("smee", "k", ev("linear.issue.state_changed", "CTC-1", ["stateId"]))).toBeNull();
    expect(explain("smee", "k", ev("linear.issue.updated", "CTC-1", ["state", "cycleId"]))).toBeNull();
  });

  test("a smee-only title/estimate edge stays unexplained — those do not round-trip benignly", () => {
    expect(explain("smee", "k", ev("linear.issue.updated", "CTC-1", ["title"]))).toBeNull();
    expect(explain("smee", "k", ev("linear.issue.updated", "CTC-1", ["estimate"]))).toBeNull();
  });
});

describe("⭐ late arrival — the producers agree on the FACT, disagree on the TIME", () => {
  // Measured on CTL-1869: smee reported cycleId at 08-15T13:56Z, the feed emitted the
  // same change at 08-16T05:57Z. The replica did not carry the field until an
  // unrelated later update dragged it in. The feed diffs snapshots, not history.
  const fed = ev("linear.issue.updated", "CTL-1869", ["cycleId"]);

  test("a feed-only edge smee ALREADY reported before the window is explained", () => {
    const why = explain("feed", "k", fed, { priorSmeeTs: "2026-08-15T13:56:03Z", count: 1 });
    expect(why).toStartWith("late-arrival:");
    expect(why).toContain("2026-08-15T13:56:03Z");
    // The caveat must survive in the reason itself, not just in a comment.
    expect(why).toContain("observation time");
  });

  test("⛔ WITHOUT corroboration it stays UNEXPLAINED — the predicate IS the evidence", () => {
    expect(explain("feed", "k", fed, { priorSmeeTs: null, count: 1 })).toBeNull();
    expect(explain("feed", "k", fed, {})).toBeNull();
  });

  test("⛔ a REPEATED feed edge is not laundered by one stale smee event", () => {
    // Re-emission means the baseline failed to advance — the bug this harness exists
    // to catch. One prior smee event must not explain away N repeats.
    expect(explain("feed", "k", fed, { priorSmeeTs: "2026-08-15T13:56:03Z", count: 2 })).toBeNull();
  });

  test("⛔ late-arrival NEVER explains a SMEE-only edge — that is a missed dispatch", () => {
    expect(explain("smee", "k", ev("linear.issue.updated", "CTL-1", ["title"]), { priorSmeeTs: "2026-08-15T00:00:00Z", count: 1 })).toBeNull();
  });

  test("compareStreams corroborates from OUTSIDE the window and goes clean", () => {
    const prior = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-15T13:56:03Z");
    const now = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-16T05:57:00Z");
    const r = compareStreams({ smee: [prior], feed: [now], since: Date.parse("2026-08-16T02:00:00Z") });
    expect(r.counts.smee).toBe(0); // the corroborating event is outside the window
    expect(r.clean).toBe(true);
    expect(r.explained[0].why).toStartWith("late-arrival:");
  });

  test("⛔ the same setup with a REPEAT emission fails the window", () => {
    const prior = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-15T13:56:03Z");
    const a = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-16T05:57:00Z");
    const b = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-16T05:58:00Z");
    const r = compareStreams({ smee: [prior], feed: [a, b], since: Date.parse("2026-08-16T02:00:00Z") });
    expect(r.clean).toBe(false);
    expect(r.unexplained[0]).toMatchObject({ side: "feed-only", count: 2 });
  });

  test("an unrelated prior smee edge does not corroborate a different key", () => {
    const prior = ev("linear.issue.updated", "CTL-1869", ["title"], "2026-08-15T13:56:03Z");
    const now = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-16T05:57:00Z");
    const r = compareStreams({ smee: [prior], feed: [now], since: Date.parse("2026-08-16T02:00:00Z") });
    expect(r.clean).toBe(false);
  });
});

describe("⛔ corroboration must come from BEFORE the window — never from inside it", () => {
  test("with NO window, nothing counts as prior — there is no 'before'", () => {
    // The vector: a smee event the comparator deliberately IGNORES (its name is
    // outside the compared set) still yields an edge key. Were it admitted as
    // corroboration, a feed-only edge would be explained by an event that was
    // never compared — and the reason string would cite it as prior when it is not.
    const ignored = ev("github.pr.merged", "CTL-1869", ["cycleId"]);
    const fed = ev("linear.issue.updated", "CTL-1869", ["cycleId"]);
    const r = compareStreams({ smee: [ignored], feed: [fed] }); // since: null
    expect(r.counts.smee).toBe(0);
    expect(r.clean).toBe(false); // ← must NOT be laundered into "late arrival"
    expect(r.unexplained[0]).toMatchObject({ side: "feed-only" });
  });

  test("an ignored-name smee event inside a window is not corroboration either", () => {
    const ignored = ev("github.pr.merged", "CTL-1869", ["cycleId"], "2026-08-16T05:00:00Z");
    const fed = ev("linear.issue.updated", "CTL-1869", ["cycleId"], "2026-08-16T05:57:00Z");
    const r = compareStreams({ smee: [ignored], feed: [fed], since: Date.parse("2026-08-16T02:00:00Z") });
    expect(r.clean).toBe(false);
  });
});

// ── CTL-1847: the window's BOTH bounds ────────────────────────────────────────
describe("resolveWindow — trailing-edge clamp", () => {
  const NOW = Date.parse("2026-08-16T20:22:00Z");

  test("holds the trailing edge back by the settle period", () => {
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 120 });
    expect(new Date(w.until).toISOString()).toBe("2026-08-16T20:20:00.000Z");
    expect(new Date(w.since).toISOString()).toBe("2026-08-16T16:22:00.000Z");
  });

  test("⭐ THE LIVE CASE: two comments inside the feed's latency are excluded, not counted as misses", () => {
    // Measured 2026-08-16: comments written at 20:20:03Z and 20:20:08Z read as 2
    // UNEXPLAINED smee-only diffs when the harness ran at 20:22Z; the same window
    // minutes later, unchanged code, showed both on the feed side → CLEAN.
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 120 });
    const smee = [
      { ts: "2026-08-16T20:20:03Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: "CTC-617" } } },
      { ts: "2026-08-16T20:20:08Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: "CTC-381" } } },
    ];
    const res = compareStreams({ smee, feed: [], since: w.since, until: w.until });
    expect(res.counts.smee).toBe(0);
    expect(res.unexplained).toHaveLength(0);
  });

  test("NEGATIVE CONTROL: WITHOUT the clamp those same two ARE unexplained misses", () => {
    // Proves the clamp is what does the work — not that the fixture is inert.
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 0 });
    const smee = [
      { ts: "2026-08-16T20:20:03Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: "CTC-617" } } },
      { ts: "2026-08-16T20:20:08Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: "CTC-381" } } },
    ];
    const res = compareStreams({ smee, feed: [], since: w.since, until: w.until });
    expect(res.counts.smee).toBe(2);
    expect(res.unexplained).toHaveLength(2);
    expect(res.clean).toBe(false);
  });

  test("an edge OLDER than the settle period is still compared", () => {
    // The clamp must not swallow the window it exists to protect.
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 120 });
    const ev = (side) => ({ ts: "2026-08-16T19:00:00Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: `T-${side}` } } });
    const res = compareStreams({ smee: [ev("a")], feed: [ev("a")], since: w.since, until: w.until });
    expect(res.counts.smee).toBe(1);
    expect(res.counts.feed).toBe(1);
    expect(res.matchedKeys).toBe(1);
  });

  test("the clamp is SYMMETRIC — it excludes recent feed events too", () => {
    // Clamping only smee would trade this bias for its mirror: a feed event with
    // no smee twin yet would read as a feed-only diff.
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 120 });
    const recentFeed = [{ ts: "2026-08-16T20:21:30Z", attributes: { "event.name": "linear.comment.created" }, body: { payload: { ticket: "CTL-9" } } }];
    const res = compareStreams({ smee: [], feed: recentFeed, since: w.since, until: w.until });
    expect(res.counts.feed).toBe(0);
  });

  test("the leading-edge clamp still works and is reported", () => {
    const seededAt = Date.parse("2026-08-16T19:00:00Z");
    const w = resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt, settleSec: 120 });
    expect(w.since).toBe(seededAt);
    expect(w.clampedToFeedStart).toBe(true);
  });

  test("no baseline ⇒ leading edge is the requested start, and it says so", () => {
    const w = resolveWindow({ nowMs: NOW, sinceMin: 60, seededAt: null, settleSec: 120 });
    expect(w.clampedToFeedStart).toBe(false);
    expect(new Date(w.since).toISOString()).toBe("2026-08-16T19:22:00.000Z");
  });

  test("a settle period longer than the window is EMPTY, not clean", () => {
    // [].every(p) is true — a zero-event comparison reporting "no unexplained
    // diffs" is the false-clean shape this repo keeps rediscovering.
    const w = resolveWindow({ nowMs: NOW, sinceMin: 1, seededAt: null, settleSec: 600 });
    expect(w.emptyWindow).toBe(true);
    expect(w.until).toBeLessThanOrEqual(w.since);
  });

  test("NEGATIVE CONTROL: a normal window is not flagged empty", () => {
    expect(resolveWindow({ nowMs: NOW, sinceMin: 240, seededAt: null, settleSec: 120 }).emptyWindow).toBe(false);
  });
});

// ── CTL-1847 (Codex P1 #3439): multiplicity, not key presence ────────────────
describe("compareStreams — multiplicity", () => {
  const cmt = (ticket, ts) => ({
    ts,
    attributes: { "event.name": "linear.comment.created" },
    body: { payload: { ticket } },
  });

  test("⭐ two smee comments vs one feed comment on the SAME ticket is a DIFF", () => {
    // Every comment on a ticket maps to `<ticket>|comment`, so a presence check
    // called this "matched" and returned clean:true — letting the parity gate
    // approve a feed that dropped a dispatch-class event.
    const res = compareStreams({
      smee: [cmt("CTL-1", "2026-08-16T10:00:00Z"), cmt("CTL-1", "2026-08-16T10:01:00Z")],
      feed: [cmt("CTL-1", "2026-08-16T10:00:05Z")],
    });
    expect(res.counts).toEqual({ smee: 2, feed: 1 });
    expect(res.clean).toBe(false);
    expect(res.unexplained).toHaveLength(1);
    expect(res.unexplained[0]).toMatchObject({
      side: "smee-only",
      key: "CTL-1|comment",
      count: 1,
      smeeCount: 2,
      feedCount: 1,
    });
  });

  test("NEGATIVE CONTROL: equal counts on both sides stay clean", () => {
    const res = compareStreams({
      smee: [cmt("CTL-1", "2026-08-16T10:00:00Z"), cmt("CTL-1", "2026-08-16T10:01:00Z")],
      feed: [cmt("CTL-1", "2026-08-16T10:00:05Z"), cmt("CTL-1", "2026-08-16T10:01:05Z")],
    });
    expect(res.clean).toBe(true);
    expect(res.unexplained).toHaveLength(0);
    expect(res.matchedKeys).toBe(1);
  });

  test("a feed SURPLUS is reported too, not just a shortfall", () => {
    const res = compareStreams({
      smee: [cmt("CTL-2", "2026-08-16T10:00:00Z")],
      feed: [cmt("CTL-2", "2026-08-16T10:00:05Z"), cmt("CTL-2", "2026-08-16T10:01:00Z")],
    });
    expect(res.unexplained.concat(res.explained)[0]).toMatchObject({
      side: "feed-only",
      count: 1,
      smeeCount: 1,
      feedCount: 2,
    });
  });

  test("matchedKeys counts only keys whose COUNTS agree", () => {
    const res = compareStreams({
      smee: [cmt("A", "2026-08-16T10:00:00Z"), cmt("A", "2026-08-16T10:01:00Z"), cmt("B", "2026-08-16T10:02:00Z")],
      feed: [cmt("A", "2026-08-16T10:00:05Z"), cmt("B", "2026-08-16T10:02:05Z")],
    });
    // B agrees (1 vs 1); A does not (2 vs 1) — so exactly one matched key.
    expect(res.matchedKeys).toBe(1);
  });

  test("the late-arrival explanation still applies only to a SINGLE straggler", () => {
    // A surplus of several is not one straggler; `count` carries the surplus.
    const res = compareStreams({
      smee: [],
      feed: [cmt("CTL-3", "2026-08-16T10:00:00Z"), cmt("CTL-3", "2026-08-16T10:01:00Z")],
    });
    expect(res.unexplained.concat(res.explained)[0].count).toBe(2);
  });
});

// ── CTL-1847 (Codex P1 round 2): comments join on their stable id ────────────
describe("edgeKey — comment identity", () => {
  const cmt = (ticket, id, ts, extra = {}) => ({
    ts,
    attributes: { "event.name": "linear.comment.created" },
    body: { payload: { ticket, commentId: id, ...extra } },
  });

  test("⭐ different comments on one ticket no longer cancel", () => {
    // smee: human A + human B. feed: A + feed-only bot C.
    // Ticket-level counts are 2 vs 2 — "clean" — while inbox delivery of B was
    // dropped. Keyed on commentId, B is a real miss and C is a real surplus.
    const res = compareStreams({
      smee: [cmt("CTL-1", "A", "2026-08-16T10:00:00Z"), cmt("CTL-1", "B", "2026-08-16T10:01:00Z")],
      feed: [
        cmt("CTL-1", "A", "2026-08-16T10:00:05Z"),
        cmt("CTL-1", "C", "2026-08-16T10:02:00Z", { isBot: true }),
      ],
    });
    expect(res.counts).toEqual({ smee: 2, feed: 2 });
    const smeeOnly = res.unexplained.concat(res.explained).filter((d) => d.side === "smee-only");
    expect(smeeOnly).toHaveLength(1);
    expect(smeeOnly[0].key).toBe("CTL-1|comment|B");
    expect(res.clean).toBe(false); // the dropped delivery is now visible
  });

  test("the feed-only BOT comment is still an EXPLAINED asymmetry, not a failure", () => {
    // CTL-1891 requires the feed to carry bot comments smee filters out.
    const res = compareStreams({
      smee: [cmt("CTL-2", "A", "2026-08-16T10:00:00Z")],
      feed: [
        cmt("CTL-2", "A", "2026-08-16T10:00:05Z"),
        cmt("CTL-2", "C", "2026-08-16T10:02:00Z", { isBot: true }),
      ],
    });
    expect(res.unexplained).toHaveLength(0);
    expect(res.explained.some((e) => e.side === "feed-only" && /bot-authored/.test(e.why))).toBe(true);
  });

  test("NEGATIVE CONTROL: identical comment ids on both sides stay clean", () => {
    const res = compareStreams({
      smee: [cmt("CTL-3", "A", "2026-08-16T10:00:00Z"), cmt("CTL-3", "B", "2026-08-16T10:01:00Z")],
      feed: [cmt("CTL-3", "A", "2026-08-16T10:00:05Z"), cmt("CTL-3", "B", "2026-08-16T10:01:05Z")],
    });
    expect(res.clean).toBe(true);
    expect(res.matchedKeys).toBe(2);
  });

  test("a missing commentId degrades to the ticket-level key, it does not drop the event", () => {
    // Coarser is a weaker check; silently not comparing an event is a hole.
    const noId = {
      ts: "2026-08-16T10:00:00Z",
      attributes: { "event.name": "linear.comment.created" },
      body: { payload: { ticket: "CTL-4" } },
    };
    expect(edgeKey(noId)).toBe("CTL-4|comment");
    expect(edgeKey(cmt("CTL-4", "Z", "2026-08-16T10:00:00Z"))).toBe("CTL-4|comment|Z");
  });
});

// ── CTL-1847 (Codex P1 round 4): both tails are reach-checked ────────────────
describe("parity-run bounded-tail reach guards", () => {
  const src = readFileSync(
    new URL("./linear-feed-parity-run.mjs", import.meta.url).pathname,
    "utf8",
  );

  test("BOTH tails get a reach check, not just the feed", () => {
    // I added the feed guard and not the smee one, even though the event log is
    // far busier and capped at the same --tail-bytes, so it is the likelier to
    // truncate. Asserted at source level because the reach math lives in a CLI.
    expect(src).toContain("feedTailShort");
    expect(src).toContain("smeeTailShort");
  });

  test("both short-tail conditions feed the INCONCLUSIVE reasons", () => {
    expect(src).toContain("feed-tail-does-not-reach-window-start");
    expect(src).toContain("smee-tail-does-not-reach-window-start");
  });

  test("the verdict is three-valued and inconclusive has its own exit code", () => {
    expect(src).toContain("inconclusive ? 3 :");
  });
});
