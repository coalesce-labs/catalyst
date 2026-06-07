// Unit tests for the CTL-822 descriptor write-through (Gateway L1 child b).
// Every linear.issue.* event must fold into the CTL-821 descriptor store —
// and per the adversarial-verify finding, the fold MUST run on the LIVE path
// (processEvent) with ZERO registered interests: it sits above the
// `if (!interests.size) return` gate, mirroring the projectWorkerStateEvent
// model, so the store stays current during idle periods. These tests drive
// processEvent directly (not tryTicketLifecycleRoute) for exactly that reason.
// Run: bun test plugins/dev/scripts/broker/linear-descriptor-fold.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  getTicketDescriptor,
  upsertTicketDescriptor,
} from "./broker-state.mjs";
import { processEvent } from "./router.mjs";
import { clearInterests } from "./state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "descriptor-fold-test-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
  // ZERO interests is the load-bearing case: the verify panel caught that a
  // fold placed inside tryTicketLifecycleRoute was starved by processEvent's
  // interests gate whenever the broker was idle.
  clearInterests();
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Legacy-flat envelope matching what the tailer hands processEvent: name via
// `event`, payload via `detail` (canonical body.payload covered separately).
function issueEvent(name, detail, ticket = detail.ticket) {
  return {
    event: name,
    attributes: ticket ? { "linear.issue.identifier": ticket } : {},
    detail,
  };
}

describe("foldLinearIssueDescriptor via processEvent (zero interests — the live idle path)", () => {
  test("issue.updated folds the full snapshot into the descriptor", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-1",
        toState: "Todo",
        toPriority: 2,
        toAssigneeId: "user-1",
        toLabels: ["feature", "broker"],
        issueId: "uuid-1",
      })
    );
    const d = getTicketDescriptor("CTL-1");
    expect(d.state).toBe("Todo");
    expect(d.priority).toBe(2);
    expect(d.assignee).toBe("user-1");
    expect(d.labels).toEqual(["feature", "broker"]);
    expect(d.uuid).toBe("uuid-1");
    expect(d.removed).toBe(false);
  });

  test("state_changed and created fold too (any linear.issue.* topic)", () => {
    processEvent(
      issueEvent("linear.issue.created", { ticket: "CTL-2", toState: "Backlog", issueId: "u-2" })
    );
    processEvent(issueEvent("linear.issue.state_changed", { ticket: "CTL-2", toState: "Todo" }));
    const d = getTicketDescriptor("CTL-2");
    expect(d.state).toBe("Todo");
    expect(d.uuid).toBe("u-2"); // kept from the create (key-presence)
  });

  test("priority_changed topic folds too", () => {
    processEvent(issueEvent("linear.issue.priority_changed", { ticket: "CTL-15", toPriority: 1 }));
    expect(getTicketDescriptor("CTL-15").priority).toBe(1);
  });

  test("unassign IS cleared when the change is evidenced (assignee_changed)", () => {
    upsertTicketDescriptor({ ticket: "CTL-3", assignee: "user-9", uuid: "u-3" });
    processEvent(
      issueEvent("linear.issue.assignee_changed", {
        ticket: "CTL-3",
        toAssigneeId: null,
        updatedFromKeys: ["assigneeId"],
      })
    );
    const d = getTicketDescriptor("CTL-3");
    expect(d.assignee).toBeNull();
    expect(d.uuid).toBe("u-3");
  });

  test("partial payload with toAssigneeId:null but NO change evidence keeps assignee", () => {
    // Linear sends partial issue payloads (data.assignee omitted on an
    // ASSIGNED issue) and the emitter always includes the key — a bare null
    // must be treated as unknown, not an unassign.
    upsertTicketDescriptor({ ticket: "CTL-13", assignee: "user-1" });
    processEvent(
      issueEvent("linear.issue.state_changed", {
        ticket: "CTL-13",
        toState: "PR",
        toAssigneeId: null,
        updatedFromKeys: ["stateId"],
      })
    );
    expect(getTicketDescriptor("CTL-13").assignee).toBe("user-1");
  });

  test("create born-unassigned records the null assignee", () => {
    processEvent(
      issueEvent("linear.issue.created", {
        action: "create",
        ticket: "CTL-16",
        toState: "Backlog",
        toAssigneeId: null,
        updatedFromKeys: [],
      })
    );
    // stored row exists with explicit null assignee (not skipped)
    const d = getTicketDescriptor("CTL-16");
    expect(d.assignee).toBeNull();
    expect(d.state).toBe("Backlog");
  });

  test("payload WITHOUT toAssigneeId key keeps the stored assignee", () => {
    upsertTicketDescriptor({ ticket: "CTL-4", assignee: "user-9" });
    processEvent(issueEvent("linear.issue.state_changed", { ticket: "CTL-4", toState: "PR" }));
    expect(getTicketDescriptor("CTL-4").assignee).toBe("user-9");
  });

  test("toLabels [] is explicitly-empty (clears); toLabels null keeps", () => {
    upsertTicketDescriptor({ ticket: "CTL-5", labels: ["bug"] });
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-5", toLabels: null }));
    expect(getTicketDescriptor("CTL-5").labels).toEqual(["bug"]);
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-5", toLabels: [] }));
    expect(getTicketDescriptor("CTL-5").labels).toEqual([]);
  });

  test("remove resolves by UUID alone (no identifier in payload)", () => {
    processEvent(
      issueEvent("linear.issue.created", { ticket: "CTL-6", toState: "Todo", issueId: "u-6" })
    );
    // remove carries ONLY the entityId — no ticket anywhere on the event
    processEvent(issueEvent("linear.issue.removed", { issueId: "u-6" }, null));
    const d = getTicketDescriptor("CTL-6");
    expect(d.removed).toBe(true);
    expect(d.removedAt).toBeTruthy();
  });

  test("remove prefers the UUID index over a stale identifier on the event", () => {
    processEvent(
      issueEvent("linear.issue.created", { ticket: "CTL-12", toState: "Todo", issueId: "u-12" })
    );
    // resolves u-12 → CTL-12 even though the event names a DIFFERENT ticket
    processEvent(issueEvent("linear.issue.removed", { ticket: "CTL-99", issueId: "u-12" }));
    expect(getTicketDescriptor("CTL-12").removed).toBe(true);
    expect(getTicketDescriptor("CTL-99")).toBeNull();
  });

  test("remove with un-indexed UUID but a ticket falls back to identifier", () => {
    processEvent(
      issueEvent("linear.issue.removed", { ticket: "CTL-7", issueId: "never-indexed" })
    );
    const d = getTicketDescriptor("CTL-7");
    expect(d.removed).toBe(true);
    expect(d.uuid).toBe("never-indexed");
  });

  test("remove with neither UUID-hit nor ticket is a silent no-op (backstop's job)", () => {
    expect(() =>
      processEvent(issueEvent("linear.issue.removed", { issueId: "ghost" }, null))
    ).not.toThrow();
  });

  test("a later issue event resurrects a removed ticket (unarchive)", () => {
    processEvent(issueEvent("linear.issue.created", { ticket: "CTL-8", issueId: "u-8" }));
    processEvent(issueEvent("linear.issue.removed", { issueId: "u-8" }, null));
    expect(getTicketDescriptor("CTL-8").removed).toBe(true);
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-8", toState: "Backlog" }));
    expect(getTicketDescriptor("CTL-8").removed).toBe(false);
  });

  test("linear.comment.* and non-ticket github events never touch the store", () => {
    processEvent(issueEvent("linear.comment.created", { ticket: "CTL-9", body: "hi" }));
    processEvent({ event: "github.pr.merged", detail: { title: "no ticket ref here" } });
    expect(getTicketDescriptor("CTL-9")).toBeNull();
  });

  test("descriptor write failure never breaks event processing (closed DB)", () => {
    closeBrokerStateDb();
    expect(() =>
      processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-10", toState: "Todo" }))
    ).not.toThrow();
    openBrokerStateDb(join(tmpDir, "test.db")); // re-open so afterEach close is balanced
  });

  test("canonical envelope shape (body.payload + attributes event.name) folds the same", () => {
    processEvent({
      attributes: {
        "event.name": "linear.issue.updated",
        "linear.issue.identifier": "CTL-11",
      },
      body: {
        payload: { ticket: "CTL-11", toState: "Implement", issueId: "u-11" },
      },
    });
    const d = getTicketDescriptor("CTL-11");
    expect(d.state).toBe("Implement");
    expect(d.uuid).toBe("u-11");
  });
});
