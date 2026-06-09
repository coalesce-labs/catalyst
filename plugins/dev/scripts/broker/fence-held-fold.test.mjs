// Unit tests for the CTL-923 (BFF11) fence + held-since write-through in
// foldLinearIssueDescriptor. Like the CTL-822 descriptor fold, this projection
// runs on the LIVE processEvent path with ZERO registered interests (above the
// `if (!interests.size) return` gate) so the durable cache stays current during
// idle periods. These tests drive processEvent directly for exactly that reason.
// Run: bun test plugins/dev/scripts/broker/fence-held-fold.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  getTicketDescriptor,
} from "./broker-state.mjs";
import { processEvent } from "./router.mjs";
import { clearInterests } from "./state.mjs";
import { heldFor } from "../orch-monitor/lib/board-data.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fence-held-fold-test-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests(); // ZERO interests is the load-bearing idle path
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function issueEvent(name, detail, ticket = detail.ticket) {
  return {
    event: name,
    attributes: ticket ? { "linear.issue.identifier": ticket } : {},
    detail,
  };
}

// ─── Scenario: Fence metadata lands in the durable cache ─────────────────────

describe("fence projection via processEvent", () => {
  test("a fence-bearing issue event projects owner_host/generation/phase/claimed_at", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-845",
        toState: "Implement",
        toFence: {
          owner_host: "mac-mini",
          catalyst_generation: 3,
          phase: "implement",
          claimed_at: "2026-06-08T10:00:00.000Z",
        },
      })
    );
    const d = getTicketDescriptor("CTL-845");
    expect(d.ownerHost).toBe("mac-mini");
    expect(d.generation).toBe(3);
    expect(d.fencePhase).toBe("implement");
    expect(d.claimedAt).toBe("2026-06-08T10:00:00.000Z");
    // the descriptor fold still ran alongside the fence fold
    expect(d.state).toBe("Implement");
  });

  test("the wire generation string coerces to a Number", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-846",
        toFence: { owner_host: "mac-mini", catalyst_generation: "5" },
      })
    );
    expect(getTicketDescriptor("CTL-846").generation).toBe(5);
  });

  test("the camelCase `fence` alias also projects", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-847",
        fence: { ownerHost: "mac-studio", generation: 2, claimedAt: "2026-06-08T01:00:00Z" },
      })
    );
    const d = getTicketDescriptor("CTL-847");
    expect(d.ownerHost).toBe("mac-studio");
    expect(d.generation).toBe(2);
    expect(d.claimedAt).toBe("2026-06-08T01:00:00Z");
  });

  test("a null fence clears the projection (release / takeover dropping owner)", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-848",
        toFence: { owner_host: "mac-mini", catalyst_generation: 1 },
      })
    );
    expect(getTicketDescriptor("CTL-848").ownerHost).toBe("mac-mini");
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-848", toFence: null }));
    expect(getTicketDescriptor("CTL-848").ownerHost).toBeNull();
    expect(getTicketDescriptor("CTL-848").generation).toBeNull();
  });

  test("an event with no fence key leaves the stored fence untouched", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-849",
        toFence: { owner_host: "mac-mini", catalyst_generation: 7 },
      })
    );
    processEvent(issueEvent("linear.issue.state_changed", { ticket: "CTL-849", toState: "PR" }));
    const d = getTicketDescriptor("CTL-849");
    expect(d.ownerHost).toBe("mac-mini"); // unknown → keep
    expect(d.generation).toBe(7);
    expect(d.state).toBe("PR");
  });
});

// ─── Scenario: Held-since timestamp is captured ──────────────────────────────

describe("held-since capture via processEvent", () => {
  test("a blocked label stamps held_since", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-850",
        toLabels: ["blocked"],
        heldSince: "2026-06-08T09:00:00.000Z",
      })
    );
    expect(getTicketDescriptor("CTL-850").heldSince).toBe("2026-06-08T09:00:00.000Z");
  });

  test("a waiting label stamps held_since too", () => {
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-851", toLabels: ["waiting"] }));
    expect(getTicketDescriptor("CTL-851").heldSince).toBeTruthy();
  });

  test("held_since is sticky across duplicate held webhooks", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-852",
        toLabels: ["blocked"],
        heldSince: "2026-06-08T09:00:00.000Z",
      })
    );
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-852",
        toLabels: ["blocked", "feature"],
        heldSince: "2026-06-08T11:00:00.000Z",
      })
    );
    expect(getTicketDescriptor("CTL-852").heldSince).toBe("2026-06-08T09:00:00.000Z");
  });

  test("losing the held labels clears held_since (pickup/unblock)", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-853",
        toLabels: ["blocked"],
        heldSince: "2026-06-08T09:00:00.000Z",
      })
    );
    expect(getTicketDescriptor("CTL-853").heldSince).toBeTruthy();
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-853", toLabels: ["feature"] }));
    expect(getTicketDescriptor("CTL-853").heldSince).toBeNull();
  });

  test("an explicitly empty label set clears held_since", () => {
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-854", toLabels: ["waiting"] }));
    expect(getTicketDescriptor("CTL-854").heldSince).toBeTruthy();
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-854", toLabels: [] }));
    expect(getTicketDescriptor("CTL-854").heldSince).toBeNull();
  });

  test("toLabels null (labels absent from payload) leaves held_since alone", () => {
    processEvent(
      issueEvent("linear.issue.updated", {
        ticket: "CTL-855",
        toLabels: ["blocked"],
        heldSince: "2026-06-08T09:00:00.000Z",
      })
    );
    processEvent(issueEvent("linear.issue.state_changed", { ticket: "CTL-855", toState: "PR" }));
    expect(getTicketDescriptor("CTL-855").heldSince).toBe("2026-06-08T09:00:00.000Z");
  });
});

// ─── Scenario: Absent data is honest ─────────────────────────────────────────

describe("absent data is honest", () => {
  test("a non-fence, non-held issue event leaves both null", () => {
    processEvent(
      issueEvent("linear.issue.updated", { ticket: "CTL-860", toState: "Todo", toLabels: ["feature"] })
    );
    const d = getTicketDescriptor("CTL-860");
    expect(d.ownerHost).toBeNull();
    expect(d.heldSince).toBeNull();
  });

  test("fence/held fold failure never breaks event processing (closed DB)", () => {
    closeBrokerStateDb();
    expect(() =>
      processEvent(
        issueEvent("linear.issue.updated", {
          ticket: "CTL-861",
          toFence: { owner_host: "mac-mini", catalyst_generation: 1 },
          toLabels: ["blocked"],
        })
      )
    ).not.toThrow();
    openBrokerStateDb(join(tmpDir, "test.db")); // re-open so afterEach close is balanced
  });
});

// ─── drift guard: broker held literals match the board's ─────────────────────

describe("held-label literals stay in lock-step with the board", () => {
  test("the broker stamps held_since for exactly the labels heldFor classifies", () => {
    // board-data heldFor is the read side; the broker fold is the write side —
    // both must agree on which labels mean "held" or the duration is mis-stamped.
    for (const label of ["blocked", "waiting"]) {
      expect(heldFor([label])).toBe(label);
    }
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-870", toLabels: ["blocked"] }));
    expect(getTicketDescriptor("CTL-870").heldSince).toBeTruthy();
    // a label heldFor does NOT classify must not stamp
    expect(heldFor(["feature"])).toBeNull();
    processEvent(issueEvent("linear.issue.updated", { ticket: "CTL-871", toLabels: ["feature"] }));
    expect(getTicketDescriptor("CTL-871").heldSince).toBeNull();
  });
});
