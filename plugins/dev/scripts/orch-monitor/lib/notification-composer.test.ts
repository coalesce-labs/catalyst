/**
 * CTL-1221: Notification Composer Tests
 *
 * Unit tests for composing notifications from escalation payloads.
 * Verifies:
 * - short_text respects 140-char limit
 * - full_briefing includes all required sections per type
 * - markdown structure is well-formed
 * - ticket key is always included
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect } from "bun:test";
import {
  composeNotification,
  EscalationPayload,
} from "./notification-composer";

describe("composeNotification — manual escalation", () => {
  const manual: EscalationPayload = {
    escalation_type: "manual",
    problem: "Database connection pool exhausted, cannot acquire a lock",
    call_to_action: "Increase max pool size and redeploy, then retry",
    blocked_capability: "database transaction",
    instructions: [
      "SSH into prod-db-01",
      "Check current pool size: SELECT count(*) FROM pg_stat_activity",
      "Increase max_connections in postgresql.conf",
    ],
    remediation_then_retry:
      "Redeploy with new pool config and monitor for 5 min",
    why_not_auto: "Pool sizing is a capacity decision that affects other services",
  };

  it("composes short_text under 140 chars", () => {
    const result = composeNotification("CTL-1200", manual);
    expect(result).toBeTruthy();
    expect(result!.short_text.length).toBeLessThanOrEqual(140);
    expect(result!.short_text).toContain("CTL-1200");
    expect(result!.short_text).toContain("database transaction");
  });

  it("composes full_briefing with all sections", () => {
    const result = composeNotification("CTL-1200", manual);
    expect(result!.full_briefing).toContain("## CTL-1200");
    expect(result!.full_briefing).toContain("### Background");
    expect(result!.full_briefing).toContain("### Blocked Capability");
    expect(result!.full_briefing).toContain("### Steps");
    expect(result!.full_briefing).toContain("### Why Automation Can't Do This");
    expect(result!.full_briefing).toContain("### Next Steps");
  });

  it("includes numbered steps", () => {
    const result = composeNotification("CTL-1200", manual);
    expect(result!.full_briefing).toContain("1. SSH");
    expect(result!.full_briefing).toContain("2. Check current");
    expect(result!.full_briefing).toContain("3. Increase max");
  });

  it("preserves ticket key and escalation_type", () => {
    const result = composeNotification("CTL-1200", manual);
    expect(result!.ticket).toBe("CTL-1200");
    expect(result!.escalation_type).toBe("manual");
  });
});

describe("composeNotification — authorization escalation", () => {
  const auth: EscalationPayload = {
    escalation_type: "authorization",
    problem: "Phase verify still failing after 3 remediation cycles",
    call_to_action: "Approve retry or mark as blocked?",
    recommendation: "Retry verify with extended timeout (60s)",
    risk: "Extended timeout may mask a real timing issue; could regress performance",
    why_asking: "Risk threshold exceeded; agent cannot retry autonomously",
    could_higher_tier_resolve: true,
    authorize_label: "approve-verify-retry",
  };

  it("composes short_text asking for approval", () => {
    const result = composeNotification("CTL-1205", auth);
    expect(result).toBeTruthy();
    expect(result!.short_text.length).toBeLessThanOrEqual(140);
    expect(result!.short_text).toContain("Approve");
  });

  it("composes full_briefing with decision context", () => {
    const result = composeNotification("CTL-1205", auth);
    expect(result!.full_briefing).toContain("## CTL-1205");
    expect(result!.full_briefing).toContain("### Background");
    expect(result!.full_briefing).toContain("### Why We're Asking");
    expect(result!.full_briefing).toContain("### Our Recommendation");
    expect(result!.full_briefing).toContain("### Risk");
    expect(result!.full_briefing).toContain("### Your Decision");
  });

  it("notes when higher tier could resolve", () => {
    const result = composeNotification("CTL-1205", auth);
    expect(result!.full_briefing).toContain("higher-tier model");
  });

  it("preserves ticket and escalation_type", () => {
    const result = composeNotification("CTL-1205", auth);
    expect(result!.ticket).toBe("CTL-1205");
    expect(result!.escalation_type).toBe("authorization");
  });
});

describe("composeNotification — decision escalation", () => {
  const decision: EscalationPayload = {
    escalation_type: "decision",
    problem: "Merging this PR would break the public API for existing clients",
    call_to_action:
      "Choose: bump major version now, or revert the breaking change?",
    why_you: "This is a business/API contract decision the agent cannot make",
    options: [
      {
        label: "Bump major version",
        tradeoff: "Forces clients to upgrade; clear signal but operational load",
        risk: "May break integrations that pin to older versions",
      },
      {
        label: "Revert breaking change",
        tradeoff: "Keeps API stable; loses the feature benefit",
        risk: "Delaying the feature may impact roadmap",
      },
      {
        label: "Soft deprecation + grace period",
        tradeoff: "Supports both old and new APIs; extra maintenance",
        risk: "Complex transition; client confusion if not well-communicated",
      },
    ],
  };

  it("composes short_text summarizing options", () => {
    const result = composeNotification("CTL-1210", decision);
    expect(result).toBeTruthy();
    expect(result!.short_text.length).toBeLessThanOrEqual(140);
    expect(result!.short_text).toContain("Choose path");
  });

  it("composes full_briefing with options table", () => {
    const result = composeNotification("CTL-1210", decision);
    expect(result!.full_briefing).toContain("## CTL-1210");
    expect(result!.full_briefing).toContain("### Background");
    expect(result!.full_briefing).toContain("### Why You Decide");
    expect(result!.full_briefing).toContain("### Options");
    expect(result!.full_briefing).toContain("### Your Decision");
  });

  it("formats options as markdown table", () => {
    const result = composeNotification("CTL-1210", decision);
    expect(result!.full_briefing).toContain("| Option | Trade-off | Risk |");
    expect(result!.full_briefing).toContain("Bump major version");
    expect(result!.full_briefing).toContain("Revert breaking");
    expect(result!.full_briefing).toContain("Soft deprecation");
  });

  it("preserves ticket and escalation_type", () => {
    const result = composeNotification("CTL-1210", decision);
    expect(result!.ticket).toBe("CTL-1210");
    expect(result!.escalation_type).toBe("decision");
  });
});

describe("composeNotification — edge cases", () => {
  it("returns null for missing ticket", () => {
    const result = composeNotification("", {
      escalation_type: "manual",
      problem: "test",
      call_to_action: "test",
    });
    expect(result).toBeNull();
  });

  it("returns null for missing escalation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = composeNotification("CTL-1000", null as any);
    expect(result).toBeNull();
  });

  it("returns null for unknown escalation_type", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = composeNotification("CTL-1000", {
      escalation_type: "unknown" as any,
      problem: "test",
      call_to_action: "test",
    });
    expect(result).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const minimal: EscalationPayload = {
      escalation_type: "manual",
      problem: "Something went wrong",
      call_to_action: "Fix it",
    };

    const result = composeNotification("CTL-1300", minimal);
    expect(result).toBeTruthy();
    expect(result!.short_text).toContain("CTL-1300");
    expect(result!.full_briefing).toContain("Something went wrong");
  });

  it("truncates long short_text with ellipsis", () => {
    const longPayload: EscalationPayload = {
      escalation_type: "authorization",
      problem:
        "This is a very long problem statement that will definitely exceed the 140 character limit when combined with the ticket key and other text",
      call_to_action: "test",
      recommendation:
        "This is also a long recommendation that should get truncated",
      risk: "This is a risk",
    };

    const result = composeNotification("CTL-1400", longPayload);
    expect(result!.short_text.length).toBeLessThanOrEqual(140);
    if (result!.short_text.length === 140) {
      expect(result!.short_text).toContain("…");
    }
  });
});
