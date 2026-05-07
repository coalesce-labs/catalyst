import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createLinearWebhookHandler,
  buildLinearEventLogEnvelope,
  LINEAR_WEBHOOK_SOURCE,
} from "../lib/linear-webhook-handler";
import type { EventLogWriter, AppendableEvent } from "../lib/event-log";

const SECRET = "linear-test-secret";

function sign(body: string): string {
  // Linear: hex digest only, no `sha256=` prefix.
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeReq(
  body: unknown,
  headers: Partial<{
    "linear-event": string;
    "linear-delivery": string;
    "linear-signature": string;
  }> = {},
  method = "POST"
): Request {
  const bodyStr = JSON.stringify(body);
  return new Request("http://localhost:7400/api/webhook/linear", {
    method,
    headers: {
      "linear-event": headers["linear-event"] ?? "Issue",
      "linear-delivery": headers["linear-delivery"] ?? `linear-delivery-${Math.random()}`,
      "linear-signature": headers["linear-signature"] ?? sign(bodyStr),
      "content-type": "application/json",
    },
    body: bodyStr,
  });
}

class FakeEventLog implements EventLogWriter {
  appends: AppendableEvent[] = [];
  failNext = false;
  append(envelope: AppendableEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("disk full"));
    }
    this.appends.push(envelope);
    return Promise.resolve();
  }
}

function issueUpdatePayload(): unknown {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid",
      identifier: "CTL-210",
      stateId: "new-state",
      team: { key: "CTL" },
    },
    updatedFrom: { stateId: "old-state" },
  };
}

describe("createLinearWebhookHandler", () => {
  let eventLog: FakeEventLog;

  beforeEach(() => {
    eventLog = new FakeEventLog();
  });

  it("returns 503 when linearSecrets is empty", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [] });
    const res = await handler.handle(makeReq(issueUpdatePayload()));
    expect(res.status).toBe(503);
  });

  it("returns 405 for non-POST", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }] });
    const res = await handler.handle(makeReq(issueUpdatePayload(), {}, "GET"));
    expect(res.status).toBe(405);
  });

  it("returns 401 for bad signature", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }] });
    const res = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-signature": "deadbeef" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when event header is missing", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }] });
    const res = await handler.handle(makeReq(issueUpdatePayload(), { "linear-event": "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when delivery header is missing", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }] });
    const res = await handler.handle(makeReq(issueUpdatePayload(), { "linear-delivery": "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const bodyStr = "{not json";
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }] });
    const req = new Request("http://localhost/api/webhook/linear", {
      method: "POST",
      headers: {
        "linear-event": "Issue",
        "linear-delivery": "delivery-1",
        "linear-signature": createHmac("sha256", SECRET).update(bodyStr).digest("hex"),
        "content-type": "application/json",
      },
      body: bodyStr,
    });
    const res = await handler.handle(req);
    expect(res.status).toBe(400);
  });

  it("happy path → 200 + envelope written to event log", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const res = await handler.handle(makeReq(issueUpdatePayload()));
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(1);
    const env = eventLog.appends[0];
    expect(env).toBeDefined();
    if (!env) throw new Error("expected event log append");
    expect(env.source).toBe(LINEAR_WEBHOOK_SOURCE);
    expect(env.event).toBe("linear.issue.state_changed");
    expect(env.scope.ticket).toBe("CTL-210");
    expect(env.id).toMatch(/^evt_linear_/);
  });

  it("emits to in-process bus on success", async () => {
    const emitted: Array<{ type: string; data: unknown }> = [];
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      emit: (type, data) => emitted.push({ type, data }),
    });
    await handler.handle(makeReq(issueUpdatePayload()));
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.type).toBe("linear-webhook-event");
  });

  it("idempotent on replay (same delivery id)", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const deliveryId = "stable-delivery-1";
    await handler.handle(makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId }));
    expect(eventLog.appends.length).toBe(1);

    const res2 = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId })
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { ok: boolean; replay?: boolean };
    expect(body.replay).toBe(true);
    // Replay must NOT produce a second event-log append.
    expect(eventLog.appends.length).toBe(1);
  });

  it("event-log failure does not fail the request", async () => {
    eventLog.failNext = true;
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      logger: { warn: () => {} },
    });
    const res = await handler.handle(makeReq(issueUpdatePayload()));
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(0);
  });

  it("ignored events return 200 but write no envelope", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const res = await handler.handle(
      makeReq(
        {
          action: "create",
          type: "Project",
          data: { id: "p1" },
        },
        { "linear-event": "Project" }
      )
    );
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(0);
  });

  // CTL-211 — onAccept hook lets the server invalidate the LinearFetcher cache
  // when a ticket changes state, so the dashboard reflects updates immediately.
  it("invokes onAccept after appending to event log (issue event)", async () => {
    const seen: Array<{ kind: string; ticket?: string | null }> = [];
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      onAccept: (event) => {
        // Cast just to satisfy structural read in the test
        const evt = event as { kind: string; ticket?: string | null };
        seen.push({ kind: evt.kind, ticket: evt.ticket });
      },
    });
    await handler.handle(makeReq(issueUpdatePayload()));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("issue");
    expect(seen[0]?.ticket).toBe("CTL-210");
  });

  it("does not invoke onAccept on ignored events", async () => {
    const seen: number[] = [];
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      onAccept: () => {
        seen.push(1);
      },
    });
    await handler.handle(
      makeReq(
        { action: "create", type: "Project", data: { id: "p1" } },
        { "linear-event": "Project" }
      )
    );
    expect(seen).toHaveLength(0);
  });

  it("onAccept failure does not fail the request", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      onAccept: () => {
        throw new Error("downstream consumer broke");
      },
      logger: { warn: () => {} },
    });
    const res = await handler.handle(makeReq(issueUpdatePayload()));
    expect(res.status).toBe(200);
    // Event-log append still happened despite consumer failure.
    expect(eventLog.appends.length).toBe(1);
  });

  // CTL-263: actorId extraction through full HTTP path
  it("extracts actorId from payload.actor.id and writes it to event log detail", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }], eventLog });
    const payload = {
      action: "update",
      type: "Issue",
      actor: { id: "actor-uuid-999", name: "Some User", email: "user@example.com" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { description: "old desc" },
    };
    await handler.handle(makeReq(payload));
    expect(eventLog.appends[0]?.detail).toMatchObject({ actorId: "actor-uuid-999" });
  });

  it("writes actorId: null when payload has no actor field", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }], eventLog });
    const payload = {
      action: "update",
      type: "Issue",
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { description: "old desc" },
    };
    await handler.handle(makeReq(payload));
    expect(eventLog.appends[0]?.detail).toMatchObject({ actorId: null });
  });

  // CTL-263: bot-skip logic
  it("suppresses issue events from bot actor — no event log append", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      botUserId: "bot-uuid-123",
    });
    const botPayload = {
      action: "update",
      type: "Issue",
      actor: { id: "bot-uuid-123", name: "Catalyst Bot", email: "bot@example.com" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { stateId: "old" },
    };
    const res = await handler.handle(makeReq(botPayload));
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(0);
  });

  it("suppressed bot event still returns ok:true", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      botUserId: "bot-uuid-123",
    });
    const botPayload = {
      action: "update",
      type: "Issue",
      actor: { id: "bot-uuid-123" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { stateId: "old" },
    };
    const res = await handler.handle(makeReq(botPayload));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("non-bot actor writes normally even when botUserId is configured", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      botUserId: "bot-uuid-123",
    });
    const humanPayload = {
      action: "update",
      type: "Issue",
      actor: { id: "human-uuid-456", name: "Alice" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { description: "old" },
    };
    await handler.handle(makeReq(humanPayload));
    expect(eventLog.appends.length).toBe(1);
  });

  it("no botUserId configured → no suppression (backwards compat)", async () => {
    const handler = createLinearWebhookHandler({ linearSecrets: [{ key: "test", secret: SECRET }], eventLog });
    const payload = {
      action: "update",
      type: "Issue",
      actor: { id: "any-user-uuid" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { stateId: "old" },
    };
    await handler.handle(makeReq(payload));
    expect(eventLog.appends.length).toBe(1);
  });

  it("bot-authored non-issue events (comment) are NOT suppressed", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      botUserId: "bot-uuid-123",
    });
    const commentPayload = {
      action: "create",
      type: "Comment",
      actor: { id: "bot-uuid-123" },
      data: { id: "c1", issueId: "i1" },
    };
    await handler.handle(makeReq(commentPayload, { "linear-event": "Comment" }));
    expect(eventLog.appends.length).toBe(1);
  });
});

describe("buildLinearEventLogEnvelope", () => {
  it("Issue update → topic from event.topic, scope.ticket from event.ticket", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.state_changed",
        ticket: "CTL-1",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: ["stateId"],
        actorId: null,
      },
      "delivery-1"
    );
    expect(env).not.toBeNull();
    expect(env?.event).toBe("linear.issue.state_changed");
    expect(env?.scope.ticket).toBe("CTL-1");
    expect(env?.id).toBe("evt_linear_delivery-1");
  });

  // CTL-263: actorId propagation
  it("Issue event includes actorId in detail when actor is present", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.updated",
        ticket: "CTL-263",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: [],
        actorId: "actor-uuid-123",
      },
      "delivery-1"
    );
    expect(env?.detail).toMatchObject({ actorId: "actor-uuid-123" });
  });

  it("Issue event has actorId null in detail when no actor", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.updated",
        ticket: "CTL-263",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: [],
        actorId: null,
      },
      "delivery-2"
    );
    expect(env?.detail).toMatchObject({ actorId: null });
  });

  it("Comment create → linear.comment.created", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "CTL-1",
        commentId: "c1",
        issueId: "i1",
        data: {},
      },
      "delivery-1"
    );
    expect(env?.event).toBe("linear.comment.created");
  });

  it("Cycle update → linear.cycle.updated", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "cycle",
        action: "update",
        cycleId: "c1",
        teamKey: "CTL",
        data: {},
      },
      "delivery-1"
    );
    expect(env?.event).toBe("linear.cycle.updated");
  });

  it("ignored → null", () => {
    const env = buildLinearEventLogEnvelope({ kind: "ignored", reason: "test" }, "delivery-1");
    expect(env).toBeNull();
  });
});
