import { describe, test, expect } from "bun:test";
import { normalizeEventName, reconcile } from "./reconcile.ts";

describe("normalizeEventName", () => {
  test("strips trailing .TICKET suffix", () => {
    expect(normalizeEventName("phase.plan.complete.CTL-1008")).toBe("phase.plan.complete");
  });
  test("strips trailing session-id suffix (filter.wake.sess_…)", () => {
    expect(normalizeEventName("filter.wake.sess_20260607T104342_497673f6"))
      .toBe("filter.wake");
  });
  test("leaves suffix-free names unchanged", () => {
    expect(normalizeEventName("node.heartbeat")).toBe("node.heartbeat");
  });
});

describe("reconcile", () => {
  test("flags JSONL kinds absent from Loki as MISSING", () => {
    const jsonl = new Map([["phase.terminal.reap-requested", 110446]]);
    const loki = new Map<string, number>();
    const rows = reconcile(jsonl, loki);
    expect(rows.find(r => r.kind === "phase.terminal.reap-requested")?.status).toBe("MISSING");
  });
  test("marks kinds present on both sides within lag tolerance as OK", () => {
    const jsonl = new Map([["node.heartbeat", 1000]]);
    const loki = new Map([["node.heartbeat", 995]]);
    const rows = reconcile(jsonl, loki, { lagTolerancePct: 5 });
    expect(rows.find(r => r.kind === "node.heartbeat")?.status).toBe("OK");
  });
  test("marks counts beyond tolerance as DRIFT", () => {
    const jsonl = new Map([["github.push", 1000]]);
    const loki = new Map([["github.push", 400]]);
    const rows = reconcile(jsonl, loki, { lagTolerancePct: 5 });
    expect(rows.find(r => r.kind === "github.push")?.status).toBe("DRIFT");
  });
  test("flags kinds present in Loki but absent in JSONL as LOKI_ONLY", () => {
    const jsonl = new Map<string, number>();
    const loki = new Map([["some.loki.event", 50]]);
    const rows = reconcile(jsonl, loki);
    expect(rows.find(r => r.kind === "some.loki.event")?.status).toBe("LOKI_ONLY");
  });
});
