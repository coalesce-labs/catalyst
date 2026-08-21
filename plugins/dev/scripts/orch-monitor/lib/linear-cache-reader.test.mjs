// linear-cache-reader.test.mjs — CTC-133 Phase 2: replica-first fact reads
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/linear-cache-reader.test.mjs

import { describe, test, expect } from "bun:test";
import { readLinearCache } from "./linear-cache-reader.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

/** A minimal ticket_state row (all fields readLinearCache currently consumes). */
function tsRow(overrides = {}) {
  return {
    priority: 3,
    estimate: 1,
    project: null,
    labels: ["old-label"],
    relations: null,
    assignee: "alice",
    linearState: "Implement",
    title: null,
    ownerHost: "mini",
    generation: 7,
    fencePhase: "verify",
    claimedAt: "2026-08-20T00:00:00Z",
    heldSince: null,
    ...overrides,
  };
}

/** A minimal replica details row (shape returned by details() in replica-read). */
function repRow(overrides = {}) {
  return {
    title: "Replica title",
    description: null,
    labels: [{ name: "replica-label", color: "#abc" }],
    state: { name: "PR", type: "started" },
    priority: 1,
    estimate: 5,
    project: "IGNORED-project",
    relations: null,
    ...overrides,
  };
}

// ── readLinearCache replica-first (CTC-133 Phase 2) ──────────────────────────

describe("readLinearCache replica-first (CTC-133 Phase 2)", () => {
  test("fills title/estimate/labels/priority/linearState from replica when available", async () => {
    const ticketStateReader = async () => ({ "CTL-1": tsRow({ title: null, linearState: "Implement", priority: 3, estimate: 1, labels: ["old-label"] }) });
    const eligibleReader = async () => ({});
    const replicaReader = async () => ({ "CTL-1": repRow({ title: "Replica title", estimate: 5, priority: 1, labels: [{ name: "replica-label", color: "#abc" }], state: { name: "PR", type: "started" } }) });

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    const row = result["CTL-1"];
    expect(row.title).toBe("Replica title");
    expect(row.estimate).toBe(5);
    expect(row.priority).toBe(1);
    expect(row.linearState).toBe("PR");
    // labels from replica are normalized to name strings
    expect(row.labels).toEqual(["replica-label"]);
  });

  test("still fills project from eligible/*.json (replica project field is ignored)", async () => {
    const ticketStateReader = async () => ({ "CTL-2": tsRow({ project: null }) });
    const eligibleReader = async () => ({ "CTL-2": { project: "My Project", priority: 2 } });
    const replicaReader = async () => ({ "CTL-2": repRow({ project: "IGNORED" }) });

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    // eligible is the sole source for project — replica.project must NOT win
    expect(result["CTL-2"].project).toBe("My Project");
  });

  test("falls back to ticket_state facts when replica returns a miss (absent id)", async () => {
    const ticketStateReader = async () => ({
      "CTL-3": tsRow({ priority: 2, estimate: 5, labels: ["needs-human"], linearState: "Stuck" }),
    });
    const eligibleReader = async () => ({});
    const replicaReader = async () => ({}); // miss — CTL-3 not in replica result

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    expect(result["CTL-3"].priority).toBe(2);
    expect(result["CTL-3"].estimate).toBe(5);
    expect(result["CTL-3"].labels).toEqual(["needs-human"]);
    expect(result["CTL-3"].linearState).toBe("Stuck");
  });

  test("replica failure (thrown) falls back gracefully to ticket_state", async () => {
    const ticketStateReader = async () => ({
      "CTL-4": tsRow({ priority: 1, estimate: 2, labels: ["stale"], linearState: "Plan" }),
    });
    const eligibleReader = async () => ({});
    const replicaReader = async () => { throw new Error("db locked"); };

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    expect(result["CTL-4"].linearState).toBe("Plan");
    expect(result["CTL-4"].priority).toBe(1);
    expect(result["CTL-4"].estimate).toBe(2);
  });

  test("fence/ownership data is preserved from ticket_state even when replica has data", async () => {
    const ticketStateReader = async () => ({
      "CTL-5": tsRow({ ownerHost: "mini", generation: 12, fencePhase: "implement", claimedAt: "2026-08-20T01:00:00Z", heldSince: "2026-08-20T01:30:00Z" }),
    });
    const eligibleReader = async () => ({});
    const replicaReader = async () => ({ "CTL-5": repRow() });

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    expect(result["CTL-5"].ownerHost).toBe("mini");
    expect(result["CTL-5"].generation).toBe(12);
    expect(result["CTL-5"].fencePhase).toBe("implement");
    expect(result["CTL-5"].heldSince).toBe("2026-08-20T01:30:00Z");
  });

  test("tickets in eligible but not ticket_state are enriched by replica", async () => {
    const ticketStateReader = async () => ({});
    const eligibleReader = async () => ({ "CTL-6": { project: "Q3", priority: 2 } });
    const replicaReader = async () => ({
      "CTL-6": repRow({ title: "Queued ticket", estimate: 3, priority: 4, labels: [{ name: "queued-label", color: "#def" }] }),
    });

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    expect(result["CTL-6"]).toBeDefined();
    expect(result["CTL-6"].title).toBe("Queued ticket");
    expect(result["CTL-6"].project).toBe("Q3"); // from eligible
    expect(result["CTL-6"].estimate).toBe(3);
    expect(result["CTL-6"].labels).toEqual(["queued-label"]);
  });

  test("replica labels with name strings (not objects) are preserved as-is", async () => {
    const ticketStateReader = async () => ({ "CTL-7": tsRow({ labels: [] }) });
    const eligibleReader = async () => ({});
    const replicaReader = async () => ({
      "CTL-7": repRow({ labels: ["string-label-a", "string-label-b"] }),
    });

    const result = await readLinearCache({ ticketStateReader, eligibleReader, replicaReader });
    expect(result["CTL-7"].labels).toEqual(["string-label-a", "string-label-b"]);
  });

  test("no replicaReader provided — behaves identically to pre-Phase-2 (backward compat)", async () => {
    const ticketStateReader = async () => ({ "CTL-8": tsRow({ linearState: "Verify" }) });
    const eligibleReader = async () => ({});
    // no replicaReader — should use default (file-absent → {} in real env)

    const result = await readLinearCache({ ticketStateReader, eligibleReader });
    // Only thing we can assert without a real DB: it doesn't throw and ticket_state data comes through
    expect(result["CTL-8"]).toBeDefined();
    expect(result["CTL-8"].linearState).toBe("Verify");
  });
});
