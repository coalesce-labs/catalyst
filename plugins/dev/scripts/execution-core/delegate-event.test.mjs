// delegate-event.test.mjs — CTL-1774 Phase 2: delegate-event.mjs leaf emitter
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-event.test.mjs
import { describe, test, expect } from "bun:test";
import {
  buildDelegateEvent,
  appendDelegateEvent,
} from "./delegate-event.mjs";

// ─── broker namespace-contract import ────────────────────────────────────────
// Import isBrokerProtectedName from the broker package directly.
// The broker package needs its own pino install; if that's absent in this env
// the namespace-safety test falls back to a local mirror of the predicate.
let isBrokerProtectedName;
try {
  const m = await import("../broker/namespace-contract.mjs");
  isBrokerProtectedName = m.isBrokerProtectedName;
} catch {
  // Minimal mirror: delegate.* is not in FORBIDDEN_PREFIXES ("filter." / "broker.daemon")
  // and not in PROTECTED_EXACT_NAMES ("session.heartbeat").
  isBrokerProtectedName = (name) =>
    name.startsWith("filter.") ||
    name.startsWith("broker.daemon") ||
    name === "session.heartbeat";
}

// ─── buildDelegateEvent ───────────────────────────────────────────────────────

describe("buildDelegateEvent", () => {
  test("envelope shape — parseable JSON line ending with \\n", () => {
    const line = buildDelegateEvent({
      name: "delegate.would-route",
      ticket: "CTL-9",
      site: "terminal-sweep",
      reason: "stalled",
      orchId: "CTL-9",
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
  });

  test("attributes['event.name'] and body.payload.site present", () => {
    const line = buildDelegateEvent({
      name: "delegate.would-route",
      ticket: "CTL-9",
      site: "terminal-sweep",
      reason: "stalled",
      orchId: "CTL-9",
    });
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("delegate.would-route");
    expect(ev.attributes["event.action"]).toBe("would-route");
    expect(ev.body.payload.site).toBe("terminal-sweep");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("all three names produce the correct event.action split", () => {
    for (const [name, action] of [
      ["delegate.would-route", "would-route"],
      ["delegate.routed", "routed"],
      ["delegate.route-fallback", "route-fallback"],
    ]) {
      const ev = JSON.parse(buildDelegateEvent({ name, ticket: "CTL-1" }));
      expect(ev.attributes["event.name"]).toBe(name);
      expect(ev.attributes["event.action"]).toBe(action);
    }
  });

  test("orchId falls back to ticket when not provided", () => {
    const ev = JSON.parse(buildDelegateEvent({ name: "delegate.would-route", ticket: "CTL-42" }));
    expect(ev.attributes["catalyst.orchestration"]).toBe("CTL-42");
  });

  test("orchId is used when provided", () => {
    const ev = JSON.parse(buildDelegateEvent({
      name: "delegate.would-route",
      ticket: "CTL-42",
      orchId: "CTL-99",
    }));
    expect(ev.attributes["catalyst.orchestration"]).toBe("CTL-99");
  });

  test("resource contains service.name === 'catalyst.execution-core'", () => {
    const ev = JSON.parse(buildDelegateEvent({ name: "delegate.would-route", ticket: "CTL-1" }));
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.resource["service.namespace"]).toBe("catalyst");
  });
});

// ─── appendDelegateEvent ─────────────────────────────────────────────────────

describe("appendDelegateEvent", () => {
  test("happy path — appends exactly one line and returns true", () => {
    const lines = [];
    const result = appendDelegateEvent(
      { name: "delegate.would-route", ticket: "CTL-9", site: "manual", reason: "smoke" },
      (line) => lines.push(line),
    );
    expect(result).toBe(true);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.attributes["event.name"]).toBe("delegate.would-route");
  });

  test("returns false (never throws) when append throws", () => {
    const result = appendDelegateEvent(
      { name: "delegate.would-route", ticket: "CTL-9" },
      () => { throw new Error("no write"); },
    );
    expect(result).toBe(false);
  });
});

// ─── namespace safety ────────────────────────────────────────────────────────

describe("delegate.* namespace safety", () => {
  test("none of the three delegate names are broker-protected", () => {
    for (const name of ["delegate.would-route", "delegate.routed", "delegate.route-fallback"]) {
      expect(isBrokerProtectedName(name)).toBe(false);
    }
  });
});
