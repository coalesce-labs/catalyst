// CTL-883: unit tests for the generalized cache-backed read-model core. Pure
// logic — the real assembleBoard() is injected with a fake, so no fs /
// subprocess / server. Encodes the ticket's Gherkin acceptance scenarios:
//   • "assembles once and fans out to many clients" (adding a client does not
//      multiply the assemble cost)
//   • "is its own module with a clean interface" (named-entity projection off a
//      single snapshot; routes/HUD consume the interface, not the internals)
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createReadModel } from "../lib/read-model.mjs";
import type {
  BoardPayload,
  BoardWorker,
  BoardTicket,
  BoardQueueItem,
} from "../lib/board-data.mjs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "read-model-"));

function worker(ticket: string): BoardWorker {
  return {
    name: `${ticket} implement`,
    ticket,
    tickets: [ticket],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 0,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 0,
    costUSD: null,
    sessionId: "sess-1",
    startedAt: null,
    pid: null,
    catalystSessionId: null,
    host: null,
    generation: null,
  };
}

function ticket(id: string): BoardTicket {
  return {
    id,
    title: id,
    type: "task",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 0,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "",
    held: null,
    blockers: [],
    // CTL-901 (HOME3): per-row duration anchors (null in this fixture).
    heldSince: null,
    currentPhaseSince: null,
    attention: null,
    attentionSince: null,
    host: null,
    generation: null,
  };
}

function queueItem(id: string): BoardQueueItem {
  return {
    id,
    title: id,
    priority: 0,
    createdAt: "",
    state: null,
    repo: "catalyst",
    team: "CTL",
    rank: 1,
    estimate: null,
    scope: null,
    project: null,
    host: null,
  };
}

function fakePayload(inFlight: number): BoardPayload {
  return {
    generatedAt: new Date().toISOString(),
    config: { maxParallel: 6, inFlight, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [worker("CTL-1")],
    tickets: [ticket("CTL-1"), ticket("CTL-2")],
    queue: [queueItem("CTL-3")],
  };
}

describe("read-model core (CTL-883)", () => {
  it("getSnapshot computes once and caches within the on-demand TTL", async () => {
    let calls = 0;
    const m = createReadModel({
      assemble: () => {
        calls++;
        return Promise.resolve(fakePayload(calls));
      },
      onDemandTtlMs: 1000,
      workersDir: tmp(),
    });
    const a = await m.getSnapshot();
    const b = await m.getSnapshot();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    m.stop();
  });

  it("assembles ONCE and fans the same snapshot out to many subscribers", async () => {
    let calls = 0;
    const m = createReadModel({
      assemble: () => {
        calls++;
        return Promise.resolve(fakePayload(calls));
      },
      debounceMs: 10,
      pollMs: 1_000_000, // disable poll for determinism
      workersDir: tmp(),
    });
    // three clients: web tab, iPad, HUD
    const seen: Record<string, BoardPayload[]> = { web: [], ipad: [], hud: [] };
    const u1 = m.subscribe((s) => seen.web.push(s));
    const u2 = m.subscribe((s) => seen.ipad.push(s));
    const u3 = m.subscribe((s) => seen.hud.push(s));
    expect(m.subscriberCount).toBe(3);
    await sleep(40);
    // ONE assemble served all three (adding clients did not multiply the cost)
    expect(calls).toBe(1);
    expect(seen.web.length).toBe(1);
    expect(seen.ipad.length).toBe(1);
    expect(seen.hud.length).toBe(1);
    // the SAME object reference reached every subscriber (single source)
    expect(seen.web[0]).toBe(seen.ipad[0]);
    expect(seen.ipad[0]).toBe(seen.hud[0]);
    u1();
    u2();
    u3();
    m.stop();
  });

  it("clean interface: getEntity projects named slices off ONE snapshot", async () => {
    let calls = 0;
    const m = createReadModel({
      assemble: () => {
        calls++;
        return Promise.resolve(fakePayload(1));
      },
      onDemandTtlMs: 5000,
      workersDir: tmp(),
    });
    expect(m.entityNames).toEqual(["board", "tickets", "workers", "queue"]);
    const tickets = (await m.getEntity("tickets")) as unknown[];
    const workers = (await m.getEntity("workers")) as unknown[];
    const queue = (await m.getEntity("queue")) as unknown[];
    const board = (await m.getEntity("board")) as { tickets: unknown[] };
    expect(tickets.length).toBe(2);
    expect(workers.length).toBe(1);
    expect(queue.length).toBe(1);
    expect(board.tickets.length).toBe(2);
    // all four entity reads were served from a SINGLE assemble (TTL-cached)
    expect(calls).toBe(1);
    m.stop();
  });

  it("getEntity throws on an unknown entity name (typo surfaces, not null)", async () => {
    const m = createReadModel({
      assemble: () => Promise.resolve(fakePayload(1)),
      workersDir: tmp(),
    });
    let err: unknown;
    try {
      await m.getEntity("nope");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/unknown entity/);
    m.stop();
  });

  it("stops the reactive loop when the last subscriber leaves", () => {
    const m = createReadModel({
      assemble: () => Promise.resolve(fakePayload(0)),
      pollMs: 1_000_000,
      workersDir: tmp(),
    });
    const unsub = m.subscribe(() => {});
    expect(m.subscriberCount).toBe(1);
    unsub();
    expect(m.subscriberCount).toBe(0);
    m.stop();
  });

  it("a throwing subscriber does not break delivery to the others", async () => {
    let good = 0;
    const m = createReadModel({
      assemble: () => Promise.resolve(fakePayload(1)),
      debounceMs: 10,
      pollMs: 1_000_000,
      workersDir: tmp(),
    });
    m.subscribe(() => {
      throw new Error("boom");
    });
    m.subscribe(() => {
      good++;
    });
    await sleep(40);
    expect(good).toBeGreaterThanOrEqual(1);
    m.stop();
  });

  it("custom entity registration extends the model without touching the push core", async () => {
    const m = createReadModel({
      assemble: () => Promise.resolve(fakePayload(1)),
      workersDir: tmp(),
      entities: {
        board: { project: (s) => s },
        repoCount: { project: (s) => s.repos.length },
      },
    });
    expect(m.entityNames).toEqual(["board", "repoCount"]);
    expect(await m.getEntity("repoCount")).toBe(0);
    m.stop();
  });
});
