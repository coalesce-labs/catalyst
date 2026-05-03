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
      issuePayload({ action: "create", updatedFrom: undefined }),
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
      }),
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.state_changed");
    expect(ev.updatedFromKeys).toContain("stateId");
  });

  it("Issue update with only priority → priority_changed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { priority: 3 } }),
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.priority_changed");
  });

  it("Issue update with only assigneeId → assignee_changed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { assigneeId: "old-user" } }),
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.assignee_changed");
  });

  it("Issue update with stateId + priority → state wins (priority order)", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({
        updatedFrom: { stateId: "old", priority: 1 },
      }),
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.state_changed");
  });

  it("Issue update with no recognized changes → linear.issue.updated", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ updatedFrom: { title: "old title" } }),
    );
    if (ev.kind !== "issue") throw new Error("expected issue kind");
    expect(ev.topic).toBe("linear.issue.updated");
  });

  it("Issue remove → linear.issue.removed", () => {
    const ev = parseLinearWebhookEvent(
      "Issue",
      issuePayload({ action: "remove", updatedFrom: undefined }),
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
