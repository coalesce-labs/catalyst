// CTL-889 (P8): unit tests for the cache-backed ticket-detail reader. Pure
// logic — the broker descriptor readers are injected, so no DB / fs / subprocess
// / live Linear call. Encodes the ticket's Gherkin acceptance scenarios:
//   • "Ticket detail comes from the durable cache" (description/labels/relations/
//      assignee/held read from filter-state.db, never a live `linearis` call)
//   • "Reverse relations and component labels light up" (reverse edges + labels
//      render from real cached data; nothing fabricated when a field is absent)
import { describe, it, expect } from "bun:test";
import {
  buildTicketDetail,
  readTicketDetail,
} from "../lib/ticket-detail-reader.mjs";
import type { TicketDescriptor } from "../../broker/broker-state.d.mts";

function descriptor(partial: Partial<TicketDescriptor>): TicketDescriptor {
  return {
    ticket: partial.ticket ?? "CTL-845",
    state: partial.state ?? null,
    prNumber: partial.prNumber ?? null,
    relations: partial.relations ?? null,
    labels: partial.labels ?? null,
    priority: partial.priority ?? null,
    estimate: partial.estimate ?? null,
    resolution: partial.resolution ?? null,
    assignee: partial.assignee ?? null,
    uuid: partial.uuid ?? null,
    removed: partial.removed ?? false,
    removedAt: partial.removedAt ?? null,
    // CTL-923 (BFF11): fence projection + held-since from the durable cache.
    ownerHost: partial.ownerHost ?? null,
    generation: partial.generation ?? null,
    fencePhase: partial.fencePhase ?? null,
    claimedAt: partial.claimedAt ?? null,
    heldSince: partial.heldSince ?? null,
    updatedAt: partial.updatedAt ?? "2026-06-08T12:00:00.000Z",
  };
}

describe("buildTicketDetail — cache-backed detail assembly (P8)", () => {
  it("returns labels, relations, assignee, state, held — all from the descriptor", () => {
    const d = descriptor({
      ticket: "CTL-845",
      state: "Implement",
      priority: 2,
      assignee: "user-uuid-1",
      labels: ["monitor", "feature", "blocked"],
      relations: [{ type: "blocks", id: "CTL-900" }],
    });
    const detail = buildTicketDetail("CTL-845", d, [d]);
    expect(detail).not.toBeNull();
    expect(detail!.ticket).toBe("CTL-845");
    expect(detail!.linearState).toBe("Implement");
    expect(detail!.priority).toBe(2);
    expect(detail!.assignee).toBe("user-uuid-1");
    expect(detail!.labels).toEqual(["monitor", "feature", "blocked"]);
    expect(detail!.relations.forward).toEqual([{ type: "blocks", id: "CTL-900" }]);
    // "blocked" label → held classification "blocked".
    expect(detail!.held).toBe("blocked");
    // provenance: cache, never live.
    expect(detail!.source).toBe("filter-state.db");
  });

  it("never fabricates the narrative or a held-since duration (honest null)", () => {
    const d = descriptor({ ticket: "CTL-845", labels: ["waiting"] });
    const detail = buildTicketDetail("CTL-845", d, [d])!;
    // The Linear narrative body is NOT in the durable cache → honest null.
    expect(detail.description).toBeNull();
    // No held-since timestamp column exists → honest null, never a fake "2h14m".
    expect(detail.heldSince).toBeNull();
    expect(detail.held).toBe("waiting");
  });

  it("computes REVERSE relation edges from sibling descriptors (the relation join)", () => {
    // CTL-900 declares it BLOCKS CTL-845 → from CTL-845's view CTL-900 is a
    // blocked_by edge. CTL-901 declares related to CTL-845 → symmetric.
    const target = descriptor({ ticket: "CTL-845" });
    const blocker = descriptor({
      ticket: "CTL-900",
      relations: [{ type: "blocks", id: "CTL-845" }],
    });
    const related = descriptor({
      ticket: "CTL-901",
      relations: [{ type: "related", id: "CTL-845" }],
    });
    const unrelated = descriptor({
      ticket: "CTL-902",
      relations: [{ type: "blocks", id: "CTL-999" }],
    });
    const detail = buildTicketDetail("CTL-845", target, [
      target,
      blocker,
      related,
      unrelated,
    ])!;
    expect(detail.relations.reverse).toContainEqual({
      type: "blocked_by",
      id: "CTL-900",
    });
    expect(detail.relations.reverse).toContainEqual({
      type: "related",
      id: "CTL-901",
    });
    // The unrelated ticket (points at CTL-999) is NOT a reverse edge here.
    expect(detail.relations.reverse).not.toContainEqual({
      type: "blocked_by",
      id: "CTL-902",
    });
  });

  it("renders dim (empty, never fabricated) when relation/label fields are absent", () => {
    const d = descriptor({ ticket: "CTL-845", relations: null, labels: null });
    const detail = buildTicketDetail("CTL-845", d, [d])!;
    expect(detail.relations.forward).toEqual([]);
    expect(detail.relations.reverse).toEqual([]);
    expect(detail.labels).toEqual([]);
    expect(detail.held).toBeNull();
  });

  it("returns null when the ticket has no descriptor row", () => {
    expect(buildTicketDetail("CTL-404", null, [])).toBeNull();
  });
});

describe("readTicketDetail — route-facing reader (P8)", () => {
  it("reads via injected descriptor readers (NO live Linear call)", async () => {
    const target = descriptor({
      ticket: "CTL-845",
      state: "Implement",
      labels: ["monitor"],
    });
    const blocker = descriptor({
      ticket: "CTL-900",
      relations: [{ type: "blocks", id: "CTL-845" }],
    });
    let descriptorCalls = 0;
    let allCalls = 0;
    const detail = await readTicketDetail("CTL-845", {
      descriptorReader: (t) => {
        descriptorCalls++;
        return t === "CTL-845" ? target : null;
      },
      allDescriptorsReader: () => {
        allCalls++;
        return [target, blocker];
      },
    });
    expect(descriptorCalls).toBe(1);
    expect(allCalls).toBe(1);
    expect(detail!.linearState).toBe("Implement");
    expect(detail!.relations.reverse).toContainEqual({
      type: "blocked_by",
      id: "CTL-900",
    });
  });

  it("returns null for an unknown ticket", async () => {
    const detail = await readTicketDetail("CTL-404", {
      descriptorReader: () => null,
      allDescriptorsReader: () => [],
    });
    expect(detail).toBeNull();
  });

  it("degrades to null (never throws) when a reader rejects", async () => {
    const detail = await readTicketDetail("CTL-845", {
      descriptorReader: () => {
        throw new Error("db locked");
      },
      allDescriptorsReader: () => [],
    });
    expect(detail).toBeNull();
  });
});
