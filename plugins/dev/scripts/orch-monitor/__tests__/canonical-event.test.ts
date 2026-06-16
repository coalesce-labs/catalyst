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

  it("CTL-1135: emits caused_by from causedBy, null by default (additive)", () => {
    const withCause = buildCanonicalEvent({
      ts: "2026-06-15T00:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      causedBy: "evt-parent-9",
      resource: { "service.name": "catalyst.session" },
      attributes: { "event.name": "session.phase" },
      body: {},
    });
    expect(withCause.caused_by).toBe("evt-parent-9");

    const noCause = buildCanonicalEvent({
      ts: "2026-06-15T00:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: { "event.name": "session.phase" },
      body: {},
    });
    expect(noCause.caused_by).toBeNull();
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

  it("promotes linear.issue.identifier and catalyst.orchestrator.id into resource (CTL-636)", () => {
    const ev = buildCanonicalEvent({
      ts: "2026-05-25T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: {
        "event.name": "session.phase",
        "linear.issue.identifier": "CTL-636",
        "catalyst.orchestrator.id": "CTL-636",
      },
      body: {},
    });
    expect(ev.resource["linear.key"]).toBe("CTL-636");
    expect(ev.resource["catalyst.orchestration"]).toBe("CTL-636");
    // attributes must be preserved, not moved
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-636");
    expect(ev.attributes["catalyst.orchestrator.id"]).toBe("CTL-636");
  });

  it("omits the new resource keys when no orchestration context is present (CTL-636)", () => {
    // Clear the ambient env so a project= set by the orchestration test runner
    // cannot pollute the no-context assertion.
    const prev = process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    try {
      const ev = buildCanonicalEvent({
        ts: "2026-05-25T18:00:00.000Z",
        severityText: "INFO",
        traceId: null,
        spanId: null,
        resource: { "service.name": "catalyst.github" },
        attributes: { "event.name": "github.pr.merged" },
        body: {},
      });
      expect("linear.key" in ev.resource).toBe(false);
      expect("catalyst.orchestration" in ev.resource).toBe(false);
      expect("project" in ev.resource).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      else process.env.OTEL_RESOURCE_ATTRIBUTES = prev;
    }
  });

  it("prefers an explicit resource key over the attribute fallback (CTL-636)", () => {
    const ev = buildCanonicalEvent({
      ts: "2026-05-25T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session", "linear.key": "CTL-999" },
      attributes: { "event.name": "x", "linear.issue.identifier": "CTL-636" },
      body: {},
    });
    expect(ev.resource["linear.key"]).toBe("CTL-999");
  });

  it("sources project from OTEL_RESOURCE_ATTRIBUTES when present (CTL-636)", () => {
    const prev = process.env.OTEL_RESOURCE_ATTRIBUTES;
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "project=catalyst-workspace,linear.key=CTL-636,catalyst.orchestration=CTL-636";
    try {
      const ev = buildCanonicalEvent({
        ts: "2026-05-25T18:00:00.000Z",
        severityText: "INFO",
        traceId: null,
        spanId: null,
        resource: { "service.name": "catalyst.session" },
        attributes: { "event.name": "x" },
        body: {},
      });
      expect(ev.resource["project"]).toBe("catalyst-workspace");
    } finally {
      if (prev === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      else process.env.OTEL_RESOURCE_ATTRIBUTES = prev;
    }
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

  it("accepts cicd.pipeline.run.status as a typed optional attribute (CTL-366)", () => {
    const ev: CanonicalEvent = buildCanonicalEvent({
      ts: "2026-05-08T18:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: {
        "event.name": "github.workflow_run.in_progress",
        "cicd.pipeline.run.status": "in_progress",
      },
      body: {},
    });
    expect(ev.attributes["cicd.pipeline.run.status"]).toBe("in_progress");
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

describe("buildCanonicalEvent — Claude Code metadata (CTL-374)", () => {
  it("round-trips claude.* typed attributes with correct types", () => {
    const ev: CanonicalEvent = buildCanonicalEvent({
      ts: "2026-05-13T00:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: {
        "event.name": "session.context",
        "claude.session.id": "8f3b1c0e-1234-4abc-9def-0123456789ab",
        "claude.model": "claude-opus-4-7",
        "claude.context.used_pct": 24,
        "claude.context.tokens": 245000,
        "claude.turn": 126,
      },
      body: { payload: { cost_usd: 23.02, context_max: 1_000_000 } },
    });
    expect(ev.attributes["claude.session.id"]).toBe(
      "8f3b1c0e-1234-4abc-9def-0123456789ab",
    );
    expect(ev.attributes["claude.model"]).toBe("claude-opus-4-7");
    expect(ev.attributes["claude.context.used_pct"]).toBe(24);
    expect(ev.attributes["claude.context.tokens"]).toBe(245000);
    expect(ev.attributes["claude.turn"]).toBe(126);
  });

  it("does NOT permit claude.cost.usd as a typed attribute (PII gate)", () => {
    // The Attributes interface should not declare claude.cost.usd.
    // Cost lives in body.payload only — the OTLP forwarder strips body.payload.
    const ev: CanonicalEvent = buildCanonicalEvent({
      ts: "2026-05-13T00:00:00.000Z",
      severityText: "INFO",
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: { "event.name": "session.context" },
      body: { payload: { cost_usd: 23.02 } },
    });
    // Runtime check: cost must not appear in attributes (PII gate). Serialising
    // the object lets us assert key absence without casting through unknown.
    expect(JSON.stringify(ev.attributes)).not.toContain("claude.cost.usd");
    // Cost is allowed in payload.
    expect((ev.body.payload as Record<string, unknown>).cost_usd).toBe(23.02);
  });
});
