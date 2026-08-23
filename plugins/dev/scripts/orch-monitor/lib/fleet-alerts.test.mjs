// fleet-alerts.test.mjs — CTL-2161. The board's fleet alert strip.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldFleetAlerts,
  readFleetAlerts,
  ALERT_RAISED,
  ALERT_CLEARED,
  ALERT_KIND_TITLES,
} from "./fleet-alerts.mjs";
import {
  ALERT_RAISED as BROKER_RAISED,
  ALERT_CLEARED as BROKER_CLEARED,
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
  ALERT_KIND_SYSTEM_STALL,
  ALERT_KIND_SYSTEM_DOWN,
} from "../../broker/alert-emit.mjs";

const ev = (name, kind, payload = {}, ts = "2026-08-21T00:00:00Z") => ({
  ts,
  attributes: { "event.name": name, "event.entity": "alert", "event.label": kind },
  body: { payload: { kind, ...payload } },
});

describe("parity with the broker's own constants (the deliberate local mirror)", () => {
  it("the event names match broker/alert-emit.mjs exactly", () => {
    expect(ALERT_RAISED).toBe(BROKER_RAISED);
    expect(ALERT_CLEARED).toBe(BROKER_CLEARED);
  });

  it("every broker alert KIND has an operator-facing title", () => {
    // Without this pin a new broker alert renders as a bare snake_case token.
    for (const kind of [
      ALERT_KIND_PROVIDER_DEGRADED,
      ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      ALERT_KIND_CAPACITY_UNAVAILABLE,
      ALERT_KIND_SYSTEM_STALL,
      ALERT_KIND_SYSTEM_DOWN,
    ]) {
      expect(ALERT_KIND_TITLES[kind]).toBeTruthy();
    }
  });
});

describe("foldFleetAlerts — ONE row per CONDITION, never per ticket", () => {
  it("forty overloaded tickets are ONE row (the whole point of the epic)", () => {
    // The broker's level alarm already fans them in; a re-raise at a higher level
    // must UPDATE the row, not add one. If this ever returns 40 rows the strip has
    // re-created the per-ticket bin `needs-human` was.
    const out = foldFleetAlerts([
      ev(ALERT_RAISED, "provider_degraded", { count: 3 }, "2026-08-21T10:00:00Z"),
      ev(ALERT_RAISED, "provider_degraded", { count: 21 }, "2026-08-21T10:05:00Z"),
      ev(ALERT_RAISED, "provider_degraded", { count: 40 }, "2026-08-21T10:09:00Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(40);
    // The clock anchors on the FIRST raise, not the newest.
    expect(out[0].raisedAt).toBe("2026-08-21T10:00:00Z");
  });

  it("cleared removes the row (auto-clearing is the contract)", () => {
    const out = foldFleetAlerts([
      ev(ALERT_RAISED, "provider_degraded"),
      ev(ALERT_CLEARED, "provider_degraded"),
    ]);
    expect(out).toEqual([]);
    // POSITIVE CONTROL: without the clear the same input yields a row, so the []
    // above is the clear and not a broken parser.
    expect(foldFleetAlerts([ev(ALERT_RAISED, "provider_degraded")])).toHaveLength(1);
  });

  it("distinct kinds are distinct rows", () => {
    const out = foldFleetAlerts([
      ev(ALERT_RAISED, "provider_degraded"),
      ev(ALERT_RAISED, "capacity_unavailable"),
    ]);
    expect(out.map((a) => a.kind).sort()).toEqual(["capacity_unavailable", "provider_degraded"]);
  });

  it("a re-raise after a clear starts a NEW clock", () => {
    const out = foldFleetAlerts([
      ev(ALERT_RAISED, "system_stall", {}, "2026-08-21T01:00:00Z"),
      ev(ALERT_CLEARED, "system_stall", {}, "2026-08-21T02:00:00Z"),
      ev(ALERT_RAISED, "system_stall", {}, "2026-08-21T03:00:00Z"),
    ]);
    expect(out[0].raisedAt).toBe("2026-08-21T03:00:00Z");
  });

  it("⛔ a MALFORMED envelope is skipped, NEVER treated as a clear", () => {
    // Silently clearing a live alert on a bad line is the failure this fold exists
    // to avoid — the board would go quiet mid-outage.
    const out = foldFleetAlerts([
      ev(ALERT_RAISED, "provider_degraded"),
      { attributes: { "event.name": ALERT_CLEARED } }, // no kind anywhere
      { nonsense: true },
      null,
    ]);
    expect(out).toHaveLength(1);
  });

  it("non-alert events are ignored entirely", () => {
    const out = foldFleetAlerts([
      { attributes: { "event.name": "ticket.escalated", "event.label": "CTL-1" } },
      ev(ALERT_RAISED, "provider_degraded"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("an UNKNOWN kind renders by its raw kind rather than disappearing", () => {
    const out = foldFleetAlerts([ev(ALERT_RAISED, "some_future_kind")]);
    expect(out[0].title).toBe("some_future_kind");
  });

  it("empty / absent input is []", () => {
    expect(foldFleetAlerts([])).toEqual([]);
    expect(foldFleetAlerts(undefined)).toEqual([]);
  });
});

describe("readFleetAlerts — bounded and FAIL-OPEN", () => {
  it("reads a real log tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-alerts-"));
    const p = join(dir, "log.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ attributes: { "event.name": "worker.transition" } }),
        JSON.stringify(ev(ALERT_RAISED, "capacity_unavailable", { count: 2, reason: "mini-2" })),
      ].join("\n") + "\n",
    );
    const out = await readFleetAlerts({ logPath: p });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("capacity_unavailable");
    expect(out[0].reason).toBe("mini-2");
  });

  it("an absent log is [] — never a throw out of the board assemble", async () => {
    expect(await readFleetAlerts({ logPath: "/nope/does/not/exist.jsonl" })).toEqual([]);
  });

  it("a truncated final line does not lose the earlier alerts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-alerts-"));
    const p = join(dir, "log.jsonl");
    writeFileSync(
      p,
      JSON.stringify(ev(ALERT_RAISED, "provider_degraded")) +
        '\n{"attributes":{"event.name":"catalyst.alert.rai',
    );
    expect(await readFleetAlerts({ logPath: p })).toHaveLength(1);
  });
});
