// webhook-replica-mappers.test.mjs — CAT-152. Pure translation tests: no I/O,
// no DB, no network. Fixture LinearWebhookEvent objects only.
import { describe, test, expect } from "bun:test";
import { mapIssueChange, mapIssueLabels, mapCommentChange } from "./webhook-replica-mappers.mjs";

describe("mapIssueChange", () => {
  test("create/update → upsert with full row from event.data", () => {
    const event = {
      kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: {
        id: "uuid-1", identifier: "CTL-210", title: "Webhook replica",
        description: "desc", state: { name: "In Progress" }, priority: 2,
        estimate: 3, url: "https://linear.app/x/issue/CTL-210",
        branchName: "ctl-210-webhook-replica", assignee: { id: "u1" },
        team: { id: "t1" }, project: { id: "p1" }, createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-10T00:00:00Z",
      },
    };
    const change = mapIssueChange(event);
    expect(change.entity).toBe("issues");
    expect(change.op).toBe("upsert");
    expect(change.entityId).toBe("uuid-1");
    expect(change.row).toMatchObject({
      id: "uuid-1", identifier: "CTL-210", title: "Webhook replica",
      description: "desc", state: "In Progress", priority: 2, estimate: 3,
      url: "https://linear.app/x/issue/CTL-210", branch_name: "ctl-210-webhook-replica",
      assignee_id: "u1", team_id: "t1", project_id: "p1",
    });
  });

  test("remove action → delete keyed on issueId, no row required", () => {
    const event = { kind: "issue", action: "remove", ticket: null, issueId: "uuid-1", data: {} };
    const change = mapIssueChange(event);
    expect(change.entity).toBe("issues");
    expect(change.op).toBe("delete");
    expect(change.entityId).toBe("uuid-1");
  });

  test("missing data.id falls back to event.issueId for the row's own id column", () => {
    const event = {
      kind: "issue", action: "create", ticket: "CTL-1", issueId: "uuid-2",
      data: { identifier: "CTL-1", title: "t", state: { name: "Todo" } },
    };
    const change = mapIssueChange(event);
    expect(change.row.id).toBe("uuid-2");
  });

  test("throws a descriptive error for a non-issue event", () => {
    expect(() => mapIssueChange({ kind: "comment" })).toThrow(/kind/);
  });

  test("assignee/team/project fall back to flat *Id fields when the nested object is absent", () => {
    const event = {
      kind: "issue", action: "update", ticket: "CTL-5", issueId: "uuid-5",
      data: { id: "uuid-5", identifier: "CTL-5", title: "t", state: { name: "Todo" },
        assigneeId: "u9", teamId: "t9", projectId: "p9" },
    };
    const change = mapIssueChange(event);
    expect(change.row).toMatchObject({ assignee_id: "u9", team_id: "t9", project_id: "p9" });
  });

  test("undefined fields are stripped from the row, not written as literal undefined", () => {
    const event = {
      kind: "issue", action: "create", ticket: "CTL-6", issueId: "uuid-6",
      data: { id: "uuid-6", identifier: "CTL-6", title: "t", state: { name: "Todo" } },
    };
    const change = mapIssueChange(event);
    expect(Object.values(change.row)).not.toContain(undefined);
    expect("description" in change.row).toBe(false);
  });
});

describe("mapIssueLabels", () => {
  test("webhook flat-array shape → issue_labels + labels changes", () => {
    const event = {
      kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" },
        labels: [{ id: "lbl-1", name: "bug", color: "#f00" }, { id: "lbl-2", name: "P1", color: "#00f" }] },
    };
    const { labelDefs, issueLabelLinks } = mapIssueLabels(event);
    expect(labelDefs).toEqual([
      { entity: "labels", op: "upsert", row: { id: "lbl-1", name: "bug", color: "#f00" } },
      { entity: "labels", op: "upsert", row: { id: "lbl-2", name: "P1", color: "#00f" } },
    ]);
    expect(issueLabelLinks).toEqual([
      { entity: "issue_labels", op: "upsert", row: { issue_id: "uuid-1", label_id: "lbl-1" } },
      { entity: "issue_labels", op: "upsert", row: { issue_id: "uuid-1", label_id: "lbl-2" } },
    ]);
  });

  test("GraphQL nodes shape (data.labels.nodes[]) is also accepted", () => {
    const event = {
      kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" },
        labels: { nodes: [{ id: "lbl-1", name: "bug" }] } },
    };
    const { labelDefs, issueLabelLinks } = mapIssueLabels(event);
    expect(labelDefs).toHaveLength(1);
    expect(issueLabelLinks).toHaveLength(1);
  });

  test("no labels field on the payload → no label changes (key-presence, not empty-clear)", () => {
    const event = { kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" } } };
    const { labelDefs, issueLabelLinks } = mapIssueLabels(event);
    expect(labelDefs).toEqual([]);
    expect(issueLabelLinks).toEqual([]);
  });

  test("explicitly empty labels array → empty changes (not an error)", () => {
    const event = { kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" }, labels: [] } };
    const { labelDefs, issueLabelLinks } = mapIssueLabels(event);
    expect(labelDefs).toEqual([]);
    expect(issueLabelLinks).toEqual([]);
  });
});

describe("mapCommentChange", () => {
  test("create/update → upsert with full row from event.data", () => {
    const event = {
      kind: "comment", action: "create", ticket: "CTL-210", commentId: "c-1", issueId: "uuid-1",
      data: { id: "c-1", issueId: "uuid-1", body: "hello", user: { id: "u1", name: "A" },
        createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" },
    };
    const change = mapCommentChange(event);
    expect(change.entity).toBe("comments");
    expect(change.op).toBe("upsert");
    expect(change.entityId).toBe("c-1");
    expect(change.row).toMatchObject({ id: "c-1", issue_id: "uuid-1", body: "hello", author_id: "u1", author_name: "A" });
  });

  test("remove action → delete keyed on commentId", () => {
    const event = { kind: "comment", action: "remove", commentId: "c-1", data: {} };
    const change = mapCommentChange(event);
    expect(change.entity).toBe("comments");
    expect(change.op).toBe("delete");
    expect(change.entityId).toBe("c-1");
  });

  test("throws a descriptive error for a non-comment event", () => {
    expect(() => mapCommentChange({ kind: "issue" })).toThrow(/kind/);
  });
});
