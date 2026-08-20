// entitlement-enforce.test.mjs — CTL-1785 Phase 4. Enforce actually sheds
// unentitled hosts (self always admitted; total-outage degrades to the full
// roster), the ordering constraint holds (and its assertion fires on an inverted
// fixture), and losing self-entitlement revokes held work leases via the
// now-wired emitFenceReleased.
import { test, expect } from "bun:test";
import {
  ENTITLEMENT_TTL_MS,
  WORK_LEASE_TTL_MS,
  assertEntitlementOrdering,
} from "../lib/entitlement.mjs";
import { getEntitledHosts } from "./config.mjs";
import { resolveEntitledRoster } from "./entitlement-roster.mjs";
import { revokeLeasesOnEntitlementLoss } from "./entitlement-revoke.mjs";

const noEmit = () => {};

// --- ordering constraint ---
test("ordering constraint holds: entitlement TTL > work-lease TTL", () => {
  expect(ENTITLEMENT_TTL_MS).toBeGreaterThan(WORK_LEASE_TTL_MS);
});

test("assertEntitlementOrdering FIRES on a deliberately-inverted TTL fixture", () => {
  expect(() => assertEntitlementOrdering(1000, 2000)).toThrow(/ordering violated/);
  // and passes on a valid pair
  expect(assertEntitlementOrdering(2000, 1000)).toBe(true);
});

// --- enforce sheds ---
test("enforce sheds an unentitled host from the entitlement roster", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  expect(
    getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit: noEmit })
  ).toEqual(["mini"]); // dead is shed
});

test("enforce emits entitlement.shed.<host> on a real shed", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  const calls = [];
  getEntitledHosts({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
  });
  expect(calls.map((c) => c.name)).toEqual(["entitlement.shed.dead"]);
  expect(calls[0].payload).toMatchObject({ host: "dead", self: "mini", mode: "enforce" });
});

test("enforce ALWAYS admits self even if the provider says unentitled", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) }; // everyone unentitled
  // self is in the roster → admitted; the other host is shed → result is [self].
  expect(
    resolveEntitledRoster({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit: noEmit })
  ).toEqual(["mini"]);
});

test("enforce with all entitled is byte-identical to the input roster (no shed)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const calls = [];
  const out = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "mini-2"],
    self: "mini",
    emit: (n, p) => calls.push({ n, p }),
  });
  expect(out).toEqual(["mini", "mini-2"]);
  expect(calls.length).toBe(0);
});

test("shed roster is never empty: total loss (self absent) degrades to the full roster", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  // self is NOT in the roster, so self-always-admit can't save it; shedding all
  // would empty the roster → degrade to the full roster rather than strand the fleet.
  const calls = [];
  const out = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["a", "b"],
    self: "c",
    emit: (n, p) => calls.push({ n, p }),
  });
  expect(out).toEqual(["a", "b"]);
  expect(calls.length).toBe(0); // degrade emits no shed (nothing was actually removed)
});

test("enforce fail-open: a throwing provider keeps the host (never sheds on doubt)", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => {
      if (host === "flaky") throw new Error("authority unreachable");
      return { verdict: "entitled" };
    },
  };
  expect(
    resolveEntitledRoster({ mode: "enforce", provider, hosts: ["mini", "flaky"], self: "mini", emit: noEmit })
  ).toEqual(["mini", "flaky"]); // flaky is kept (inconclusive → entitled)
});

// --- revoke-on-loss ---
test("losing self-entitlement revokes held work leases (fence.released per owned ticket)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) }; // self lapsed
  const released = [];
  const r = revokeLeasesOnEntitlementLoss({
    self: "mini",
    ownedTickets: ["CTL-1", "CTL-2"],
    provider,
    mode: "enforce",
    emitReleased: ({ ticket }) => released.push(ticket),
  });
  expect(released).toEqual(["CTL-1", "CTL-2"]);
  expect(r.revoked).toEqual(["CTL-1", "CTL-2"]);
  expect(r.reason).toBe("self-entitlement-lapsed");
});

test("still-entitled self revokes nothing (positive control of the revoke path)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const released = [];
  const r = revokeLeasesOnEntitlementLoss({
    self: "mini",
    ownedTickets: ["CTL-1"],
    provider,
    mode: "enforce",
    emitReleased: ({ ticket }) => released.push(ticket),
  });
  expect(released).toEqual([]);
  expect(r.reason).toBe("self-still-entitled");
});

test("revoke is a no-op outside enforce mode", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  const released = [];
  for (const mode of ["off", "shadow", undefined]) {
    revokeLeasesOnEntitlementLoss({
      self: "mini",
      ownedTickets: ["CTL-1"],
      provider,
      mode,
      emitReleased: ({ ticket }) => released.push(ticket),
    });
  }
  expect(released).toEqual([]);
});

test("revoke wires the REAL emitFenceReleased (produces fence.released.<ticket>)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  const appended = [];
  // Default emitReleased is the real emitFenceReleased; its append seam receives
  // the SERIALIZED event line (buildFenceEvent returns a JSON string + "\n"), so
  // parse it to assert the event name the real builder produces.
  revokeLeasesOnEntitlementLoss({
    self: "mini",
    ownedTickets: ["CTL-7"],
    provider,
    mode: "enforce",
    append: (line) => appended.push(JSON.parse(line)),
  });
  const names = appended.map((e) => e?.attributes?.["event.name"]);
  expect(names).toContain("fence.released.CTL-7");
  // fence.released carries owner_host:null (the release semantics).
  expect(appended[0].body.payload).toMatchObject({ ticket: "CTL-7", owner_host: null });
});

test("a failed release (emitReleased returns false) is NOT counted as revoked", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  // emitFenceReleased returns false on an append failure; the honest accounting
  // must not claim a release the reclaim loop will never see.
  const r = revokeLeasesOnEntitlementLoss({
    self: "mini",
    ownedTickets: ["CTL-1", "CTL-2"],
    provider,
    mode: "enforce",
    emitReleased: ({ ticket }) => (ticket === "CTL-1" ? false : true),
  });
  expect(r.revoked).toEqual(["CTL-2"]); // CTL-1's append failed → not revoked
});

test("a throwing self-check fails open: never revokes on an unanswerable authority", () => {
  const provider = {
    ttlMs: 1,
    check: () => {
      throw new Error("authority unreachable");
    },
  };
  const released = [];
  const r = revokeLeasesOnEntitlementLoss({
    self: "mini",
    ownedTickets: ["CTL-1"],
    provider,
    mode: "enforce",
    emitReleased: ({ ticket }) => released.push(ticket),
  });
  expect(released).toEqual([]);
  expect(r.reason).toBe("self-still-entitled");
});
