// ticket-discussion.test.tsx — the PURE timeline math behind the Discussion
// surface (CTL-1574). No rendering: buildTimeline / coalesceBursts /
// describeOrNull / creationEventId are React-free by construction, which is what
// makes the merge, tie-break and burst-collapse rules testable at all.
//
// The three rules worth pinning are the ones a reader cannot verify by eye and a
// refactor can silently invert: the chronological merge, the SAME-MILLISECOND
// tie-break (event before comment — the state changed, THEN someone commented),
// and the burst threshold (a run must EXCEED 4 within 5 minutes to collapse).

import { describe, it, expect } from "bun:test";
import {
  buildTimeline,
  coalesceBursts,
  creationEventId,
  describeOrNull,
  visibleTimelineNodes,
  type CommentNode,
  type EventNode,
} from "./ticket-discussion";
import type { TicketActivityEvent, TicketComment } from "../../../lib/ticket-discussion-reader.mjs";

const BURST_WINDOW_MS = 5 * 60 * 1000;

/** An activity event with every property untouched (all-null), overridden per-test.
 *  A bare event like this describes NOTHING, which is exactly Linear's creation row. */
function event(over: Partial<TicketActivityEvent> & { id: string; created_at: number }): TicketActivityEvent {
  return {
    actor_id: null,
    actor_name: null,
    actor_avatar_url: null,
    from_state: null,
    to_state: null,
    from_assignee_id: null,
    from_assignee_name: null,
    to_assignee_id: null,
    to_assignee_name: null,
    from_priority: null,
    to_priority: null,
    from_estimate: null,
    to_estimate: null,
    from_title: null,
    to_title: null,
    from_cycle_id: null,
    from_cycle_number: null,
    to_cycle_id: null,
    to_cycle_number: null,
    from_project_id: null,
    from_project_name: null,
    to_project_id: null,
    to_project_name: null,
    from_parent_id: null,
    from_parent_identifier: null,
    to_parent_id: null,
    to_parent_identifier: null,
    from_team_id: null,
    to_team_id: null,
    from_due_date: null,
    to_due_date: null,
    added_labels: [],
    removed_labels: [],
    updated_description: null,
    archived: null,
    auto_archived: null,
    auto_closed: null,
    trashed: null,
    ...over,
  };
}

function comment(over: Partial<TicketComment> & { id: string; updated_at: number }): TicketComment {
  return {
    body: "hello",
    author_id: null,
    author_name: "ryan",
    author_avatar_url: null,
    is_bot: 0,
    parent_id: null,
    ...over,
  };
}

/** A same-actor run of `n` events, `stepMs` apart, starting at `startTs`. */
function run(actor: string, n: number, startTs: number, stepMs: number): TicketActivityEvent[] {
  return Array.from({ length: n }, (_, i) =>
    event({
      id: `${actor}-${i}`,
      created_at: startTs + i * stepMs,
      actor_name: actor,
      // Give each one a real transition so it is never mistaken for the creation row.
      to_state: "Implement",
      from_state: "Backlog",
    }),
  );
}

describe("buildTimeline", () => {
  it("interleaves comments and events in ascending timestamp order", () => {
    const nodes = buildTimeline(
      [comment({ id: "c1", updated_at: 200 }), comment({ id: "c2", updated_at: 400 })],
      [
        event({ id: "e1", created_at: 100, actor_name: "ryan", to_state: "Todo" }),
        event({ id: "e2", created_at: 300, actor_name: "ryan", to_state: "Implement" }),
      ],
    );

    expect(nodes.map((n) => n.ts)).toEqual([100, 200, 300, 400]);
    expect(nodes.map((n) => n.kind)).toEqual(["event", "comment", "event", "comment"]);
  });

  it("puts the event FIRST when an event and a comment share a millisecond", () => {
    const nodes = buildTimeline(
      [comment({ id: "c1", updated_at: 1000 })],
      [event({ id: "e1", created_at: 1000, actor_name: "ryan", to_state: "Done" })],
    );

    expect(nodes.map((n) => n.kind)).toEqual(["event", "comment"]);
  });

  it("labels the earliest bare event as the creation row and never coalesces it", () => {
    // A bare event (no transition) at t=0, then a 5-event same-actor burst.
    const activity = [event({ id: "created", created_at: 0, actor_name: "ryan" }), ...run("ryan", 5, 1000, 10)];
    const nodes = buildTimeline([], activity);

    expect(creationEventId(activity)).toBe("created");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "event", isCreation: true });
    expect(nodes[1]!.kind).toBe("burst");
  });

  it("returns [] for a ticket with no comments and no activity", () => {
    expect(buildTimeline([], [])).toEqual([]);
  });
});

describe("visibleTimelineNodes", () => {
  const six = buildTimeline(
    [],
    [1, 2, 3, 4, 5, 6].map((n) =>
      // Alternate actors so the run never coalesces into a burst.
      event({ id: `e${n}`, created_at: n * 1000, actor_id: `a${n % 2}`, actor_name: `u${n % 2}`, to_state: "Todo" }),
    ),
  );

  it("collapse keeps the NEWEST limit nodes, ascending by default", () => {
    const { collapsed, shown } = visibleTimelineNodes(six, { limit: 5, showAll: false, newestFirst: false });
    expect(collapsed).toBe(true);
    expect(shown.map((n) => n.ts)).toEqual([2000, 3000, 4000, 5000, 6000]);
  });

  it("newestFirst flips DISPLAY order only — collapse still keeps the newest", () => {
    const { shown } = visibleTimelineNodes(six, { limit: 5, showAll: false, newestFirst: true });
    expect(shown.map((n) => n.ts)).toEqual([6000, 5000, 4000, 3000, 2000]);
  });

  it("showAll expands the full stream and newestFirst still reverses it", () => {
    const { collapsed, shown } = visibleTimelineNodes(six, { limit: 5, showAll: true, newestFirst: true });
    expect(collapsed).toBe(false);
    expect(shown.map((n) => n.ts)).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
  });

  it("no limit means nothing collapses and input order is preserved", () => {
    const { collapsed, shown } = visibleTimelineNodes(six, { limit: undefined, showAll: false, newestFirst: false });
    expect(collapsed).toBe(false);
    expect(shown.map((n) => n.ts)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
  });

  it("newestFirst keeps the same-millisecond tie-break (event still above its comment)", () => {
    // t=1000 event+comment (tie-broken event-first), then a newer t=2000 comment.
    const nodes = buildTimeline(
      [comment({ id: "c1", updated_at: 1000 }), comment({ id: "c2", updated_at: 2000 })],
      [event({ id: "e1", created_at: 1000, actor_name: "ryan", to_state: "Done" })],
    );
    const { shown } = visibleTimelineNodes(nodes, { limit: undefined, showAll: false, newestFirst: true });
    // The t=2000 group leads; the t=1000 group follows with event BEFORE comment.
    expect(shown.map((n) => `${n.ts}:${n.kind}`)).toEqual(["2000:comment", "1000:event", "1000:comment"]);
  });

  it("does not mutate the ascending source when reversing", () => {
    const before = six.map((n) => n.ts);
    visibleTimelineNodes(six, { limit: undefined, showAll: false, newestFirst: true });
    expect(six.map((n) => n.ts)).toEqual(before);
  });
});

describe("creationEventId", () => {
  it("is null when the earliest event already describes a real change", () => {
    // Nothing to label "created" — mislabeling a real transition would be a lie.
    expect(creationEventId(run("ryan", 2, 500, 10))).toBeNull();
  });

  it("is null for an empty activity list", () => {
    expect(creationEventId([])).toBeNull();
  });

  it("labels a bare earliest row within the creation window of the issue's created_at", () => {
    const activity = [event({ id: "created", created_at: 60_000, actor_name: "ryan" })];
    expect(creationEventId(activity, 0)).toBe("created");
  });

  it("refuses the label when the bare earliest row arrives long after the issue was created", () => {
    // Linear emits bare rows for unextracted properties (subscribers, relations);
    // a bare row a month after created_at is one of those, not the creation.
    const activity = [event({ id: "late-bare", created_at: 31 * 24 * 3_600_000, actor_name: "ryan" })];
    expect(creationEventId(activity, 0)).toBeNull();
  });

  it("keeps the unguarded behavior when the issue's created_at is unknown", () => {
    const activity = [event({ id: "created", created_at: 999_999_999, actor_name: "ryan" })];
    expect(creationEventId(activity, null)).toBe("created");
    expect(creationEventId(activity)).toBe("created");
  });
});

describe("coalesceBursts", () => {
  const nodesOf = (events: TicketActivityEvent[]): EventNode[] =>
    events.map((e) => ({ kind: "event", ts: e.created_at, event: e, isCreation: false }));

  it("splits a run on actor_id even when the display names collide", () => {
    // Two accounts named "ryan": merging them would attribute the whole burst
    // to the first. 5+5 adjacent events must yield two bursts, not one.
    const a = run("ryan", 5, 0, 1000).map((e) => ({ ...e, actor_id: "user-a" }));
    const b = run("ryan", 5, 5000, 1000).map((e, i) => ({
      ...e,
      id: `b-${i}`,
      actor_id: "user-b",
    }));
    const out = coalesceBursts(nodesOf([...a, ...b]));

    expect(out).toHaveLength(2);
    expect(out.every((n) => n.kind === "burst")).toBe(true);
  });

  it("leaves a run of exactly 4 expanded (the threshold is EXCEED, not reach)", () => {
    const out = coalesceBursts(nodesOf(run("ryan", 4, 0, 1000)));

    expect(out).toHaveLength(4);
    expect(out.every((n) => n.kind === "event")).toBe(true);
  });

  it("collapses a run of 5 within the 5-minute window into one burst", () => {
    const out = coalesceBursts(nodesOf(run("ryan", 5, 0, 1000)));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "burst", actorName: "ryan" });
    expect((out[0] as { events: TicketActivityEvent[] }).events).toHaveLength(5);
    // The burst carries the LAST event's timestamp (when the run finished).
    expect(out[0]!.ts).toBe(4000);
  });

  it("breaks a run on a gap LONGER than the 5-minute window", () => {
    // 3 tight events, then a 4th one just past the window, then 2 more tight ones.
    // Neither side exceeds 4, so nothing collapses.
    const events = [
      ...run("ryan", 3, 0, 1000),
      ...run("ryan", 3, 3000 + BURST_WINDOW_MS + 1, 1000).map((e) => ({ ...e, id: `late-${e.id}` })),
    ];
    const out = coalesceBursts(nodesOf(events));

    expect(out).toHaveLength(6);
    expect(out.every((n) => n.kind === "event")).toBe(true);
  });

  it("keeps a gap of EXACTLY the window inside one run", () => {
    const events = run("ryan", 5, 0, BURST_WINDOW_MS);
    const out = coalesceBursts(nodesOf(events));

    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("burst");
  });

  it("breaks a run when the actor changes", () => {
    const out = coalesceBursts(nodesOf([...run("ryan", 3, 0, 100), ...run("agent", 3, 1000, 100)]));

    expect(out).toHaveLength(6);
  });

  it("breaks a run on an intervening comment", () => {
    const mid: CommentNode = {
      kind: "comment",
      ts: 250,
      comment: comment({ id: "c1", updated_at: 250 }),
    };
    const out = coalesceBursts([
      ...nodesOf(run("ryan", 3, 0, 100)),
      mid,
      ...nodesOf(run("ryan", 3, 300, 100).map((e) => ({ ...e, id: `b-${e.id}` }))),
    ]);

    expect(out.map((n) => n.kind)).toEqual([
      "event",
      "event",
      "event",
      "comment",
      "event",
      "event",
      "event",
    ]);
  });

  it("never folds an actor-less system event into a burst", () => {
    const systemRun = run("ryan", 6, 0, 100).map((e) => ({ ...e, actor_name: null }));
    const out = coalesceBursts(nodesOf(systemRun));

    expect(out).toHaveLength(6);
  });
});

describe("describeOrNull", () => {
  it("returns null for a bare event that touched nothing we describe", () => {
    expect(describeOrNull(event({ id: "e", created_at: 1 }))).toBeNull();
  });

  it("carries the destination state's color as a dot for a state transition", () => {
    const desc = describeOrNull(
      event({ id: "e", created_at: 1, from_state: "Backlog", to_state: "Done" }),
    );

    // "Done" is the success bucket — the dot proves the state vocabulary is wired.
    expect(desc?.dot).toBe("var(--color-green)");
  });

  it("describes a label change without a state dot", () => {
    const desc = describeOrNull(
      event({
        id: "e",
        created_at: 1,
        added_labels: [{ id: "l1", name: "needs-human", color: "#e36b6b" }],
      }),
    );

    expect(desc).not.toBeNull();
    expect(desc?.dot).toBeUndefined();
  });

  it("ignores a label whose name the replica never resolved", () => {
    // A null-name label cannot be shown without fabricating one, so the describer
    // must fall through rather than render a nameless swatch.
    const desc = describeOrNull(
      event({ id: "e", created_at: 1, added_labels: [{ id: "l1", name: null, color: null }] }),
    );

    expect(desc).toBeNull();
  });

  it("distinguishes an explicit unarchive (0) from an untouched archive flag (null)", () => {
    expect(describeOrNull(event({ id: "a", created_at: 1, archived: 1 }))).not.toBeNull();
    expect(describeOrNull(event({ id: "b", created_at: 1, archived: 0 }))).not.toBeNull();
    expect(describeOrNull(event({ id: "c", created_at: 1, archived: null }))).toBeNull();
  });

  it("gives every phase-contract state a non-neutral dot", () => {
    // These are the states this workspace actually emits; a neutral dot on them
    // would make the busiest transitions carry no color signal at all.
    const expected: Record<string, string> = {
      Research: "var(--color-blue)",
      Plan: "var(--color-blue)",
      Implement: "var(--color-blue)",
      Validate: "var(--color-blue)",
      PR: "var(--color-blue)",
      Remediate: "var(--color-yellow)",
      Done: "var(--color-green)",
    };
    for (const [state, color] of Object.entries(expected)) {
      const desc = describeOrNull(event({ id: state, created_at: 1, to_state: state }));
      expect(desc?.dot).toBe(color);
    }
  });

  it("prefers the state transition when an event touches several properties", () => {
    // DESCRIBERS is ordered; state wins so the row reads as the transition it is.
    const desc = describeOrNull(
      event({ id: "e", created_at: 1, to_state: "Implement", to_priority: 2 }),
    );

    expect(desc?.dot).toBe("var(--color-blue)");
  });
});
