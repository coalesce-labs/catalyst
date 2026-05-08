import { describe, it, expect } from "bun:test";
import {
  severityNumber,
  deriveTraceId,
  deriveSpanId,
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
