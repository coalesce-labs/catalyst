import { describe, it, expect } from "bun:test";
import {
  createWebhookTunnel,
  type SmeeClientLike,
  type SmeeClientOptions,
} from "../lib/webhook-tunnel";

class FakeClient implements SmeeClientLike {
  startCalls = 0;
  stopCalls = 0;
  startError: Error | null = null;

  start(): Promise<unknown> {
    this.startCalls++;
    if (this.startError) return Promise.reject(this.startError);
    return Promise.resolve({});
  }

  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
}

describe("createWebhookTunnel", () => {
  it("creates the client and starts on start()", async () => {
    let constructorCalls = 0;
    let receivedOpts: SmeeClientOptions | null = null;
    const fake = new FakeClient();
    const tunnel = createWebhookTunnel({
      source: "https://smee.io/abc",
      target: "http://localhost:7400/api/webhook",
      factory: (opts) => {
        constructorCalls++;
        receivedOpts = opts;
        return fake;
      },
    });
    expect(tunnel.isStarted()).toBe(false);
    await tunnel.start();
    expect(constructorCalls).toBe(1);
    expect(receivedOpts!.source).toBe("https://smee.io/abc");
    expect(receivedOpts!.target).toBe("http://localhost:7400/api/webhook");
    expect(fake.startCalls).toBe(1);
    expect(tunnel.isStarted()).toBe(true);
  });

  it("start() is idempotent", async () => {
    const fake = new FakeClient();
    const tunnel = createWebhookTunnel({
      source: "s",
      target: "t",
      factory: () => fake,
    });
    await tunnel.start();
    await tunnel.start();
    expect(fake.startCalls).toBe(1);
  });

  it("stop() closes the client and resets state", async () => {
    const fake = new FakeClient();
    const tunnel = createWebhookTunnel({
      source: "s",
      target: "t",
      factory: () => fake,
    });
    await tunnel.start();
    await tunnel.stop();
    expect(fake.stopCalls).toBe(1);
    expect(tunnel.isStarted()).toBe(false);
  });

  it("stop() is a no-op when never started", async () => {
    const fake = new FakeClient();
    const tunnel = createWebhookTunnel({
      source: "s",
      target: "t",
      factory: () => fake,
    });
    await tunnel.stop();
    expect(fake.stopCalls).toBe(0);
  });

  it("rethrows on start failure and resets state", async () => {
    const fake = new FakeClient();
    fake.startError = new Error("connection refused");
    const tunnel = createWebhookTunnel({
      source: "s",
      target: "t",
      factory: () => fake,
    });
    let caught = false;
    try {
      await tunnel.start();
    } catch (err) {
      caught = true;
      expect((err as Error).message).toBe("connection refused");
    }
    expect(caught).toBe(true);
    expect(tunnel.isStarted()).toBe(false);
  });

  it("logs connection lifecycle when logger is provided", async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const fake = new FakeClient();
    const tunnel = createWebhookTunnel({
      source: "https://smee.io/abc",
      target: "http://localhost:7400/api/webhook",
      logger: {
        info: (m) => logs.push({ level: "info", msg: m }),
        error: (m) => logs.push({ level: "error", msg: m }),
      },
      factory: () => fake,
    });
    await tunnel.start();
    expect(
      logs.some(
        (l) =>
          l.level === "info" &&
          l.msg.includes("connected") &&
          l.msg.includes("https://smee.io/abc"),
      ),
    ).toBe(true);
  });
});
