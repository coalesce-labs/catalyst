// linear-feed-event.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-event.test.mjs
//
// ⭐ The most important tests here parse a PRODUCED event through monitor.mjs's
// REAL parsers rather than asserting the shape this module happens to build. That
// is the falsifiable form of COORD-19's boundary: if the cutover ever requires
// editing those handlers, the envelope is wrong and these tests say so. A test
// that asserted my own output shape could only ever agree with me.

import { describe, expect, test } from "bun:test";
import {
  EVENT_COMMENT_CREATED,
  EVENT_ISSUE_UPDATED,
  EVENT_STATE_CHANGED,
  buildCommentEvent,
  buildIssueEvent,
  classifyEdge,
  edgeDelta,
  edgeEventName,
  historyEventId,
} from "./linear-feed-event.mjs";
import { parseIssueUpdatedEvent, parseStateChangedEvent } from "./monitor.mjs";

// Deterministic seams so envelopes are comparable across runs.
const SEAMS = {
  now: () => new Date("2026-08-15T16:00:00.000Z"),
  newId: () => "id0",
  newTrace: () => "trace0",
  newSpan: () => "span0",
};

// A realistic edge, shaped exactly like a row from the replica's issue_history.
const historyRow = (over = {}) => ({
  id: "hist-1",
  issue_id: "issue-uuid-1",
  actor_id: "actor-1",
  created_at: 1786800000000,
  from_state: "Todo",
  to_state: "Triage",
  from_assignee_id: null,
  to_assignee_id: null,
  from_priority: null,
  to_priority: null,
  from_estimate: null,
  to_estimate: null,
  from_project_id: null,
  to_project_id: null,
  updated_description: 0,
  ...over,
});

const issueRow = (over = {}) => ({
  id: "issue-uuid-1",
  identifier: "CTL-1234",
  team_key: "CTL",
  description: "body",
  estimate: 3,
  delegate_id: "delegate-1",
  project_id: null,
  ...over,
});

const TEAMS = new Set(["CTL"]);

describe("⭐ boundary: produced events parse through monitor.mjs's REAL parsers", () => {
  test("a state edge is understood by parseStateChangedEvent", () => {
    const ev = buildIssueEvent(
      {
        history: historyRow({ from_state: "Todo", to_state: "Triage" }),
        issue: issueRow(),
        labels: ["worker:mini"],
        project: { name: "P4 · Dispatch" },
      },
      SEAMS,
    );
    const parsed = parseStateChangedEvent(ev);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      identifier: "CTL-1234",
      teamKey: "CTL",
      toState: "Triage",
      toLabels: ["worker:mini"],
      toProject: "P4 · Dispatch",
    });
  });

  test("a non-state edge is understood by parseIssueUpdatedEvent", () => {
    const ev = buildIssueEvent(
      {
        // same state on both sides; only the estimate moved
        history: historyRow({ from_state: "Todo", to_state: "Todo", from_estimate: 1, to_estimate: 5 }),
        issue: issueRow(),
      },
      SEAMS,
    );
    expect(parseIssueUpdatedEvent(ev)).not.toBeNull();
    // ...and it must NOT masquerade as the dispatch trigger
    expect(parseStateChangedEvent(ev)).toBeNull();
  });

  test("the two names are mutually exclusive for one row", () => {
    const stateEv = buildIssueEvent({ history: historyRow(), issue: issueRow() }, SEAMS);
    expect(parseIssueUpdatedEvent(stateEv)).toBeNull();
  });
});

describe("edgeEventName", () => {
  test("a changed to_state is the dispatch trigger", () => {
    expect(edgeEventName(historyRow({ from_state: "Todo", to_state: "Triage" }))).toBe(EVENT_STATE_CHANGED);
  });

  test("an unchanged state is an update, not a trigger", () => {
    expect(edgeEventName(historyRow({ from_state: "Todo", to_state: "Todo" }))).toBe(EVENT_ISSUE_UPDATED);
  });

  test("an absent to_state is an update", () => {
    for (const to of [null, undefined, ""]) {
      expect(edgeEventName(historyRow({ to_state: to }))).toBe(EVENT_ISSUE_UPDATED);
    }
  });

  test("a first transition (no from_state) still triggers", () => {
    expect(edgeEventName(historyRow({ from_state: null, to_state: "Todo" }))).toBe(EVENT_STATE_CHANGED);
  });
});

describe("team scoping comes from config, and an unconfigured producer emits NOTHING", () => {
  test("the host's own team is emitted", () => {
    expect(classifyEdge({ history: historyRow(), issue: issueRow() }, { teams: TEAMS })).toEqual({
      emit: true,
      reason: "ok",
    });
  });

  test("⭐ a second tenant present in the same replica is NOT emitted", () => {
    // The replica really is multi-tenant (measured: CTL 4,993 · ADV 3,859 · CTC 851
    // · EVR 158 · OTL 114). An unfiltered producer would dispatch on other tenants'
    // transitions.
    const foreign = classifyEdge(
      { history: historyRow(), issue: issueRow({ identifier: "ADV-77", team_key: "ADV" }) },
      { teams: TEAMS },
    );
    expect(foreign).toEqual({ emit: false, reason: "foreign-team" });
  });

  test("both tenants' edges through one call site: only ours survives", () => {
    const rows = [
      { history: historyRow({ id: "h1" }), issue: issueRow() },
      { history: historyRow({ id: "h2" }), issue: issueRow({ identifier: "CTC-9", team_key: "CTC" }) },
      { history: historyRow({ id: "h3" }), issue: issueRow({ identifier: "EVR-2", team_key: "EVR" }) },
    ];
    const emitted = rows.filter((r) => classifyEdge(r, { teams: TEAMS }).emit);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].issue.identifier).toBe("CTL-1234");
  });

  test("no configured team scope emits nothing — absence is not allow-all", () => {
    // The dangerous default would be "no filter configured, so pass everything",
    // which turns a misconfiguration into cross-tenant dispatch.
    for (const teams of [undefined, null, {}]) {
      expect(classifyEdge({ history: historyRow(), issue: issueRow() }, { teams })).toEqual({
        emit: false,
        reason: "no-team-scope-configured",
      });
    }
  });
});

describe("bot self-echo guard (ported as-is)", () => {
  test("a bot-authored edge is dropped", () => {
    const r = classifyEdge(
      { history: historyRow({ actor_id: "bot-1" }), issue: issueRow() },
      { teams: TEAMS, botUserIds: new Set(["bot-1"]) },
    );
    expect(r).toEqual({ emit: false, reason: "bot-authored" });
  });

  test("a human edge with the guard armed still passes", () => {
    const r = classifyEdge(
      { history: historyRow({ actor_id: "human-1" }), issue: issueRow() },
      { teams: TEAMS, botUserIds: new Set(["bot-1"]) },
    );
    expect(r.emit).toBe(true);
  });

  test("an edge with no actor is not mistaken for a bot", () => {
    const r = classifyEdge(
      { history: historyRow({ actor_id: null }), issue: issueRow() },
      { teams: TEAMS, botUserIds: new Set(["bot-1"]) },
    );
    expect(r.emit).toBe(true);
  });
});

describe("every refusal is NAMED — a silent false is how a dead producer looks healthy", () => {
  const cases = [
    [{ history: null, issue: issueRow() }, "no-history-row"],
    [{ history: historyRow({ id: null }), issue: issueRow() }, "history-row-has-no-id"],
    [{ history: historyRow(), issue: null }, "unjoinable-issue"],
    [{ history: historyRow(), issue: issueRow({ identifier: null }) }, "issue-has-no-identifier"],
    [{ history: historyRow(), issue: issueRow({ team_key: null }) }, "issue-has-no-team-key"],
  ];
  for (const [input, reason] of cases) {
    test(`refusal: ${reason}`, () => {
      expect(classifyEdge(input, { teams: TEAMS })).toEqual({ emit: false, reason });
    });
  }

  test("the reasons are distinct — no two failure modes share a label", () => {
    const reasons = cases.map(([, r]) => r);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("⭐ a fast double-transition produces TWO events (never dedup by ticket)", () => {
  test("two history rows → two events, distinct ids, later scoping on the second", () => {
    // Dedup is on issue_history.id, a PRIMARY KEY. Collapsing by ticket would drop
    // an edge — this test exists so a later 'optimisation' fails loudly.
    const first = buildIssueEvent(
      {
        history: historyRow({ id: "h-a", from_state: "Todo", to_state: "Triage" }),
        issue: issueRow({ estimate: 3 }),
      },
      SEAMS,
    );
    const second = buildIssueEvent(
      {
        history: historyRow({ id: "h-b", from_state: "Triage", to_state: "Research" }),
        // the joined row reflects FINAL state — the documented asymmetry
        issue: issueRow({ estimate: 8 }),
      },
      SEAMS,
    );

    expect(first.body.payload.historyId).toBe("h-a");
    expect(second.body.payload.historyId).toBe("h-b");
    expect(first.body.payload.historyId).not.toBe(second.body.payload.historyId);

    // Both are faithful edges...
    expect(parseStateChangedEvent(first).toState).toBe("Triage");
    expect(parseStateChangedEvent(second).toState).toBe("Research");
    // ...while the scoping field on the later one carries current state.
    expect(second.body.payload.toEstimate).toBe(8);
  });

  test("the same row twice yields the same idempotency key", () => {
    const row = historyRow({ id: "h-same" });
    expect(historyEventId(row)).toBe("h-same");
    expect(historyEventId({ ...row })).toBe("h-same");
  });

  test("a row without an id has no key, and is refused rather than guessed", () => {
    expect(historyEventId(historyRow({ id: null }))).toBeNull();
    expect(historyEventId(historyRow({ id: "" }))).toBeNull();
  });
});

describe("edgeDelta — derived from the same row as the edge, so they cannot disagree", () => {
  test("names only the keys that actually moved, with their previous values", () => {
    const d = edgeDelta(
      historyRow({
        from_state: "Todo",
        to_state: "Triage",
        from_estimate: 1,
        to_estimate: 5,
      }),
    );
    expect(d.updatedFromKeys).toContain("state");
    expect(d.updatedFromKeys).toContain("estimate");
    expect(d.updatedFromKeys).not.toContain("priority");
    expect(d.previousFromValues).toMatchObject({ state: "Todo", estimate: 1 });
  });

  test("a pair absent on both sides is not a change", () => {
    const d = edgeDelta(historyRow({ from_state: "Todo", to_state: "Todo" }));
    expect(d.updatedFromKeys).toEqual([]);
  });

  test("setting a previously-absent field counts as a change", () => {
    const d = edgeDelta(historyRow({ from_state: "Todo", to_state: "Todo", from_project_id: null, to_project_id: "p1" }));
    expect(d.updatedFromKeys).toContain("projectId");
    expect(d.previousFromValues.projectId).toBeNull();
  });

  test("a description edit is reported", () => {
    expect(edgeDelta(historyRow({ updated_description: 1 })).updatedFromKeys).toContain("description");
  });
});

describe("the CTL-681 payload is complete — a thin envelope silently costs a poll per event", () => {
  test("every field the webhook producer emits is present", () => {
    const ev = buildIssueEvent(
      {
        history: historyRow({ to_state: "Triage", to_priority: 2, to_assignee_id: "u2", to_estimate: 5 }),
        issue: issueRow(),
        actor: { name: "Ryan Rozich" },
        assignee: { name: "Assignee Name" },
        project: { name: "P4" },
        labels: ["worker:mini"],
      },
      SEAMS,
    );
    const p = ev.body.payload;
    for (const key of [
      "action", "ticket", "teamKey", "issueId", "updatedFromKeys", "actorId", "actorName",
      "toState", "toPriority", "toAssigneeId", "toAssigneeName", "toLabels", "toProject",
      "toProjectId", "previousFromValues", "description", "descriptionChanged", "toEstimate",
      "toDelegateId",
    ]) {
      expect(p).toHaveProperty(key);
    }
    expect(p.actorName).toBe("Ryan Rozich");
    expect(p.toDelegateId).toBe("delegate-1");
    expect(p.toLabels).toEqual(["worker:mini"]);
  });

  test("scoping attributes match the webhook handler's set", () => {
    const ev = buildIssueEvent({ history: historyRow(), issue: issueRow({ repo: "catalyst" }) }, SEAMS);
    expect(ev.attributes).toMatchObject({
      "event.name": EVENT_STATE_CHANGED,
      "linear.issue.identifier": "CTL-1234",
      "linear.team.key": "CTL",
      "linear.actor.id": "actor-1",
      "linear.issue.id": "issue-uuid-1",
      "vcs.repository.name": "catalyst",
    });
  });

  test("the producer is identifiable in the log, for shadow-parity diffing", () => {
    const ev = buildIssueEvent({ history: historyRow(), issue: issueRow() }, SEAMS);
    expect(ev.body.payload.source).toBe("cloud-feed");
  });
});

describe("comment events", () => {
  test("a comments upsert IS comment-created, and carries the ticket", () => {
    const ev = buildCommentEvent(
      {
        comment: { id: "c1", issue_id: "issue-uuid-1", user_id: "human-1", body: "please look" },
        issue: issueRow(),
        author: { name: "Ryan Rozich" },
      },
      SEAMS,
    );
    expect(ev.attributes["event.name"]).toBe(EVENT_COMMENT_CREATED);
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-1234");
    expect(ev.body.payload).toMatchObject({ ticket: "CTL-1234", commentId: "c1", actorName: "Ryan Rozich" });
  });
});

describe("⭐ label changes are a named class, not 'nothing changed'", () => {
  // Found by running against the live replica, not by a test: 90 of ~700 edges in a
  // two-day window carried a label edit and reported updatedFromKeys: [] — coverage
  // class `updated:none`. Labels feed the eligible projection, so that was a
  // dispatch-relevant edge no coverage cell would ever have named.
  const h = (over) => historyRow({ from_state: "Todo", to_state: "Todo", ...over });

  test("an added label is reported", () => {
    expect(edgeDelta(h({ added_label_ids: '["l1"]' })).updatedFromKeys).toContain("labels");
  });

  test("a removed label is reported", () => {
    expect(edgeDelta(h({ removed_label_ids: '["l2"]' })).updatedFromKeys).toContain("labels");
  });

  test("⚠️ an EMPTY json array is not a change — it arrives as '[]', not NULL", () => {
    // A truthiness check alone would call every row a label change, since the column
    // is "[]" rather than NULL when nothing moved.
    for (const empty of ['[]', "", null, undefined]) {
      expect(edgeDelta(h({ added_label_ids: empty, removed_label_ids: empty })).updatedFromKeys).not.toContain("labels");
    }
  });

  test("the previous value records what moved, both directions", () => {
    const d = edgeDelta(h({ added_label_ids: '["a"]', removed_label_ids: '["b","c"]' }));
    expect(d.previousFromValues.labels).toEqual({ added: ["a"], removed: ["b", "c"] });
  });

  test("a malformed value yields no change rather than throwing — one bad row must not stop a sweep", () => {
    expect(() => edgeDelta(h({ added_label_ids: "{not json" }))).not.toThrow();
    expect(edgeDelta(h({ added_label_ids: "{not json" })).updatedFromKeys).not.toContain("labels");
  });
});
