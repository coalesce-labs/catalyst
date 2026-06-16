// Orch-monitor producer namespace parity test (CTL-1142).
// Asserts that orch-monitor event names (GitHub webhooks, Linear webhooks,
// service-health) never collide with the broker's protected namespace.
//
// Run: bun test plugins/dev/scripts/orch-monitor/__tests__/namespace-parity.test.ts

import { describe, test, expect } from "bun:test";
import {
  isBrokerProtectedName,
  PHASE_EVENT_PATTERN,
} from "../../broker/namespace-contract.mjs";

// ── Representative orch-monitor event names ──────────────────────────────────
//
// The orch-monitor producers do NOT export a centralized event-name constant or
// map — names are inline string templates (see lib/webhook-handler.ts and
// lib/linear-webhook-handler.ts). This test therefore:
//   (a) asserts representative names from each producer family are safe, and
//   (b) proves by prefix that the entire github.* / linear.* family can never
//       collide with the protected namespace — a mathematical guarantee that
//       renders the per-name check redundant for any future additions in those
//       families.
//
// Adding a new orch-monitor event name family? Add a prefix-family assertion
// and at least one representative name.

// GitHub webhook events (lib/webhook-handler.ts buildEventLogEnvelope).
// Names follow `github.<entity>.<action>` or plain `github.<entity>`.
const GITHUB_REPRESENTATIVE_NAMES = [
  "github.pr.opened",
  "github.pr.merged",
  "github.pr.closed",
  "github.check_suite.completed",
  "github.push",
  "github.deployment.created",
  "github.deployment_status.success",
  "github.release.published",
  "github.workflow_run.completed",
  "github.pr_review.submitted",
  "github.pr_review_comment.created",
  "github.issue_comment.created",
  "github.status.success",
];

// Linear webhook events (lib/linear-webhook-handler.ts + lib/linear-webhook-events.ts).
// Names follow `linear.<entity>.<action>`.
const LINEAR_REPRESENTATIVE_NAMES = [
  "linear.issue.created",
  "linear.issue.removed",
  "linear.issue.state_changed",
  "linear.issue.priority_changed",
  "linear.issue.assignee_changed",
  "linear.issue.updated",
  "linear.comment.created",
  "linear.cycle.created",
  "linear.reaction.created",
  "linear.issue_label.created",
  "linear.agent_session.created",
  "linear.mention.created",
];

// Service health events (lib/server.ts ~line 934).
const SERVICE_HEALTH_NAMES = ["catalyst.service.health"];

const ALL_ORCH_MONITOR_NAMES = [
  ...GITHUB_REPRESENTATIVE_NAMES,
  ...LINEAR_REPRESENTATIVE_NAMES,
  ...SERVICE_HEALTH_NAMES,
];

describe("orch-monitor representative event names", () => {
  test("none are broker-protected", () => {
    for (const name of ALL_ORCH_MONITOR_NAMES) {
      expect(
        isBrokerProtectedName(name),
        `orch-monitor event "${name}" collides with the broker-protected namespace`
      ).toBe(false);
    }
  });

  test("none match PHASE_EVENT_PATTERN", () => {
    for (const name of ALL_ORCH_MONITOR_NAMES) {
      expect(
        PHASE_EVENT_PATTERN.test(name),
        `orch-monitor event "${name}" unexpectedly matches PHASE_EVENT_PATTERN`
      ).toBe(false);
    }
  });
});

// ── Prefix-family invariant ───────────────────────────────────────────────────
// Mathematical proof: any name starting with "github." or "linear." can never:
//   1. start with "filter." or "broker.daemon" (isBrokerProtectedName prefix check), or
//   2. equal "session.heartbeat" (isBrokerProtectedName exact check), or
//   3. match PHASE_EVENT_PATTERN (which requires the "phase." prefix).
//
// This means the per-name representative test above suffices for today's names,
// and any future github.*/linear.* event is automatically safe — no test update
// needed for new names within these families.

describe("orch-monitor prefix-family invariant", () => {
  const PRODUCER_PREFIXES = ["github.", "linear.", "catalyst.service."];

  test("producer prefixes never start with a forbidden prefix", () => {
    const FORBIDDEN = ["filter.", "broker.daemon"];
    for (const prod of PRODUCER_PREFIXES) {
      for (const forbidden of FORBIDDEN) {
        // A name with this producer prefix can only collide if the producer
        // prefix itself starts with the forbidden prefix (or vice versa).
        const overlap =
          prod.startsWith(forbidden) || forbidden.startsWith(prod.slice(0, forbidden.length));
        expect(overlap).toBe(false);
      }
    }
  });

  test("producer prefixes never equal the protected exact name", () => {
    for (const prod of PRODUCER_PREFIXES) {
      // "session.heartbeat" does not start with any producer prefix.
      expect("session.heartbeat".startsWith(prod)).toBe(false);
    }
  });

  test("producer prefixes never match PHASE_EVENT_PATTERN", () => {
    // PHASE_EVENT_PATTERN requires the literal string to start with "phase.".
    // None of the producer prefixes start with "phase.", so no name in these
    // families can match PHASE_EVENT_PATTERN.
    for (const prod of PRODUCER_PREFIXES) {
      expect(prod.startsWith("phase.")).toBe(false);
      expect("phase.".startsWith(prod)).toBe(false);
    }
  });
});
