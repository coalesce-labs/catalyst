import { describe, it, expect } from "bun:test";
import {
  severityNumber,
  deriveTraceId,
  deriveSpanId,
  generateEventId,
  synthesizeEventId,
  buildCanonicalEvent,
  pluginVersion,
  type CanonicalEvent,
} from "../lib/canonical-event";

describe("severityNumber", () => {
  it("maps DEBUG/INFO/WARN/ERROR to OTel severity numbers", () => {
    expect(severityNumber("DEBUG")).toBe(5);
    expect(severityNumber("INFO")).toBe(9);
    expect(severityNumber("WARN")).toBe(13);
    expect(severityNumber("ERROR")).toBe(17);
  });
});

describe("deriveTraceId", () => {
  it("returns 32-hex for an orchestrator id", () => {
    const id = deriveTraceId("orch-foo", null);
    expect(id).not.toBeNull();
    expect(id!.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(id!)).toBe(true);
  });

  it("returns the same id for the same orchestrator id (deterministic)", () => {
    expect(deriveTraceId("orch-foo", null)).toBe(deriveTraceId("orch-foo", null));
  });

  it("returns different ids for different orchestrator ids", () => {
    expect(deriveTraceId("orch-foo", null)).not.toBe(deriveTraceId("orch-bar", null));
  });

  it("falls back to standalone:sessionId when orchestrator is null", () => {
    const id = deriveTraceId(null, "sess_123");
    expect(id).not.toBeNull();
    expect(id!.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(id!)).toBe(true);
    // different from the orch-id-based hash
    expect(id).not.toBe(deriveTraceId("sess_123", null));
  });

  it("returns null when both orchestrator and session are null/empty", () => {
    expect(deriveTraceId(null, null)).toBeNull();
    expect(deriveTraceId("", "")).toBeNull();
  });
});

describe("deriveSpanId", () => {
  it("returns 16-hex for a worker ticket", () => {
    const id = deriveSpanId("CTL-300", null);
    expect(id).not.toBeNull();
    expect(id!.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(id!)).toBe(true);
  });

  it("returns the same id for the same worker ticket", () => {
    expect(deriveSpanId("CTL-300", null)).toBe(deriveSpanId("CTL-300", null));
  });

  it("falls back to sessionId when worker ticket is null", () => {
    const id = deriveSpanId(null, "sess_abc");
    expect(id).not.toBeNull();
    expect(id!.length).toBe(16);
  });

  it("returns null when both inputs are null/empty", () => {
    expect(deriveSpanId(null, null)).toBeNull();
    expect(deriveSpanId("", "")).toBeNull();
  });
});

describe("buildCanonicalEvent", () => {
  it("fills defaults: severityNumber from severityText, observedTs=ts, namespace=catalyst, version", () => {
    const ev = buildCanonicalEvent({
      ts: "2026-05-08T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: { "event.name": "github.pr.merged" },
      body: { message: "PR #1 merged" },
    });
    expect(ev.severityNumber).toBe(9);
    expect(ev.observedTs).toBe("2026-05-08T18:00:00.000Z");
    expect(ev.resource["service.namespace"]).toBe("catalyst");
    expect(ev.resource["service.version"]).toBe(pluginVersion());
    expect(ev.attributes["event.name"]).toBe("github.pr.merged");
    expect(ev.body.message).toBe("PR #1 merged");
  });

  it("respects an explicit observedTs and overrides defaults", () => {
    const ev = buildCanonicalEvent({
      ts: "2026-05-08T18:00:00.000Z",
      observedTs: "2026-05-08T18:00:01.000Z",
      severityText: "ERROR",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      resource: {
        "service.name": "catalyst.session",
        "service.version": "9.9.9",
      },
      attributes: { "event.name": "session.ended" },
      body: {},
    });
    expect(ev.severityNumber).toBe(17);
    expect(ev.observedTs).toBe("2026-05-08T18:00:01.000Z");
    expect(ev.resource["service.version"]).toBe("9.9.9");
    expect(ev.traceId).toBe("a".repeat(32));
    expect(ev.spanId).toBe("b".repeat(16));
  });

  it("preserves event.name, entity, action, label, channel attribute set", () => {
    const ev: CanonicalEvent = buildCanonicalEvent({
      ts: "2026-05-08T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: {
        "event.name": "github.pr.merged",
        "event.entity": "pr",
        "event.action": "merged",
        "event.label": "PR #342",
        "event.channel": "webhook",
        "vcs.repository.name": "org/repo",
        "vcs.pr.number": 342,
      },
      body: { payload: { merged: true } },
    });
    expect(ev.attributes["event.entity"]).toBe("pr");
    expect(ev.attributes["event.action"]).toBe("merged");
    expect(ev.attributes["event.label"]).toBe("PR #342");
    expect(ev.attributes["event.channel"]).toBe("webhook");
    expect(ev.attributes["vcs.pr.number"]).toBe(342);
  });

  // CTL-362: vcs.repository.name is the canonical attribute the HUD reads for
  // the REPO column. Explicit assertion guards against the field being dropped
  // or renamed during future envelope refactors.
  it("preserves vcs.repository.name through the envelope (CTL-362)", () => {
    const ev = buildCanonicalEvent({
      ts: "2026-05-13T12:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.linear" },
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.team.key": "CTL",
        "linear.issue.identifier": "CTL-362",
        "vcs.repository.name": "coalesce-labs/catalyst",
      },
      body: { payload: null },
    });
    expect(ev.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
  });
});

describe("generateEventId (CTL-344)", () => {
  it("produces a non-empty UUIDv4-shaped string", () => {
    const id = generateEventId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(16);
    // randomUUID returns canonical form: 8-4-4-4-12 hex digits with v4 marker
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)).toBe(true);
  });

  it("returns a different id on each call (non-deterministic)", () => {
    expect(generateEventId()).not.toBe(generateEventId());
  });
});

describe("synthesizeEventId (CTL-344)", () => {
  it("returns a 32-char lowercase hex string", () => {
    const id = synthesizeEventId({
      traceId: "abc",
      spanId: "def",
      ts: "2026-05-12T00:00:00Z",
      attributes: { "event.name": "test.event" },
    });
    expect(id.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const inputs = {
      traceId: "abc",
      spanId: "def",
      ts: "2026-05-12T00:00:00Z",
      attributes: { "event.name": "test.event" },
    };
    expect(synthesizeEventId(inputs)).toBe(synthesizeEventId(inputs));
  });

  it("produces different ids for different inputs", () => {
    const a = synthesizeEventId({ ts: "2026-05-12T00:00:00Z", attributes: { "event.name": "test.a" } });
    const b = synthesizeEventId({ ts: "2026-05-12T00:00:00Z", attributes: { "event.name": "test.b" } });
    expect(a).not.toBe(b);
  });

  it("tolerates null/undefined trace/span and missing attributes", () => {
    const id = synthesizeEventId({ ts: "2026-05-12T00:00:00Z" });
    expect(id.length).toBe(32);
  });
});

describe("buildCanonicalEvent — id (CTL-344)", () => {
  function build(): CanonicalEvent {
    return buildCanonicalEvent({
      ts: "2026-05-08T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: { "event.name": "github.pr.merged" },
      body: {},
    });
  }

  it("populates a non-empty id on every build", () => {
    const ev = build();
    expect(typeof ev.id).toBe("string");
    expect(ev.id.length).toBeGreaterThanOrEqual(16);
  });

  it("two builds with identical inputs produce different ids", () => {
    expect(build().id).not.toBe(build().id);
  });

  it("traceId / spanId stay deterministic — twin property preserved", () => {
    function buildWithIds(): CanonicalEvent {
      return buildCanonicalEvent({
        ts: "2026-05-08T18:00:00.000Z",
        severityText: "INFO",
        traceId: deriveTraceId("orch-foo", null),
        spanId: deriveSpanId("CTL-300", null),
        resource: { "service.name": "catalyst.github" },
        attributes: { "event.name": "github.pr.merged" },
        body: {},
      });
    }
    const a = buildWithIds();
    const b = buildWithIds();
    expect(a.traceId).toBe(b.traceId);
    expect(a.spanId).toBe(b.spanId);
    expect(a.id).not.toBe(b.id);
  });
});

describe("pluginVersion", () => {
  it("returns the catalyst-dev plugin version (semver)", () => {
    const v = pluginVersion();
    expect(/^\d+\.\d+\.\d+/.test(v)).toBe(true);
  });

  it("is cached (same value across calls)", () => {
    expect(pluginVersion()).toBe(pluginVersion());
  });
});
