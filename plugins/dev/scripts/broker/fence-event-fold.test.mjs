// fence-event-fold.test.mjs — CTL-863: the broker folds standalone
// fence.claimed / fence.released events (emitted Linear-free by
// execution-core/fence-event.mjs) into ticket_state's fence columns. Like the
// CTL-923 fence-held fold, this runs on the LIVE processEvent path with ZERO
// registered interests (above the `if (!interests.size) return` gate) so the
// projection converges during idle periods. Drives processEvent directly.
// Run: bun test plugins/dev/scripts/broker/fence-event-fold.test.mjs

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
import { buildFenceEvent } from "../execution-core/fence-event.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fence-event-fold-test-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests(); // ZERO interests is the load-bearing idle path
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Parse the emitter's JSONL line back into the event object processEvent consumes.
const fenceEvent = (fields) => JSON.parse(buildFenceEvent(fields));

describe("fence.claimed folds into the ticket_state fence columns", () => {
  test("a fence.claimed event projects owner_host/generation/phase/claimed_at", () => {
    processEvent(
      fenceEvent({
        ticket: "CTL-1",
        action: "claimed",
        owner_host: "mini",
        generation: 3,
        phase: "implement",
        claimed_at: "2026-07-03T10:00:00Z",
      }),
    );
    const d = getTicketDescriptor("CTL-1");
    expect(d.ownerHost).toBe("mini");
    expect(d.generation).toBe(3);
    expect(d.fencePhase).toBe("implement");
    expect(d.claimedAt).toBe("2026-07-03T10:00:00Z");
  });

  test("a heartbeat re-emit (phase omitted → null) REFRESHES claimed_at but KEEPS the stored phase", () => {
    processEvent(
      fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 3, phase: "implement", claimed_at: "2026-07-03T10:00:00Z" }),
    );
    // The publisher re-emit carries no phase → payload.phase = null.
    processEvent(
      fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 3, claimed_at: "2026-07-03T10:02:00Z" }),
    );
    const d = getTicketDescriptor("CTL-1");
    expect(d.claimedAt).toBe("2026-07-03T10:02:00Z"); // refreshed
    expect(d.fencePhase).toBe("implement"); // NOT clobbered to null
  });
});

describe("fence.released clears the projection (OQ-F)", () => {
  test("a fence.released event nulls owner_host/generation/phase/claimed_at", () => {
    processEvent(
      fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 3, phase: "pr", claimed_at: "2026-07-03T10:00:00Z" }),
    );
    processEvent(fenceEvent({ ticket: "CTL-1", action: "released" }));
    const d = getTicketDescriptor("CTL-1");
    expect(d.ownerHost).toBeNull();
    expect(d.generation).toBeNull();
    expect(d.fencePhase).toBeNull();
    expect(d.claimedAt).toBeNull();
  });
});

describe("idempotence + race-freedom", () => {
  test("re-ingesting the same fence.claimed twice is idempotent", () => {
    const e = fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 4, phase: "verify", claimed_at: "2026-07-03T11:00:00Z" });
    processEvent(e);
    processEvent(e); // boot-replay / duplicate delivery
    const d = getTicketDescriptor("CTL-1");
    expect(d.ownerHost).toBe("mini");
    expect(d.generation).toBe(4);
    expect(d.fencePhase).toBe("verify");
  });

  test("a takeover bump (higher generation, new owner) overwrites the prior fence", () => {
    processEvent(fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 4, phase: "implement", claimed_at: "2026-07-03T11:00:00Z" }));
    processEvent(fenceEvent({ ticket: "CTL-1", action: "claimed", owner_host: "laptop", generation: 5, phase: "implement", claimed_at: "2026-07-03T11:05:00Z" }));
    const d = getTicketDescriptor("CTL-1");
    expect(d.ownerHost).toBe("laptop");
    expect(d.generation).toBe(5);
  });

  test("a malformed fence event never throws out of processEvent", () => {
    // ticket missing from both payload and attributes → projectFenceEvent bails.
    expect(() =>
      processEvent({ attributes: { "event.name": "fence.claimed." }, body: { payload: {} } }),
    ).not.toThrow();
  });
});
