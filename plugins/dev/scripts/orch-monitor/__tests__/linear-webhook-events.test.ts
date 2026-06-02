import { describe, it, expect } from "bun:test";
import { parseLinearWebhookEvent } from "../lib/linear-webhook-events";

function issuePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-1",
      identifier: "CTL-210",
      title: "Build event bus",
      stateId: "new-state-id",
      priority: 2,
      assigneeId: "new-user-id",
      team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
    },
    ...overrides,
  };
}

describe("parseLinearWebhookEvent — Issue", () => {
  it("Issue create → linear.issue.created", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ action: "create", updatedFrom: undefined })
    );
    expect(ev.kind).toBe("issue");
    if (ev.kind !== "issue") return;
    expect(ev.action).toBe("create");
    expect(ev.topic).toBe("linear.issue.created");
    expect(ev.ticket).toBe("CTL-210");
    expect(ev.teamKey).toBe("CTL");
  });

  it("Issue update with stateId in updatedFrom → state_changed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { stateId: "old-state-id" },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.state_changed");
    expect(ev.updatedFromKeys).toContain("stateId");
  });

  it("extracts toState from data.state.name", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { stateId: "old-state-id" },
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          state: { id: "new-state-id", name: "In Progress" },
          priority: 2,
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toState).toBe("In Progress");
  });

  it("toState is null when data.state is absent", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { stateId: "old-state-id" } })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toState).toBeNull();
  });

  it("extracts toPriority from data.priority", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload({ updatedFrom: { priority: 3 } }));
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toPriority).toBe(2);
  });

  it("extracts toAssigneeId and toAssigneeName from data.assignee", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { assigneeId: "old-user-id" },
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          assignee: { id: "new-user-id", name: "Ryan" },
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toAssigneeId).toBe("new-user-id");
    expect(ev.toAssigneeName).toBe("Ryan");
  });

  it("extracts actorName from actor.name", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { stateId: "old" },
        actor: { id: "actor-uuid", name: "Alice" },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.actorName).toBe("Alice");
  });

  it("actorName is null when actor is absent", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload({ updatedFrom: { stateId: "old" } }));
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.actorName).toBeNull();
  });

  it("Issue update with only priority → priority_changed", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload({ updatedFrom: { priority: 3 } }));
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.priority_changed");
  });

  it("Issue update with only assigneeId → assignee_changed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { assigneeId: "old-user" } })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.assignee_changed");
  });

  it("Issue update with stateId + priority → state wins (priority order)", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { stateId: "old", priority: 1 },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.state_changed");
  });

  it("Issue update with no recognized changes → linear.issue.updated", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { title: "old title" } })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.updated");
  });

  it("Issue remove → linear.issue.removed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ action: "remove", updatedFrom: undefined })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.removed");
  });

  it("Issue with unknown action → ignored", () => {
    const ev = parseLinearWebhookEvent("Issue", {
      action: "frobnicate",
      type: "Issue",
      data: { identifier: "CTL-1" },
    });
    expect(ev.kind).toBe("ignored");
  });

  it("Issue with no data → ignored", () => {
    const ev = parseLinearWebhookEvent("Issue", {
      action: "update",
      type: "Issue",
    });
    expect(ev.kind).toBe("ignored");
  });

  // Scoping-field capture: the Linear webhook's raw payload.data carries the
  // fields the daemon's eligibleQuery needs (project, labels, priority). The
  // pre-existing parser dropped them, forcing the daemon to fall back to a full
  // poll for every relevant event ("scoping resolved exclusively by the poll"
  // comment in monitor.mjs). Capturing them now lets the daemon evaluate
  // eligibility from the event payload directly and drop the per-event poll.

  it("extracts toLabels from data.labels.nodes (Linear API shape)", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          labels: {
            nodes: [
              { id: "l1", name: "bug" },
              { id: "l2", name: "p0" },
            ],
          },
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toLabels).toEqual(["bug", "p0"]);
  });

  it("toLabels is null when data.labels is absent", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload());
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toLabels).toBeNull();
  });

  it("toLabels is an empty array when data.labels.nodes is empty", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          labels: { nodes: [] },
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toLabels).toEqual([]);
  });

  it("extracts toProject (name) and toProjectId from data.project", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          project: { id: "proj-uuid", name: "Initiative 1" },
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toProject).toBe("Initiative 1");
    expect(ev.toProjectId).toBe("proj-uuid");
  });

  it("toProject is null when data.project is absent", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload());
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toProject).toBeNull();
    expect(ev.toProjectId).toBeNull();
  });

  it("toProjectId falls back to data.projectId when data.project object is absent", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        data: {
          id: "issue-uuid-1",
          identifier: "CTL-210",
          title: "Build event bus",
          team: { id: "team-uuid", key: "CTL", name: "Catalyst" },
          projectId: "proj-uuid-only",
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.toProject).toBeNull();
    expect(ev.toProjectId).toBe("proj-uuid-only");
  });

  it("previousFromValues mirrors the full updatedFrom object (not just keys)", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: {
          stateId: "old-state",
          labelIds: ["old-label-1", "old-label-2"],
          projectId: "old-proj",
        },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.previousFromValues).toEqual({
      stateId: "old-state",
      labelIds: ["old-label-1", "old-label-2"],
      projectId: "old-proj",
    });
    // updatedFromKeys still derived from Object.keys, unchanged
    expect(ev.updatedFromKeys).toEqual(["stateId", "labelIds", "projectId"]);
  });

  it("previousFromValues is an empty object when updatedFrom is absent", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload({ updatedFrom: undefined }));
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.previousFromValues).toEqual({});
  });
});

describe("parseLinearWebhookEvent — Comment", () => {
  it("Comment create → kind comment, action create", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-uuid",
        body: "looks good",
        issueId: "issue-uuid",
        issue: { id: "issue-uuid", identifier: "CTL-99" },
      },
    });
    expect(ev.kind).toBe("comment");
    if (ev.kind !== "comment") return;
    expect(ev.action).toBe("create");
    expect(ev.commentId).toBe("comment-uuid");
    expect(ev.ticket).toBe("CTL-99");
  });

  it("Comment update → kind comment, action update", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "update",
      type: "Comment",
      data: { id: "c1", issueId: "i1" },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.action).toBe("update");
  });

  it("Comment remove → kind comment, action remove", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "remove",
      type: "Comment",
      data: { id: "c1", issueId: "i1" },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.action).toBe("remove");
  });

  it("CTL-681: captures body from data.body", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "create",
      type: "Comment",
      data: { id: "c1", body: "hello", issueId: "i1", issue: { id: "i1", identifier: "CTL-99" } },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.body).toBe("hello");
  });

  it("CTL-681: captures authorId + authorName from top-level actor", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "create",
      type: "Comment",
      actor: { id: "u1", name: "Ada" },
      data: { id: "c1", issueId: "i1" },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.authorId).toBe("u1");
    expect(ev.authorName).toBe("Ada");
  });

  it("CTL-681: falls back to data.user when top-level actor is absent", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "create",
      type: "Comment",
      data: { id: "c1", issueId: "i1", user: { id: "u2", name: "Bob" } },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.authorId).toBe("u2");
    expect(ev.authorName).toBe("Bob");
  });

  it("CTL-681: null-safe when body and author are absent", () => {
    const ev = parseLinearWebhookEvent("Comment", {
      action: "create",
      type: "Comment",
      data: { id: "c1", issueId: "i1" },
    });
    if (ev.kind !== "comment") throw new Error("expected comment kind");
    expect(ev.body).toBeNull();
    expect(ev.authorId).toBeNull();
    expect(ev.authorName).toBeNull();
  });
});

describe("parseLinearWebhookEvent — Cycle", () => {
  it("Cycle update → kind cycle", () => {
    const ev = parseLinearWebhookEvent("Cycle", {
      action: "update",
      type: "Cycle",
      data: {
        id: "cycle-1",
        team: { key: "CTL" },
        progress: 0.5,
      },
    });
    expect(ev.kind).toBe("cycle");
    if (ev.kind !== "cycle") return;
    expect(ev.cycleId).toBe("cycle-1");
    expect(ev.teamKey).toBe("CTL");
  });
});

describe("parseLinearWebhookEvent — Reaction", () => {
  it("Reaction create → kind reaction", () => {
    const ev = parseLinearWebhookEvent("Reaction", {
      action: "create",
      type: "Reaction",
      data: { id: "rx-1", emoji: "thumbsup" },
    });
    expect(ev.kind).toBe("reaction");
    if (ev.kind !== "reaction") return;
    expect(ev.reactionId).toBe("rx-1");
  });
});

describe("parseLinearWebhookEvent — IssueLabel", () => {
  it("IssueLabel create → kind issue_label", () => {
    const ev = parseLinearWebhookEvent("IssueLabel", {
      action: "create",
      type: "IssueLabel",
      data: { id: "lbl-1", name: "bug" },
    });
    expect(ev.kind).toBe("issue_label");
    if (ev.kind !== "issue_label") return;
    expect(ev.labelId).toBe("lbl-1");
  });
});

describe("parseLinearWebhookEvent — ignored", () => {
  it("non-object payload → ignored", () => {
    const ev = parseLinearWebhookEvent("Issue", "not an object");
    expect(ev.kind).toBe("ignored");
  });

  it("unknown type → ignored", () => {
    const ev = parseLinearWebhookEvent("Project", {
      action: "create",
      type: "Project",
      data: { id: "p1" },
    });
    expect(ev.kind).toBe("ignored");
  });

  it("falls back to payload.type when eventName is empty", () => {
    const ev = parseLinearWebhookEvent("", {
      action: "create",
      type: "Issue",
      data: { identifier: "CTL-1", team: { key: "CTL" } },
    });
    expect(ev.kind).toBe("issue");
  });
});

describe("parseLinearWebhookEvent — description fields (CTL-749)", () => {
  it("extracts description from data.description", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ data: { description: "new text" }, updatedFrom: {} })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.description).toBe("new text");
    expect(ev.descriptionChanged).toBe(false);
  });

  it("description is null when absent from data", () => {
    const ev = parseLinearWebhookEvent("Issue", issuePayload({ data: {}, updatedFrom: {} }));
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.description).toBeNull();
  });

  it("descriptionChanged: true when description in updatedFrom", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        data: { description: "updated text" },
        updatedFrom: { description: "old text" },
      })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.descriptionChanged).toBe(true);
    expect(ev.description).toBe("updated text");
  });

  it("descriptionChanged: false when description not in updatedFrom", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ data: {}, updatedFrom: { title: "old title" } })
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.descriptionChanged).toBe(false);
  });
});

describe("parseLinearWebhookEvent — AgentSessionEvent", () => {
  it("returns kind=agent_session for AgentSessionEvent type", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "create",
      data: { id: "sess-uuid", issueId: "issue-uuid" },
      actor: { id: "actor-uuid", name: "Catalyst" },
    });
    expect(result.kind).toBe("agent_session");
  });

  it("returns kind=ignored for unknown AgentSessionEvent action", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "unknown_action",
      data: { id: "sess-uuid" },
    });
    expect(result.kind).toBe("ignored");
  });

  it("returns sessionId from data.id", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "create",
      data: { id: "sess-uuid-abc", issueId: "issue-uuid" },
    });
    if (result.kind !== "agent_session") throw new Error("expected agent_session");
    expect(result.sessionId).toBe("sess-uuid-abc");
  });

  it("returns issueId from data.issueId", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "update",
      data: { id: "sess-uuid", issueId: "issue-uuid-xyz" },
    });
    if (result.kind !== "agent_session") throw new Error("expected agent_session");
    expect(result.issueId).toBe("issue-uuid-xyz");
  });

  it("returns actorId from actor.id", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "create",
      data: { id: "sess-uuid" },
      actor: { id: "actor-id-123", name: "Catalyst" },
    });
    if (result.kind !== "agent_session") throw new Error("expected agent_session");
    expect(result.actorId).toBe("actor-id-123");
  });

  it("actorId is null when actor is absent", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "create",
      data: { id: "sess-uuid" },
    });
    if (result.kind !== "agent_session") throw new Error("expected agent_session");
    expect(result.actorId).toBeNull();
  });

  it("returns kind=ignored when data is missing", () => {
    const result = parseLinearWebhookEvent("AgentSessionEvent", {
      action: "create",
    });
    expect(result.kind).toBe("ignored");
  });
});

describe("parseLinearWebhookEvent — issueCommentMention", () => {
  it("returns kind=mention for issueCommentMention type", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "comment-uuid", issueId: "issue-uuid", body: "hey @catalyst", issue: { identifier: "CTL-550" } },
      actor: { id: "author-uuid", name: "Ryan" },
    });
    expect(result.kind).toBe("mention");
  });

  it("extracts ticket from data.issue.identifier", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "c1", issue: { identifier: "CTL-550" } },
    });
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(result.ticket).toBe("CTL-550");
  });

  it("extracts body from data.body", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "c1", body: "hello @bot", issue: { identifier: "CTL-1" } },
    });
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(result.body).toBe("hello @bot");
  });

  it("extracts commentId from data.id", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "comment-id-abc", issue: { identifier: "CTL-1" } },
    });
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(result.commentId).toBe("comment-id-abc");
  });

  it("extracts authorId from actor.id", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "c1" },
      actor: { id: "author-uuid-xyz", name: "Ryan" },
    });
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(result.authorId).toBe("author-uuid-xyz");
  });

  it("ticket is null when data.issue is absent", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "create",
      data: { id: "c1" },
    });
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(result.ticket).toBeNull();
  });

  it("returns kind=ignored for unknown action", () => {
    const result = parseLinearWebhookEvent("issueCommentMention", {
      action: "bogus",
      data: { id: "c1" },
    });
    expect(result.kind).toBe("ignored");
  });
});
