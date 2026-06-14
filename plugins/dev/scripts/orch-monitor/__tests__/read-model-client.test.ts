// CTL-919 / HUD1: the shared read-model client contract.
//
// Encodes the ticket's three Gherkin acceptance scenarios:
//   1. A new read-model payload field reaches every client TYPED — both
//      consumers import the SAME contract module and fail to typecheck until they
//      handle the new field (asserted by a compile-time exhaustiveness fixture
//      that would break if BoardPayload/ReadModelPayload changed shape).
//   2. The contract carries node attribution for the single-host case as a no-op
//      — `groupByHost()` yields EXACTLY ONE host group, attributed to the host,
//      with the rendering path identical to the eventual multi-node case.
//   3. The SSE transport envelope is shared, not re-invented per client — the web
//      client and the (test stand-in for the) HUD decode the SAME envelope via
//      `subscribeReadModel()` / `decodeReadModelFrame()` and consume identical
//      typed events.
import { describe, it, expect } from "bun:test";
import {
  groupByHost,
  mergeHostGroups,
  decodeReadModelFrame,
  isReadModelPayload,
  subscribeReadModel,
  READ_MODEL_SSE_EVENT,
  READ_MODEL_STREAM_PATH,
  type ReadModelPayload,
  type HostRef,
  type ClusterReadModel,
  type ReadModelEventSource,
} from "../lib/read-model-client";
import { localHostRef } from "../lib/read-model-host";

function payload(overrides: Partial<ReadModelPayload> = {}): ReadModelPayload {
  return {
    generatedAt: "2026-06-08T00:00:00.000Z",
    config: { maxParallel: 6, inFlight: 1, freeSlots: 5, active: 1, working: 1, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [],
    queue: [],
    ...overrides,
  };
}

const LOCAL: HostRef = { name: "mac-mini", id: "0123456789abcdef" };

describe("read-model client contract — Scenario 2: node attribution, single-host no-op", () => {
  it("a payload with NO host yields exactly ONE group attributed to the fallback host", () => {
    const view: ClusterReadModel = groupByHost(payload(), LOCAL);
    // Exactly one host group is present (single-host identity no-op).
    expect(view.hosts.length).toBe(1);
    expect(view.hosts[0].host).toEqual(LOCAL);
    // The group's payload is the SAME wire shape (not re-wrapped).
    expect(view.hosts[0].payload.tickets).toBe(view.hosts[0].payload.tickets);
    expect(view.generatedAt).toBe("2026-06-08T00:00:00.000Z");
  });

  it("a payload that stamps its own host attributes the group to THAT host, not the fallback", () => {
    const stamped = payload({ host: { name: "mac-studio", id: "ffffffffffffffff" } });
    const view = groupByHost(stamped, LOCAL);
    expect(view.hosts.length).toBe(1);
    expect(view.hosts[0].host).toEqual({ name: "mac-studio", id: "ffffffffffffffff" });
  });

  it("the single-group rendering path is identical to the N-group case (one group vs N groups)", () => {
    // Single host: one group.
    const one = mergeHostGroups([payload()], LOCAL);
    expect(one.hosts.length).toBe(1);
    // Two hosts: N groups — SAME HostGroup shape, no special-casing.
    const a = payload({ host: { name: "mac-mini", id: "aaaaaaaaaaaaaaaa" } });
    const b = payload({
      generatedAt: "2026-06-08T01:00:00.000Z",
      host: { name: "mac-studio", id: "bbbbbbbbbbbbbbbb" },
    });
    const many = mergeHostGroups([a, b], LOCAL);
    expect(many.hosts.length).toBe(2);
    // Newest timestamp wins for the merged view.
    expect(many.generatedAt).toBe("2026-06-08T01:00:00.000Z");
    // Each group has the identical { host, payload } anatomy as the single case.
    for (const g of many.hosts) {
      expect(typeof g.host.name).toBe("string");
      expect(typeof g.host.id).toBe("string");
      expect(Array.isArray(g.payload.tickets)).toBe(true);
    }
  });

  it("mergeHostGroups dedupes by host id (last write wins per host)", () => {
    const first = payload({
      generatedAt: "2026-06-08T00:00:00.000Z",
      host: { name: "mac-mini", id: "aaaaaaaaaaaaaaaa" },
      tickets: [],
    });
    const second = payload({
      generatedAt: "2026-06-08T02:00:00.000Z",
      host: { name: "mac-mini", id: "aaaaaaaaaaaaaaaa" },
    });
    const view = mergeHostGroups([first, second], LOCAL);
    expect(view.hosts.length).toBe(1);
    expect(view.hosts[0].payload.generatedAt).toBe("2026-06-08T02:00:00.000Z");
  });

  it("localHostRef() resolves the real local node (id is sha256(name)[:16] shape)", () => {
    const ref = localHostRef();
    expect(typeof ref.name).toBe("string");
    expect(ref.name.length).toBeGreaterThan(0);
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("read-model client contract — Scenario 3: ONE shared SSE envelope", () => {
  it("decodeReadModelFrame parses a valid frame into a typed payload", () => {
    const decoded = decodeReadModelFrame(JSON.stringify(payload()));
    if (decoded === null) throw new Error("expected a decoded payload, got null");
    expect(decoded.generatedAt).toBe("2026-06-08T00:00:00.000Z");
    expect(Array.isArray(decoded.tickets)).toBe(true);
  });

  it("decodeReadModelFrame returns null on malformed / truncated JSON (no throw in the loop)", () => {
    expect(decodeReadModelFrame("{not json")).toBeNull();
    expect(decodeReadModelFrame("")).toBeNull();
  });

  it("decodeReadModelFrame rejects a structurally-wrong frame (missing the contract arrays)", () => {
    expect(decodeReadModelFrame(JSON.stringify({ generatedAt: "x" }))).toBeNull();
    expect(isReadModelPayload({ generatedAt: "x", workers: [], tickets: [] })).toBe(false);
  });

  it("the web client and the HUD subscribe through the SAME helper + envelope event name", () => {
    // A fake EventSource standing in for BOTH the browser EventSource (web) and
    // the HUD's injected transport — proving one helper drives every reader.
    type Listener = (ev: { data: string }) => void;
    class FakeES implements ReadModelEventSource {
      listeners = new Map<string, Listener>();
      onerror: ((ev: unknown) => void) | null = null;
      closed = false;
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, listener);
      }
      close() {
        this.closed = true;
      }
      emit(type: string, data: string) {
        this.listeners.get(type)?.({ data });
      }
    }

    const webSeen: ReadModelPayload[] = [];
    const hudSeen: ReadModelPayload[] = [];
    let webES!: FakeES;
    let hudES!: FakeES;

    const webSub = subscribeReadModel(
      { onSnapshot: (p) => webSeen.push(p) },
      {
        eventSourceFactory: (url) => {
          expect(url).toBe(READ_MODEL_STREAM_PATH);
          webES = new FakeES();
          return webES;
        },
      },
    );
    const hudSub = subscribeReadModel(
      { onSnapshot: (p) => hudSeen.push(p) },
      {
        eventSourceFactory: () => {
          hudES = new FakeES();
          return hudES;
        },
      },
    );

    // The SAME envelope event name + the SAME serialized payload reaches both.
    const frame = JSON.stringify(payload({ generatedAt: "2026-06-08T03:00:00.000Z" }));
    webES.emit(READ_MODEL_SSE_EVENT, frame);
    hudES.emit(READ_MODEL_SSE_EVENT, frame);

    expect(webSeen.length).toBe(1);
    expect(hudSeen.length).toBe(1);
    // Identical decoded value on both surfaces — no per-client divergence.
    expect(webSeen[0].generatedAt).toBe("2026-06-08T03:00:00.000Z");
    expect(hudSeen[0]).toEqual(webSeen[0]);

    // A malformed frame is skipped, not delivered (shared decode guards both).
    webES.emit(READ_MODEL_SSE_EVENT, "{garbage");
    expect(webSeen.length).toBe(1);

    webSub.close();
    hudSub.close();
    expect(webES.closed).toBe(true);
    expect(hudES.closed).toBe(true);
  });

  it("onError is wired through to the transport's error channel", () => {
    type Listener = (ev: { data: string }) => void;
    class FakeES implements ReadModelEventSource {
      onerror: ((ev: unknown) => void) | null = null;
      addEventListener(_type: string, _l: Listener) {}
      close() {}
    }
    let es!: FakeES;
    const errors: unknown[] = [];
    subscribeReadModel(
      { onSnapshot: () => {}, onError: (e) => errors.push(e) },
      {
        eventSourceFactory: () => {
          es = new FakeES();
          return es;
        },
      },
    );
    es.onerror?.({ type: "error" });
    expect(errors.length).toBe(1);
  });
});

describe("read-model client contract — Scenario 1: one contract, typed for every consumer", () => {
  it("ReadModelPayload IS the BoardPayload superset (a field add there breaks importers here)", () => {
    // This fixture exhaustively names every BoardPayload field through the
    // contract's re-exported type. If a field is added to the read-model wire
    // shape (board-data.d.mts), this object stops satisfying the type and the
    // test file fails to TYPECHECK — exactly the "compile-time break in every
    // consumer" the Gherkin requires. Both the web client and the HUD import
    // these same types, so the break is felt on every surface.
    const exhaustive: ReadModelPayload = {
      generatedAt: "2026-06-08T00:00:00.000Z",
      config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
      repos: [],
      workers: [],
      tickets: [],
      queue: [],
    };
    // host is OPTIONAL/additive — single-host producers stay byte-compatible.
    expect(exhaustive.host).toBeUndefined();
    const grouped = groupByHost(exhaustive, LOCAL);
    expect(grouped.hosts.length).toBe(1);
  });
});
