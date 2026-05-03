import { describe, it, expect } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createWebhookReplay,
  type ReplayHandler,
  type ReplayRunner,
} from "../lib/webhook-replay";

const SECRET = "replay-test";

class FakeHandler implements ReplayHandler {
  seen = new Set<string>();
  calls: Array<{ delivery: string; event: string; signature: string; body: string }> = [];

  async handle(req: Request): Promise<Response> {
    const body = await req.text();
    this.calls.push({
      delivery: req.headers.get("x-github-delivery") ?? "",
      event: req.headers.get("x-github-event") ?? "",
      signature: req.headers.get("x-hub-signature-256") ?? "",
      body,
    });
    return new Response('{"ok":true}', { status: 200 });
  }

  hasSeenDelivery(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }
}

describe("createWebhookReplay", () => {
  it("dispatches only deliveries newer than `since`", async () => {
    const summaries = JSON.stringify([
      {
        id: 1,
        guid: "g1",
        delivered_at: "2026-05-01T00:00:00Z",
        event: "pull_request",
      },
      {
        id: 2,
        guid: "g2",
        delivered_at: "2026-05-03T12:00:00Z",
        event: "pull_request",
      },
      {
        id: 3,
        guid: "g3",
        delivered_at: "2026-05-03T13:00:00Z",
        event: "check_suite",
      },
    ]);
    const detail = (event: string, guid: string): string =>
      JSON.stringify({
        guid,
        event,
        request: { payload: '{"action":"closed","number":1}' },
      });

    const runner: ReplayRunner = (args) => {
      const path = args[2] ?? "";
      if (path === "repos/o/r/hooks/100/deliveries")
        return Promise.resolve({ stdout: summaries, ok: true });
      if (path === "repos/o/r/hooks/100/deliveries/2")
        return Promise.resolve({ stdout: detail("pull_request", "g2"), ok: true });
      if (path === "repos/o/r/hooks/100/deliveries/3")
        return Promise.resolve({ stdout: detail("check_suite", "g3"), ok: true });
      return Promise.resolve({ stdout: "", ok: false });
    };

    const handler = new FakeHandler();
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    const since = new Date("2026-05-03T00:00:00Z");
    const dispatched = await replay.replaySince([{ repo: "o/r", hookId: 100 }], since);
    expect(dispatched).toBe(2);
    expect(handler.calls.map((c) => c.delivery)).toEqual(["g2", "g3"]);
  });

  it("skips deliveries the handler has already seen (live race)", async () => {
    const summaries = JSON.stringify([
      {
        id: 7,
        guid: "live-arrival",
        delivered_at: "2026-05-03T12:00:00Z",
        event: "pull_request",
      },
    ]);
    const runner: ReplayRunner = () =>
      Promise.resolve({ stdout: summaries, ok: true });
    const handler = new FakeHandler();
    handler.seen.add("live-arrival");
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    const dispatched = await replay.replaySince(
      [{ repo: "o/r", hookId: 1 }],
      new Date("2026-05-01"),
    );
    expect(dispatched).toBe(0);
    expect(handler.calls.length).toBe(0);
  });

  it("signs the synthesized request with the configured secret", async () => {
    const body = '{"action":"synchronize","number":1}';
    const summaries = JSON.stringify([
      {
        id: 9,
        guid: "g9",
        delivered_at: "2026-05-03T12:00:00Z",
        event: "pull_request",
      },
    ]);
    const detail = JSON.stringify({
      guid: "g9",
      event: "pull_request",
      request: { payload: body },
    });
    const runner: ReplayRunner = (args) => {
      const path = args[2] ?? "";
      if (path.endsWith("/deliveries"))
        return Promise.resolve({ stdout: summaries, ok: true });
      return Promise.resolve({ stdout: detail, ok: true });
    };
    const handler = new FakeHandler();
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    await replay.replaySince(
      [{ repo: "o/r", hookId: 1 }],
      new Date("2026-05-01"),
    );
    expect(handler.calls.length).toBe(1);
    const call = handler.calls[0];
    if (!call) throw new Error("expected one call");
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update(call.body).digest("hex");
    expect(
      timingSafeEqual(
        Buffer.from(call.signature),
        Buffer.from(expected),
      ),
    ).toBe(true);
  });

  it("tolerates list-deliveries failure and continues to next repo", async () => {
    const runner: ReplayRunner = (args) => {
      const path = args[2] ?? "";
      if (path === "repos/a/b/hooks/1/deliveries")
        return Promise.resolve({ stdout: "", ok: false });
      if (path === "repos/c/d/hooks/2/deliveries")
        return Promise.resolve({ stdout: "[]", ok: true });
      return Promise.resolve({ stdout: "", ok: false });
    };
    const handler = new FakeHandler();
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    const dispatched = await replay.replaySince(
      [
        { repo: "a/b", hookId: 1 },
        { repo: "c/d", hookId: 2 },
      ],
      new Date("2026-05-01"),
    );
    expect(dispatched).toBe(0);
  });

  it("tolerates fetch-detail failure for individual deliveries", async () => {
    const summaries = JSON.stringify([
      {
        id: 1,
        guid: "g1",
        delivered_at: "2026-05-03T00:00:00Z",
        event: "pull_request",
      },
      {
        id: 2,
        guid: "g2",
        delivered_at: "2026-05-03T01:00:00Z",
        event: "pull_request",
      },
    ]);
    const detail2 = JSON.stringify({
      guid: "g2",
      event: "pull_request",
      request: { payload: '{"action":"closed"}' },
    });
    const runner: ReplayRunner = (args) => {
      const path = args[2] ?? "";
      if (path.endsWith("/deliveries"))
        return Promise.resolve({ stdout: summaries, ok: true });
      if (path.endsWith("/1"))
        return Promise.resolve({ stdout: "", ok: false });
      if (path.endsWith("/2"))
        return Promise.resolve({ stdout: detail2, ok: true });
      return Promise.resolve({ stdout: "", ok: false });
    };
    const handler = new FakeHandler();
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    const dispatched = await replay.replaySince(
      [{ repo: "o/r", hookId: 1 }],
      new Date("2026-05-01"),
    );
    expect(dispatched).toBe(1);
    expect(handler.calls[0]?.delivery).toBe("g2");
  });

  it("does nothing when there are no recent deliveries", async () => {
    const summaries = JSON.stringify([
      {
        id: 1,
        guid: "old",
        delivered_at: "2026-04-01T00:00:00Z",
        event: "pull_request",
      },
    ]);
    const runner: ReplayRunner = () =>
      Promise.resolve({ stdout: summaries, ok: true });
    const handler = new FakeHandler();
    const replay = createWebhookReplay({ runner, handler, secret: SECRET });
    const dispatched = await replay.replaySince(
      [{ repo: "o/r", hookId: 1 }],
      new Date("2026-05-01"),
    );
    expect(dispatched).toBe(0);
  });
});
