// entitlement-audit.test.mjs — CTL-1785 Phase 3. The W13 acceptance query:
// the ABSENCE (a lease held by an unentitled host → must be 0) and its mandatory
// POSITIVE CONTROL (a lease held by an entitled host → must be > 0 when work
// exists). A bare zero over zero leases is `inconclusive`, never a clean pass.
import { test, expect } from "bun:test";
import { auditEntitlementLeases } from "./entitlement-audit.mjs";

// v3 bare-name event object (flat payload at top level).
const ev = (name, extra = {}) => ({ ts: "2026-08-20T00:00:00Z", name, ...extra });
// fence.claimed carries owner_host in the flat payload + the attribute mirror.
const claimed = (ticket, host) =>
  ev(`fence.claimed.${ticket}`, { ticket, owner_host: host, attributes: { "catalyst.host.name": host } });
const released = (ticket) => ev(`fence.released.${ticket}`, { ticket, owner_host: null });
const shed = (host) => ev(`entitlement.shed.${host}`, { host });
const restored = (host) => ev(`entitlement.restored.${host}`, { host });

test("acceptance query: absence=0 when every lease-holder is entitled", () => {
  const events = [claimed("CTL-1", "mini"), claimed("CTL-2", "mini-2")];
  const r = auditEntitlementLeases(events);
  expect(r.absence).toBe(0);
  expect(r.inconclusive).toBe(false);
});

test("acceptance query POSITIVE CONTROL: returns non-zero when an entitled node holds work", () => {
  const events = [claimed("CTL-1", "mini"), claimed("CTL-2", "mini-2")];
  const r = auditEntitlementLeases(events);
  expect(r.positiveControl).toBeGreaterThan(0);
});

test("absence>0: a lease held by a shed (unentitled) host is counted", () => {
  const events = [claimed("CTL-1", "mini"), claimed("CTL-2", "dead"), shed("dead")];
  const r = auditEntitlementLeases(events);
  expect(r.absence).toBe(1); // CTL-2 held by shed host `dead`
  expect(r.positiveControl).toBe(1); // CTL-1 held by entitled `mini`
  expect(r.shedHolders).toEqual(["CTL-2"]);
  expect(r.inconclusive).toBe(false);
});

test("a restored host is entitled again — its lease no longer counts as absence", () => {
  const events = [claimed("CTL-2", "dead"), shed("dead"), restored("dead")];
  const r = auditEntitlementLeases(events);
  expect(r.absence).toBe(0);
  expect(r.positiveControl).toBe(1);
});

test("a released lease is not a live hold (neither absence nor positive control)", () => {
  const events = [claimed("CTL-1", "mini"), released("CTL-1")];
  const r = auditEntitlementLeases(events);
  expect(r.heldTickets).toBe(0);
  expect(r.inconclusive).toBe(true); // no live leases → cannot see a hit
  expect(r.reason).toBe("no-live-leases-in-log");
});

test("empty / no-lease log is INCONCLUSIVE, never a clean absence:0", () => {
  expect(auditEntitlementLeases([]).inconclusive).toBe(true);
  expect(auditEntitlementLeases([shed("dead")]).inconclusive).toBe(true);
});

test("malformed input is inconclusive, never a false clean pass", () => {
  expect(auditEntitlementLeases(null).inconclusive).toBe(true);
  expect(auditEntitlementLeases(undefined).reason).toBe("events-not-an-array");
});

test("resolves the name via the event-name boundary (attributes[event.name])", () => {
  // v2 superset shape: name lives in attributes["event.name"], payload in body.payload.
  const v2claimed = {
    ts: "2026-08-20T00:00:00Z",
    attributes: { "event.name": "fence.claimed.CTL-9", "catalyst.host.name": "mini" },
    body: { payload: { ticket: "CTL-9", owner_host: "mini" } },
  };
  const r = auditEntitlementLeases([v2claimed]);
  expect(r.positiveControl).toBe(1);
  expect(r.inconclusive).toBe(false);
});

test("last-write-wins: a re-claim to a shed host after being on an entitled host", () => {
  const events = [claimed("CTL-1", "mini"), claimed("CTL-1", "dead"), shed("dead")];
  const r = auditEntitlementLeases(events);
  expect(r.absence).toBe(1);
  expect(r.positiveControl).toBe(0);
});
