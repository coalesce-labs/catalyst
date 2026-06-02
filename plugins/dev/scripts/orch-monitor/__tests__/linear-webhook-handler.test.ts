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
      makeReq(issueUpdatePayload(), { "linear-signature": "deadbeef" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when event header is missing", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(makeReq(issueUpdatePayload(), { "linear-event": "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when delivery header is missing", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
    });
    const res = await handler.handle(makeReq(issueUpdatePayload(), { "linear-delivery": "" }));
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
        "linear-signature": createHmac("sha256", SECRET).update(bodyStr).digest("hex"),
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
    await handler.handle(makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId }));
    expect(eventLog.appends.length).toBe(1);

    const res2 = await handler.handle(
      makeReq(issueUpdatePayload(), { "linear-delivery": deliveryId })
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
        { "linear-event": "Project" }
      )
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
    expect(eventLog.appends[0]?.attributes["linear.actor.id"]).toBe("actor-uuid-999");
    const bodyPayload = eventLog.appends[0]?.body.payload as { actorId: string };
    expect(bodyPayload.actorId).toBe("actor-uuid-999");
  });

  it("extracts toState/actorName from webhook payload and writes to body.payload (CTL-424)", async () => {
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog,
    });
    const payload = {
      action: "update",
      type: "Issue",
      actor: { id: "actor-uuid-424", name: "Ryan" },
      data: {
        id: "i1",
        identifier: "CTL-424",
        team: { key: "CTL" },
        state: { id: "state-uuid", name: "In Progress" },
        priority: 2,
        assignee: { id: "user-uuid-424", name: "Alice" },
      },
      updatedFrom: { stateId: "old-state-uuid" },
    };
    await handler.handle(makeReq(payload));
    const p = eventLog.appends[0]?.body.payload as Record<string, unknown>;
    expect(p.toState).toBe("In Progress");
    expect(p.toPriority).toBe(2);
    expect(p.toAssigneeId).toBe("user-uuid-424");
    expect(p.toAssigneeName).toBe("Alice");
    expect(p.actorName).toBe("Ryan");
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
    await handler.handle(makeReq(commentPayload, { "linear-event": "Comment" }));
    expect(eventLog.appends.length).toBe(1);
  });
});

describe("buildLinearEventLogEnvelope — description fields (CTL-749)", () => {
  it("issue.updated envelope carries description and descriptionChanged", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.updated",
        ticket: "CTL-749",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: ["description"],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: { description: "old text" },
        description: "new text",
        descriptionChanged: true,
      },
      TS
    );
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["description"]).toBe("new text");
    expect(payload["descriptionChanged"]).toBe(true);
  });

  it("description is null and descriptionChanged is false when not a description edit", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.updated",
        ticket: "CTL-749",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: [],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["description"]).toBeNull();
    expect(payload["descriptionChanged"]).toBe(false);
  });
});

describe("buildLinearEventLogEnvelope — comment fields (CTL-681)", () => {
  it("comment envelope includes body, authorId, authorName in body.payload", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "CTL-99",
        commentId: "c1",
        issueId: "i1",
        body: "hello there",
        authorId: "u1",
        authorName: "Ada",
        data: {},
      },
      TS
    );
    expect(env).not.toBeNull();
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["body"]).toBe("hello there");
    expect(payload["authorId"]).toBe("u1");
    expect(payload["authorName"]).toBe("Ada");
  });

  it("comment envelope with no body/author has null values in payload", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "CTL-99",
        commentId: "c1",
        issueId: "i1",
        body: null,
        authorId: null,
        authorName: null,
        data: {},
      },
      TS
    );
    expect(env).not.toBeNull();
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["body"]).toBeNull();
    expect(payload["authorId"]).toBeNull();
    expect(payload["authorName"]).toBeNull();
  });

  it("bot-authored comment is NOT suppressed (pin Finding 5)", async () => {
    const eventLog2 = new FakeEventLog();
    const handler = createLinearWebhookHandler({
      linearSecrets: [{ key: "test", secret: SECRET }],
      eventLog: eventLog2,
      botUserId: "bot-uuid-123",
    });
    const botComment = {
      action: "create",
      type: "Comment",
      actor: { id: "bot-uuid-123", name: "Catalyst Bot" },
      data: { id: "c2", body: "Automated comment", issueId: "i1" },
    };
    await handler.handle(makeReq(botComment, { "linear-event": "Comment" }));
    expect(eventLog2.appends.length).toBe(1);
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
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    expect(env).not.toBeNull();
    expect(env!.attributes["event.name"]).toBe("linear.issue.state_changed");
    expect(env!.attributes["linear.issue.identifier"]).toBe("CTL-1");
    expect(env!.attributes["linear.team.key"]).toBe("CTL");
    expect(env!.attributes["event.entity"]).toBe("issue");
    expect(env!.attributes["event.action"]).toBe("state_changed");
  });

  it("state_changed event forwards toState into body.payload (CTL-399)", () => {
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
        actorName: null,
        toState: "In Review",
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["toState"]).toBe("In Review");
  });

  it("state_changed event with null toState has toState null in payload (CTL-399)", () => {
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
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const payload = env!.body.payload as Record<string, unknown>;
    expect(payload["toState"]).toBeNull();
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
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
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
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const payload = env!.body.payload as { actorId: string | null };
    expect(payload.actorId).toBeNull();
  });

  it("CTL-681: Issue event forwards toLabels/toProject/toProjectId/previousFromValues into body.payload", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.state_changed",
        ticket: "CTL-681",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: ["stateId", "labelIds"],
        actorId: null,
        actorName: null,
        toState: "Ready",
        toPriority: 2,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: ["bug", "p0"],
        toProject: "Initiative 1",
        toProjectId: "proj-uuid",
        previousFromValues: {
          stateId: "old-state",
          labelIds: ["old-label"],
        },
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const p = env!.body.payload as Record<string, unknown>;
    expect(p.toLabels).toEqual(["bug", "p0"]);
    expect(p.toProject).toBe("Initiative 1");
    expect(p.toProjectId).toBe("proj-uuid");
    expect(p.previousFromValues).toEqual({
      stateId: "old-state",
      labelIds: ["old-label"],
    });
  });

  it("Issue event serializes toState, toPriority, toAssigneeName, actorName into body.payload (CTL-424)", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.state_changed",
        ticket: "CTL-424",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: ["stateId"],
        actorId: "actor-uuid-424",
        actorName: "Ryan",
        toState: "In Progress",
        toPriority: 2,
        toAssigneeId: "user-uuid-424",
        toAssigneeName: "Alice",
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const p = env!.body.payload as Record<string, unknown>;
    expect(p.toState).toBe("In Progress");
    expect(p.toPriority).toBe(2);
    expect(p.toAssigneeId).toBe("user-uuid-424");
    expect(p.toAssigneeName).toBe("Alice");
    expect(p.actorName).toBe("Ryan");
  });

  it("Issue event with null new-field values serializes them as null (CTL-424)", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.updated",
        ticket: "CTL-424",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: [],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    const p = env!.body.payload as Record<string, unknown>;
    expect(p.toState).toBeNull();
    expect(p.toPriority).toBeNull();
    expect(p.toAssigneeId).toBeNull();
    expect(p.toAssigneeName).toBeNull();
    expect(p.actorName).toBeNull();
  });

  it("Comment create → linear.comment.created", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "CTL-1",
        commentId: "c1",
        issueId: "i1",
        body: null,
        authorId: null,
        authorName: null,
        data: {},
      },
      TS
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
      TS
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
      TS
    );
    expect(env!.attributes["event.name"]).toBe("linear.reaction.created");
  });

  it("ignored → null", () => {
    const env = buildLinearEventLogEnvelope({ kind: "ignored", reason: "test" }, TS);
    expect(env).toBeNull();
  });
});

// CTL-362: when a teams map is supplied, the envelope gets
// attributes["vcs.repository.name"] for events the lookup can resolve so the
// HUD's REPO column populates for Linear events.
describe("buildLinearEventLogEnvelope — team→repo lookup (CTL-362)", () => {
  const TEAMS = new Map<string, string>([
    ["CTL", "coalesce-labs/catalyst"],
    ["ADV", "coalesce-labs/adva"],
  ]);

  it("issue with known team key → vcs.repository.name set", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "update",
        topic: "linear.issue.state_changed",
        ticket: "CTL-210",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: ["stateId"],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
    expect(env!.attributes["linear.team.key"]).toBe("CTL");
  });

  it("issue with unknown team key → vcs.repository.name omitted", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "create",
        topic: "linear.issue.created",
        ticket: "FOO-1",
        teamKey: "FOO",
        data: {},
        updatedFromKeys: [],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
    expect(env!.attributes["linear.team.key"]).toBe("FOO");
  });

  it("issue with no team key → vcs.repository.name omitted", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "create",
        topic: "linear.issue.created",
        ticket: "CTL-1",
        teamKey: null,
        data: {},
        updatedFromKeys: [],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
  });

  it("comment derives team key from ticket prefix and stamps repo + linear.team.key", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "ADV-42",
        commentId: "c1",
        issueId: "i1",
        body: null,
        authorId: null,
        authorName: null,
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBe("coalesce-labs/adva");
    expect(env!.attributes["linear.team.key"]).toBe("ADV");
    expect(env!.attributes["linear.issue.identifier"]).toBe("ADV-42");
  });

  it("comment with ticket whose prefix is unknown → no repo, no team.key", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: "FOO-1",
        commentId: "c1",
        issueId: "i1",
        body: null,
        authorId: null,
        authorName: null,
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
    expect(env!.attributes["linear.team.key"]).toBeUndefined();
  });

  it("comment without ticket → no repo", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "comment",
        action: "create",
        ticket: null,
        commentId: "c1",
        issueId: "i1",
        body: null,
        authorId: null,
        authorName: null,
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
  });

  it("cycle with known team key → vcs.repository.name set", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "cycle",
        action: "update",
        cycleId: "c1",
        teamKey: "CTL",
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
  });

  it("reaction events are not enriched (no team context)", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "reaction",
        action: "create",
        reactionId: "r1",
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
  });

  it("issue_label events are not enriched (no team context)", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue_label",
        action: "create",
        labelId: "l1",
        data: {},
      },
      TS,
      TEAMS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
  });

  it("no teamsMap supplied → no enrichment (backward-compat default)", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "issue",
        action: "create",
        topic: "linear.issue.created",
        ticket: "CTL-1",
        teamKey: "CTL",
        data: {},
        updatedFromKeys: [],
        actorId: null,
        actorName: null,
        toState: null,
        toPriority: null,
        toAssigneeId: null,
        toAssigneeName: null,
        toLabels: null,
        toProject: null,
        toProjectId: null,
        previousFromValues: {},
        description: null,
        descriptionChanged: false,
      },
      TS
    );
    expect(env!.attributes["vcs.repository.name"]).toBeUndefined();
  });
});

describe("buildLinearEventLogEnvelope — agent_session and mention", () => {
  it("produces linear.agent_session.created for kind=agent_session action=create", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "agent_session",
        action: "create",
        sessionId: "sess-uuid",
        issueId: "issue-uuid",
        actorId: "actor-uuid",
        data: {},
      },
      TS
    );
    expect(env).not.toBeNull();
    expect(env!.attributes["event.name"]).toBe("linear.agent_session.created");
    expect(env!.attributes["linear.actor.id"]).toBe("actor-uuid");
    expect(env!.attributes["linear.issue.id"]).toBe("issue-uuid");
  });

  it("produces linear.agent_session.updated for action=update", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "agent_session",
        action: "update",
        sessionId: "sess-uuid",
        issueId: null,
        actorId: null,
        data: {},
      },
      TS
    );
    expect(env!.attributes["event.name"]).toBe("linear.agent_session.updated");
  });

  it("produces linear.mention.created for kind=mention action=create", () => {
    const env = buildLinearEventLogEnvelope(
      {
        kind: "mention",
        action: "create",
        ticket: "CTL-550",
        commentId: "comment-uuid",
        issueId: "issue-uuid",
        body: "hey @catalyst",
        authorId: "author-uuid",
        authorName: "Ryan",
        data: {},
      },
      TS
    );
    expect(env).not.toBeNull();
    expect(env!.attributes["event.name"]).toBe("linear.mention.created");
    expect(env!.attributes["linear.issue.identifier"]).toBe("CTL-550");
    expect(env!.attributes["linear.actor.id"]).toBe("author-uuid");
  });

  it("returns null for kind=ignored", () => {
    const env = buildLinearEventLogEnvelope({ kind: "ignored", reason: "test" }, TS);
    expect(env).toBeNull();
  });
});
