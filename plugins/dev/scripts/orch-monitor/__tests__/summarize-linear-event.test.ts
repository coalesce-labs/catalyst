import { describe, expect, it } from "bun:test";
import { summarizeLinearEvent } from "../lib/summarize-linear-event";

describe("summarizeLinearEvent", () => {
  describe("linear.issue.state_changed", () => {
    it("returns 'state changed' for plain stateId", () => {
      expect(summarizeLinearEvent("linear.issue.state_changed", "CTL-1", ["stateId"])).toBe(
        "CTL-1: state changed",
      );
    });

    it("returns 'started' when stateId + startedAt", () => {
      expect(
        summarizeLinearEvent("linear.issue.state_changed", "CTL-1", [
          "stateId",
          "sortOrder",
          "startedAt",
          "updatedAt",
        ]),
      ).toBe("CTL-1: started");
    });

    it("returns 'completed' when stateId + completedAt", () => {
      expect(
        summarizeLinearEvent("linear.issue.state_changed", "CTL-1", ["stateId", "completedAt"]),
      ).toBe("CTL-1: completed");
    });

    it("returns 'canceled' when stateId + canceledAt", () => {
      expect(
        summarizeLinearEvent("linear.issue.state_changed", "CTL-1", ["stateId", "canceledAt"]),
      ).toBe("CTL-1: canceled");
    });

    it("omits ticket prefix when ticket is undefined", () => {
      expect(summarizeLinearEvent("linear.issue.state_changed", undefined, ["stateId"])).toBe(
        "state changed",
      );
    });
  });

  describe("linear.issue.assignee_changed", () => {
    it("returns 'reassigned'", () => {
      expect(summarizeLinearEvent("linear.issue.assignee_changed", "CTL-2", ["assigneeId"])).toBe(
        "CTL-2: reassigned",
      );
    });
  });

  describe("linear.issue.priority_changed", () => {
    it("returns 'priority changed'", () => {
      expect(summarizeLinearEvent("linear.issue.priority_changed", "CTL-3", ["priority"])).toBe(
        "CTL-3: priority changed",
      );
    });
  });

  describe("linear.issue.updated", () => {
    it("returns 'title changed' when title key present", () => {
      expect(summarizeLinearEvent("linear.issue.updated", "CTL-4", ["title"])).toBe(
        "CTL-4: title changed",
      );
    });

    it("returns 'estimate changed' when estimate key present", () => {
      expect(summarizeLinearEvent("linear.issue.updated", "CTL-4", ["estimate"])).toBe(
        "CTL-4: estimate changed",
      );
    });

    it("returns 'updated' for unknown keys", () => {
      expect(summarizeLinearEvent("linear.issue.updated", "CTL-4", ["dueDate"])).toBe(
        "CTL-4: updated",
      );
    });

    it("returns 'updated' for empty keys", () => {
      expect(summarizeLinearEvent("linear.issue.updated", "CTL-4", [])).toBe("CTL-4: updated");
    });
  });

  describe("linear.issue.created / removed", () => {
    it("returns 'created'", () => {
      expect(summarizeLinearEvent("linear.issue.created", "CTL-5", [])).toBe("CTL-5: created");
    });

    it("returns 'removed'", () => {
      expect(summarizeLinearEvent("linear.issue.removed", "CTL-5", [])).toBe("CTL-5: removed");
    });
  });

  describe("linear.issue_label events", () => {
    it("returns 'label updated' for linear.issue_label.updated with no ticket", () => {
      expect(summarizeLinearEvent("linear.issue_label.updated", undefined, [])).toBe(
        "label updated",
      );
    });

    it("returns 'label updated' for linear.issue_label.created", () => {
      expect(summarizeLinearEvent("linear.issue_label.created", undefined, [])).toBe(
        "label updated",
      );
    });
  });

  describe("multiple keys — most significant wins via event type", () => {
    it("state_changed + assigneeId still shows state context (stateId took priority in parser)", () => {
      expect(
        summarizeLinearEvent("linear.issue.state_changed", "CTL-6", ["stateId", "assigneeId"]),
      ).toBe("CTL-6: state changed");
    });
  });

  describe("fallback for unknown linear events", () => {
    it("returns trimmed suffix for unknown linear events", () => {
      expect(summarizeLinearEvent("linear.comment.created", "CTL-7", [])).toBe(
        "CTL-7: comment.created",
      );
    });

    it("returns just suffix when no ticket", () => {
      expect(summarizeLinearEvent("linear.cycle.updated", undefined, [])).toBe("cycle.updated");
    });
  });
});
