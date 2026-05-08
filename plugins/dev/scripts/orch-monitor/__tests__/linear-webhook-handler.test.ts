import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createLinearWebhookHandler,
  buildLinearEventLogEnvelope,
} from "../lib/linear-webhook-handler";
import type { EventLogWriter } from "../lib/event-log";
import type { CanonicalEvent } from "../lib/canonical-event";

const SECRET = "linear-test-secret";
const TS = "2026-05-08T18:00:00.000Z";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeReq(
  body: unknown,
  headers: Partial<{
    "linear-event": string;
    "linear-delivery": string;
    "linear-signature": string;
  }> = {},
  method = "POST",
): Request {
  const bodyStr = JSON.stringify(body);
  return new Request("http://localhost:7400/api/webhook/linear", {
    method,
    headers: {
      "linear-event": headers["linear-event"] ?? "Issue",
      "linear-delivery":
        headers["linear-delivery"] ?? `linear-delivery-${Math.random()}`,
      "linear-signature": headers["linear-signature"] ?? sign(bodyStr),
      "content-type": "application/json",
    },
    body: bodyStr,
  });
}

class FakeEventLog implements EventLogWriter {
  appends: CanonicalEvent[] = [];
  failNext = false;
  append(envelope: CanonicalEvent): Promise<void> {
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
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(makeReq(issueUpdatePayload(), {}, "GET"));
    expect(res.status).toBe(405);
  });

  it("returns 401 for bad signature", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-signature": "deadbeef" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when event header is missing", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-event": "" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when delivery header is missing", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-delivery": "" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const bodyStr = "{not json";
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const req = new Request("http://localhost/api/webhook/linear", {
      method: "POST",
      headers: {
        "linear-event": "Issue",
        "linear-delivery": "delivery-1",
        "linear-signature": createHmac("sha256", SECRET)
          .update(bodyStr)
          .digest("hex"),
        "content-type": "application/json",
      },
      body: bodyStr,
    });
    const res = await handler.handle(req);
    expect(res.status).toBe(400);
  });

  it("happy path → 200 + canonical envelope written to event log", async () => {
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
    expect(env.resource["service.name"]).toBe("catalyst.linear");
    expect(env.attributes["event.name"]).toBe("linear.issue.state_changed");
    expect(env.attributes["linear.issue.identifier"]).toBe("CTL-210");
    expect(env.attributes["event.label"]).toBe("CTL-210");
    expect(env.attributes["event.channel"]).toBe("webhook");
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
    await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId }),
    );
    expect(eventLog.appends.length).toBe(1);

    const res2 = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId }),
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { ok: boolean; replay?: boolean };
    expect(body.replay).toBe(true);
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
        { "linear-event": "Project" },
      ),
    );
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(0);
  });

  it("invokes onAccept after appending to event log (issue event)", async () => {
    const seen: Array<{ kind: string; ticket?: string | null }> = [];
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      onAccept: (event) => {
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
        { "linear-event": "Project" },
      ),
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
    expect(eventLog.appends.length).toBe(1);
  });

  it("extracts actorId and writes it to body.payload + linear.actor.id attribute", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const payload = {
      action: "update",
      type: "Issue",
      actor: { id: "actor-uuid-999", name: "Some User" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { description: "old desc" },
    };
    await handler.handle(makeReq(payload));
    expect(
      eventLog.appends[0]?.attributes["linear.actor.id"],
    ).toBe("actor-uuid-999");
    const bodyPayload = eventLog.appends[0]?.body.payload as { actorId: string };
    expect(bodyPayload.actorId).toBe("actor-uuid-999");
  });

  it("writes actorId: null in body.payload when payload has no actor field", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const payload = {
      action: "update",
      type: "Issue",
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { description: "old desc" },
    };
    await handler.handle(makeReq(payload));
    const bodyPayload = eventLog.appends[0]?.body.payload as { actorId: string | null };
    expect(bodyPayload.actorId).toBeNull();
    expect(eventLog.appends[0]?.attributes["linear.actor.id"]).toBeUndefined();
  });

  it("suppresses issue events from bot actor — no event log append", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
      botUserId: "bot-uuid-123",
    });
    const botPayload = {
      action: "update",
      type: "Issue",
      actor: { id: "bot-uuid-123", name: "Catalyst Bot" },
      data: { id: "i1", identifier: "CTL-263", team: { key: "CTL" } },
      updatedFrom: { stateId: "old" },
    };
    const res = await handler.handle(makeReq(botPayload));
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(0);
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
    await handler.handle(
      makeReq(commentPayload, { "linear-event": "Comment" }),
    );
    expect(eventLog.appends.length).toBe(1);
  });
});

describe("buildLinearEventLogEnvelope (canonical)", () => {
  it("Issue update → topic from event.topic, linear.issue.identifier from ticket", () => {
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
      TS,
    );
    expect(env).not.toBeNull();
    expect(env!.attributes["event.name"]).toBe("linear.issue.state_changed");
    expect(env!.attributes["linear.issue.identifier"]).toBe("CTL-1");
    expect(env!.attributes["linear.team.key"]).toBe("CTL");
    expect(env!.attributes["event.entity"]).toBe("issue");
    expect(env!.attributes["event.action"]).toBe("state_changed");
  });

  it("Issue event includes actorId in body.payload + attributes when actor is present", () => {
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
      TS,
    );
    expect(env!.attributes["linear.actor.id"]).toBe("actor-uuid-123");
    const payload = env!.body.payload as { actorId: string };
    expect(payload.actorId).toBe("actor-uuid-123");
  });

  it("Issue event has actorId null in body.payload when no actor", () => {
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
      TS,
    );
    const payload = env!.body.payload as { actorId: string | null };
    expect(payload.actorId).toBeNull();
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
      TS,
    );
    expect(env!.attributes["event.name"]).toBe("linear.comment.created");
    expect(env!.attributes["linear.issue.identifier"]).toBe("CTL-1");
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
      TS,
    );
    expect(env!.attributes["event.name"]).toBe("linear.cycle.updated");
    expect(env!.attributes["linear.team.key"]).toBe("CTL");
  });

  it("Reaction create → linear.reaction.created", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "reaction",
        action: "create",
        reactionId: "r1",
        data: {},
      },
      TS,
    );
    expect(env!.attributes["event.name"]).toBe("linear.reaction.created");
  });

  it("ignored → null", () => {
    const env = buildLinearEventLogEnvelope(
      { kind: "ignored", reason: "test" },
      TS,
    );
    expect(env).toBeNull();
  });
});
