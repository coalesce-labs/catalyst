// CTL-883: the read-model's Linear enrichment reads ONLY from durable caches
// (filter-state.db ticket_state + the eligible projections) and NEVER shells
// out to `linearis`. These tests drive readLinearCache with injected readers
// (pure) plus one end-to-end pass against a real temp filter-state.db to prove
// the broker-state bulk read path.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLinearCache } from "../lib/linear-cache-reader.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
} from "../../broker/broker-state.mjs";

describe("readLinearCache (CTL-883 — durable-cache Linear enrichment)", () => {
  it("reads priority/labels/relations/assignee/state from ticket_state, not a live call", async () => {
    const ticketStateReader = () =>
      Promise.resolve({
        "CTL-1": {
          priority: 2,
          labels: ["feature", "broker"],
          relations: [{ type: "blocks", id: "CTL-2" }],
          assignee: "uuid-bot",
          linearState: "Implement",
        },
      });
    const eligibleReader = () => Promise.resolve({});
    const byId = await readLinearCache({ ticketStateReader, eligibleReader });
    expect(byId["CTL-1"]).toEqual({
      priority: 2,
      estimate: null, // not in the durable cache → honest null, never refetched
      project: null,
      labels: ["feature", "broker"],
      relations: [{ type: "blocks", id: "CTL-2" }],
      assignee: "uuid-bot",
      linearState: "Implement",
    });
  });

  it("fills priority/project/relations from the eligible projection when ticket_state lacks them", async () => {
    const ticketStateReader = () => Promise.resolve({});
    const eligibleReader = () =>
      Promise.resolve({
        "ADV-9": { priority: 3, project: "Demo accounts", relations: { nodes: [] } },
      });
    const byId = await readLinearCache({ ticketStateReader, eligibleReader });
    expect(byId["ADV-9"].priority).toBe(3);
    expect(byId["ADV-9"].project).toBe("Demo accounts");
    expect(byId["ADV-9"].relations).toEqual({ nodes: [] });
    expect(byId["ADV-9"].labels).toEqual([]);
  });

  it("ticket_state wins over eligible for shared fields; eligible owns project", async () => {
    const ticketStateReader = () =>
      Promise.resolve({ "CTL-5": { priority: 1, labels: ["bug"], linearState: "Plan" } });
    const eligibleReader = () =>
      Promise.resolve({
        "CTL-5": { priority: 4, project: "Orchestrator", relations: { nodes: ["x"] } },
      });
    const byId = await readLinearCache({ ticketStateReader, eligibleReader });
    expect(byId["CTL-5"].priority).toBe(1); // ticket_state authoritative
    expect(byId["CTL-5"].project).toBe("Orchestrator"); // only eligible carries it
    expect(byId["CTL-5"].relations).toEqual({ nodes: ["x"] }); // ts had none → eligible
    expect(byId["CTL-5"].labels).toEqual(["bug"]);
  });

  it("priority defaults to 0 (Linear no-priority) when neither cache has it", async () => {
    const byId = await readLinearCache({
      ticketStateReader: () => Promise.resolve({ "CTL-7": { labels: [] } }),
      eligibleReader: () => Promise.resolve({}),
    });
    expect(byId["CTL-7"].priority).toBe(0);
  });

  it("serves cache unconditionally with the breaker OPEN — never blocks, never refetches", async () => {
    let calls = 0;
    const ticketStateReader = () => {
      calls++;
      return Promise.resolve({ "CTL-8": { priority: 2, labels: [], linearState: "PR" } });
    };
    const byId = await readLinearCache({
      ticketStateReader,
      eligibleReader: () => Promise.resolve({}),
      breakerOpen: true, // breaker open: must still return the cached value
    });
    expect(byId["CTL-8"].linearState).toBe("PR");
    expect(calls).toBe(1); // exactly one cache read, no extra live refresh attempt
  });

  it("degrades to empty enrichment when both caches are unavailable (no throw)", async () => {
    const byId = await readLinearCache({
      ticketStateReader: () => Promise.reject(new Error("db locked")),
      eligibleReader: () => Promise.reject(new Error("dir gone")),
    }).catch(() => "THREW");
    // The default readers swallow; here the injected ones throw, so the merge
    // sees rejected promises — assert the function does not leak the rejection
    // as a thrown error to the assemble loop.
    expect(byId).not.toBe("THREW");
  });
});

describe("readLinearCache end-to-end against a real filter-state.db", () => {
  let tmpDir: string;
  let dbPath: string;
  let eligibleDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "linear-cache-e2e-"));
    dbPath = join(tmpDir, "filter-state.db");
    eligibleDir = join(tmpDir, "eligible");
    mkdirSync(eligibleDir, { recursive: true });
    openBrokerStateDb(dbPath);
    upsertTicketDescriptor({
      ticket: "CTL-100",
      state: "Implement",
      priority: 2,
      labels: ["monitor", "feature"],
      assignee: "uuid-a",
    });
    upsertTicketDescriptor({ ticket: "CTL-101", state: "Done", uuid: "u-101" });
    closeBrokerStateDb(); // assemble path opens its own handle
    writeFileSync(
      join(eligibleDir, "CTL.json"),
      JSON.stringify([
        { identifier: "CTL-200", title: "queued", priority: 3, project: "Web UI" },
      ]),
    );
  });

  afterEach(() => {
    closeBrokerStateDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges the real ticket_state bulk read with the eligible projection", async () => {
    const byId = await readLinearCache({ dbPath, eligibleDir });
    expect(byId["CTL-100"].priority).toBe(2);
    expect(byId["CTL-100"].labels).toEqual(["monitor", "feature"]);
    expect(byId["CTL-100"].assignee).toBe("uuid-a");
    expect(byId["CTL-100"].linearState).toBe("Implement");
    // queued ticket only in the eligible projection
    expect(byId["CTL-200"].priority).toBe(3);
    expect(byId["CTL-200"].project).toBe("Web UI");
  });
});
