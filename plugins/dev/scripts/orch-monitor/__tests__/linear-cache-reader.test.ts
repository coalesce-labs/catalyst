// CTL-883: the read-model's Linear enrichment reads ONLY from durable caches
// (filter-state.db ticket_state + the eligible projections) and NEVER shells
// out to `linearis`. These tests drive readLinearCache with injected readers
// (pure) plus one end-to-end pass against a real temp filter-state.db to prove
// the broker-state bulk read path.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLinearCache, readReplicaTitles } from "../lib/linear-cache-reader.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
  upsertTicketFence,
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
      // ticket_state has no title column → honest null with no eligible row (BFF9)
      title: null,
      // BFF10/BFF2: no fence observed → all node-grouping fields honest null.
      ownerHost: null,
      generation: null,
      fencePhase: null,
      claimedAt: null,
      heldSince: null,
    });
  });

  it("surfaces title from the eligible projection (BFF9 — for the cache-backed /api/linear)", async () => {
    const ticketStateReader = () =>
      Promise.resolve({ "CTL-3": { priority: 2, labels: [], linearState: "PR" } });
    const eligibleReader = () =>
      Promise.resolve({ "CTL-3": { title: "Retire legacy linearis poller" } });
    const byId = await readLinearCache({ ticketStateReader, eligibleReader });
    // ticket_state owns state/priority, eligible owns the title.
    expect(byId["CTL-3"].linearState).toBe("PR");
    expect(byId["CTL-3"].title).toBe("Retire legacy linearis poller");
  });

  it("surfaces ownerHost + generation from the ticket_state fence projection (BFF10/BFF11)", async () => {
    // The broker projects the catalyst://fence attachment into ticket_state
    // (BFF11). readLinearCache hands ownerHost + generation to board-data so the
    // node-aware surfaces and the fence-aware web mutations read them from the
    // cache, never a live attachment fetch.
    const ticketStateReader = () =>
      Promise.resolve({
        "CTL-9": {
          priority: 2,
          labels: [],
          linearState: "Implement",
          ownerHost: "mac-mini",
          generation: 3,
        },
      });
    const byId = await readLinearCache({
      ticketStateReader,
      eligibleReader: () => Promise.resolve({}),
    });
    expect(byId["CTL-9"].ownerHost).toBe("mac-mini");
    expect(byId["CTL-9"].generation).toBe(3);
  });

  it("ownerHost/generation default to null when the fence projection is absent", async () => {
    const byId = await readLinearCache({
      ticketStateReader: () => Promise.resolve({ "CTL-10": { labels: [] } }),
      eligibleReader: () => Promise.resolve({ "CTL-10": { title: "queued" } }),
    });
    // the eligible projection carries no fence data — honest null, never fabricated.
    expect(byId["CTL-10"].ownerHost).toBeNull();
    expect(byId["CTL-10"].generation).toBeNull();
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

  // CTL-884 (BFF2): the read-model groups by owner_host, which BFF11 projects
  // into ticket_state. The enrichment map must surface that durable grouping key
  // (+ the fence companions) so the cluster view never does a live attachment
  // fetch. Null when no fence has been observed — never fabricated.
  it("surfaces ownerHost + fence companions from ticket_state (the BFF11 projection)", async () => {
    const ticketStateReader = () =>
      Promise.resolve({
        "CTL-1": {
          priority: 2,
          labels: ["feature"],
          linearState: "Implement",
          ownerHost: "mini",
          generation: 3,
          fencePhase: "implement",
          claimedAt: "2026-06-08T11:00:00.000Z",
          heldSince: "2026-06-08T10:00:00.000Z",
        },
      });
    const byId = await readLinearCache({
      ticketStateReader,
      eligibleReader: () => Promise.resolve({}),
    });
    expect(byId["CTL-1"].ownerHost).toBe("mini");
    expect(byId["CTL-1"].generation).toBe(3);
    expect(byId["CTL-1"].fencePhase).toBe("implement");
    expect(byId["CTL-1"].claimedAt).toBe("2026-06-08T11:00:00.000Z");
    expect(byId["CTL-1"].heldSince).toBe("2026-06-08T10:00:00.000Z");
  });

  it("ownerHost + fence companions degrade to null when no fence is in the cache", async () => {
    const byId = await readLinearCache({
      ticketStateReader: () => Promise.resolve({ "CTL-2": { priority: 1, labels: [] } }),
      eligibleReader: () => Promise.resolve({}),
    });
    expect(byId["CTL-2"].ownerHost).toBeNull();
    expect(byId["CTL-2"].generation).toBeNull();
    expect(byId["CTL-2"].fencePhase).toBeNull();
    expect(byId["CTL-2"].claimedAt).toBeNull();
    expect(byId["CTL-2"].heldSince).toBeNull();
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
    // openBrokerStateDb is a module-level singleton that IGNORES dbPath when a
    // handle is already open — earlier test files that exercise server endpoints
    // (cluster-signal-endpoints, cross-node-stream-endpoint) leave one open, so
    // reset it first or the fixtures below land in the wrong (torn-down) db.
    closeBrokerStateDb();
    openBrokerStateDb(dbPath);
    upsertTicketDescriptor({
      ticket: "CTL-100",
      state: "Implement",
      priority: 2,
      labels: ["monitor", "feature"],
      assignee: "uuid-a",
    });
    upsertTicketDescriptor({ ticket: "CTL-101", state: "Done", uuid: "u-101" });
    // BFF10/BFF11 + CTL-884 (BFF2): project a fence attachment so the e2e proves
    // ownerHost + generation + the fence companions (phase/claimedAt) flow from
    // ticket_state through the bulk descriptor read — the durable owner_host
    // grouping key the cluster view reads (never a live attachment fetch).
    upsertTicketFence({
      ticket: "CTL-100",
      ownerHost: "mini",
      generation: 2,
      phase: "implement",
      claimedAt: "2026-06-08T11:30:00.000Z",
    });
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
    // CTL-884: the durable owner_host grouping key flows through the real DB.
    expect(byId["CTL-100"].ownerHost).toBe("mini");
    expect(byId["CTL-100"].generation).toBe(2);
    expect(byId["CTL-100"].fencePhase).toBe("implement");
    expect(byId["CTL-100"].claimedAt).toBe("2026-06-08T11:30:00.000Z");
    // CTL-101 has no fence → null grouping key (groups under "unassigned")
    expect(byId["CTL-101"].ownerHost).toBeNull();
    // queued ticket only in the eligible projection
    expect(byId["CTL-200"].priority).toBe(3);
    expect(byId["CTL-200"].project).toBe("Web UI");
    expect(byId["CTL-200"].title).toBe("queued"); // BFF9: title from eligible
    // BFF10/BFF11: the fence projection flows through the real bulk descriptor read.
    expect(byId["CTL-101"].generation).toBeNull();
  });
});

// CTL-1372: the board's CTC-replica title source. readReplicaTitles is driven with
// an INJECTED reader factory so the contract is exercised offline (no real
// catalyst-replica.db) — when a factory is injected the file-presence gate is
// skipped (the fake reader IS the DB).
describe("readReplicaTitles (CTL-1372 — board title source from the CTC replica)", () => {
  // A fake reader that records the ids it was asked for and serves a fixed map.
  function fakeFactory(map: Record<string, string>, spy?: { ids?: string[]; closed?: boolean }) {
    return (_opts: { dbPath: string }) => ({
      titles(ids: string[]) {
        if (spy) spy.ids = ids;
        const out: Record<string, string> = {};
        for (const id of ids) if (map[id]) out[id] = map[id];
        return out;
      },
      close() {
        if (spy) spy.closed = true;
      },
    });
  }

  it("returns the replica title map for the requested ids (parked ticket → real title)", async () => {
    const map = { "CTL-1214": "Slim .catalyst/config.json down to the essentials" };
    const titles = await readReplicaTitles({
      ids: ["CTL-1214"],
      readerFactory: fakeFactory(map),
    });
    expect(titles["CTL-1214"]).toBe("Slim .catalyst/config.json down to the essentials");
  });

  it("de-dupes ids, passes the wanted set to the reader, and closes the handle", async () => {
    const spy: { ids?: string[]; closed?: boolean } = {};
    const map = { "CTL-1": "one", "ADV-2": "two" };
    const titles = await readReplicaTitles({
      ids: ["CTL-1", "CTL-1", "ADV-2", ""], // dup CTL-1 + a falsy "" to drop
      readerFactory: fakeFactory(map, spy),
    });
    expect(titles).toEqual({ "CTL-1": "one", "ADV-2": "two" });
    expect(spy.ids).toEqual(["CTL-1", "ADV-2"]); // de-duped + falsy dropped
    expect(spy.closed).toBe(true); // handle always released
  });

  it("empty / non-array ids → {} without invoking the reader", async () => {
    let called = false;
    const factory = () => {
      called = true;
      return { titles: () => ({}) };
    };
    expect(await readReplicaTitles({ ids: [], readerFactory: factory })).toEqual({});
    expect(await readReplicaTitles({ ids: undefined, readerFactory: factory })).toEqual({});
    expect(called).toBe(false);
  });

  it("fails OPEN to {} when the reader throws (replica unreadable → existing chain preserved)", async () => {
    const factory = () => ({
      titles() {
        throw new Error("replica db corrupt");
      },
    });
    const titles: Record<string, string> | "THREW" = await readReplicaTitles({
      ids: ["CTL-1"],
      readerFactory: factory,
    }).catch(() => "THREW" as const);
    expect(titles).not.toBe("THREW"); // never leaks the throw
    expect(titles).toEqual({}); // fail-open empty map
  });

  it("fails OPEN to {} when a non-existent replica path is used (file-presence gate)", async () => {
    // No readerFactory → the real computed-specifier import path runs, but the
    // file-presence gate short-circuits on an absent path (never opens/throws).
    const titles = await readReplicaTitles({
      ids: ["CTL-1"],
      dbPath: "/nonexistent/catalyst-replica.db",
    });
    expect(titles).toEqual({});
  });
});
