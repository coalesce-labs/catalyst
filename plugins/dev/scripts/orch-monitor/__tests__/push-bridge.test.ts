// push-bridge.test.ts — CTL-1167 phase 5 unit tests.
// Drive createPushBridge with an injected send spy — no real Web Push network.
import { describe, it, expect, beforeEach } from "bun:test";
import { createPushBridge } from "../lib/push-bridge";
import type { PushSubscriptionRecord } from "../lib/push-subscriptions";
import type { PushNotification, ProjectorBoard } from "../lib/notification-filter";
import { createNotificationProjector } from "../lib/notification-filter";

interface FakeStore {
  subs: PushSubscriptionRecord[];
  deleted: string[];
  listSubscriptions(): PushSubscriptionRecord[];
  deleteSubscription(endpoint: string): void;
}

function makeStore(subs: PushSubscriptionRecord[] = []): FakeStore {
  const store: FakeStore = {
    subs: [...subs],
    deleted: [],
    listSubscriptions() {
      return this.subs;
    },
    deleteSubscription(endpoint: string) {
      this.deleted.push(endpoint);
      this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    },
  };
  return store;
}

const SUB_A: PushSubscriptionRecord = {
  endpoint: "https://push.example/a",
  keys: { p256dh: "P", auth: "A" },
};
const SUB_B: PushSubscriptionRecord = {
  endpoint: "https://push.example/b",
  keys: { p256dh: "Q", auth: "B" },
};

const ASK_BOARD: ProjectorBoard = {
  tickets: [
    { id: "CTL-1", attention: "ask", attentionSince: "s1", humanQuestion: "Approve?" },
  ],
  daemon: "healthy",
  anomaly: false,
};

describe("createPushBridge", () => {
  let sendCalls: Array<{ sub: PushSubscriptionRecord; n: PushNotification }>;
  let send: (sub: PushSubscriptionRecord, n: PushNotification) => Promise<void>;

  beforeEach(() => {
    sendCalls = [];
    send = (sub, n): Promise<void> => {
      sendCalls.push({ sub, n });
      return Promise.resolve();
    };
  });

  it("calls send once per stored subscription for a new ask ticket", async () => {
    const store = makeStore([SUB_A, SUB_B]);
    const bridge = createPushBridge({
      store,
      projector: createNotificationProjector(),
      send,
    });
    await bridge.onBoard(ASK_BOARD);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0].sub.endpoint).toBe(SUB_A.endpoint);
    expect(sendCalls[1].sub.endpoint).toBe(SUB_B.endpoint);
    expect(sendCalls[0].n.title).toBe("CTL-1 needs your decision");
  });

  it("does NOT call send on a steady-state repeat board (projector dedup)", async () => {
    const store = makeStore([SUB_A]);
    const projector = createNotificationProjector();
    const bridge = createPushBridge({ store, projector, send });
    await bridge.onBoard(ASK_BOARD);
    sendCalls = [];
    await bridge.onBoard(ASK_BOARD); // same episode, same attentionSince
    expect(sendCalls).toHaveLength(0);
  });

  it("prunes the subscription when send rejects with statusCode: 410", async () => {
    const store = makeStore([SUB_A]);
    const err410 = Object.assign(new Error("Gone"), { statusCode: 410 });
    const failSend = (): Promise<void> => Promise.reject(err410);
    const bridge = createPushBridge({ store, projector: createNotificationProjector(), send: failSend });
    await bridge.onBoard(ASK_BOARD);
    expect(store.deleted).toContain(SUB_A.endpoint);
    expect(store.subs).toHaveLength(0);
  });

  it("retains subscription when send rejects with a non-410 error", async () => {
    const store = makeStore([SUB_A]);
    const err500 = Object.assign(new Error("Server Error"), { statusCode: 500 });
    const failSend = (): Promise<void> => Promise.reject(err500);
    const bridge = createPushBridge({
      store,
      projector: createNotificationProjector(),
      send: failSend,
    });
    await bridge.onBoard(ASK_BOARD);
    expect(store.deleted).toHaveLength(0);
    expect(store.subs).toHaveLength(1);
  });

  it("emits no sends when zero subscriptions are stored", async () => {
    const store = makeStore([]);
    const bridge = createPushBridge({ store, projector: createNotificationProjector(), send });
    await bridge.onBoard(ASK_BOARD);
    expect(sendCalls).toHaveLength(0);
  });

  it("emits no sends when the board has no notify-worthy events", async () => {
    const store = makeStore([SUB_A]);
    const bridge = createPushBridge({ store, projector: createNotificationProjector(), send });
    await bridge.onBoard({ tickets: [], daemon: "healthy", anomaly: false });
    expect(sendCalls).toHaveLength(0);
  });

  // CTL-1522: end-to-end proof that a transient daemon-freshness blip sends
  // nothing. On mini this exact shape (a ~46s excursion past the 90s window)
  // happened ~150x/day and pushed a degraded AND a recovered every time.
  it("does NOT send on a sub-hold daemon blip (CTL-1522 hold)", async () => {
    const store = makeStore([SUB_A]);
    let clock = 1_000_000;
    const projector = createNotificationProjector({
      now: () => clock,
      daemonNotifyHoldMs: 180_000,
    });
    const bridge = createPushBridge({ store, projector, send });
    const at = async (deltaMs: number, daemon: "healthy" | "degraded") => {
      clock += deltaMs;
      await bridge.onBoard({ tickets: [], daemon, anomaly: false });
    };
    await at(0, "healthy");
    await at(90_000, "degraded");
    await at(46_000, "healthy");
    await at(600_000, "healthy");
    expect(sendCalls).toHaveLength(0);
  });

  // The paired guarantee: a SUSTAINED outage still reaches the phone.
  it("DOES send once when the daemon stays degraded past the hold (CTL-1522)", async () => {
    const store = makeStore([SUB_A]);
    let clock = 1_000_000;
    const projector = createNotificationProjector({
      now: () => clock,
      daemonNotifyHoldMs: 180_000,
    });
    const bridge = createPushBridge({ store, projector, send });
    const at = async (deltaMs: number, daemon: "healthy" | "degraded") => {
      clock += deltaMs;
      await bridge.onBoard({ tickets: [], daemon, anomaly: false });
    };
    await at(0, "healthy");
    await at(1, "degraded");
    await at(180_000, "degraded");
    await at(1, "degraded");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].n.title).toBe("Catalyst — daemon degraded");
  });
});
