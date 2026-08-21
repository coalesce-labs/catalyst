// entitlement-enforce.test.mjs — CTL-1785 Phase 4. Enforce actually sheds
// unentitled hosts (self always admitted; total-outage degrades to the full
// roster), the ordering constraint holds (and its assertion fires on an inverted
// fixture), and losing self-entitlement revokes held work leases via the
// now-wired emitFenceReleased.
import { test, expect, beforeEach } from "bun:test";
import {
  ENTITLEMENT_TTL_MS,
  WORK_LEASE_TTL_MS,
  assertEntitlementOrdering,
} from "../lib/entitlement.mjs";
import { getEntitledHosts, __resetEntitlementShedState } from "./config.mjs";
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

// --- enforce restores --- (CTL-2108)

test("restore is emitted when a previously-shed host returns to the kept roster", () => {
  const provider = {
    ttlMs: 1,
    check: () => ({ verdict: "entitled" }),
  };
  const calls = [];
  const result = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(["dead"]),
  });
  expect(result).toEqual(["mini", "dead"]);
  expect(calls.map((c) => c.name)).toEqual(["entitlement.restored.dead"]);
  expect(calls[0].payload).toMatchObject({ host: "dead", self: "mini", mode: "enforce" });
});

test("no restore when the host was never shed", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const calls = [];
  resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(),
  });
  expect(calls.length).toBe(0);
});

test("no restore when the host is still unentitled (re-shed instead)", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  const calls = [];
  const result = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(["dead"]),
  });
  expect(result).toEqual(["mini"]);
  expect(calls.map((c) => c.name)).toEqual(["entitlement.shed.dead"]);
  expect(calls.map((c) => c.name)).not.toContain("entitlement.restored.dead");
});

test("self is never restored even if in previouslyShedHosts", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  const calls = [];
  resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(["mini"]),
  });
  const names = calls.map((c) => c.name);
  expect(names).not.toContain("entitlement.restored.mini");
});

test("no restore on the total-outage degrade (self absent)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  const calls = [];
  const result = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["a", "b"],
    self: "c",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(["a"]),
  });
  expect(result).toEqual(["a", "b"]);
  expect(calls.length).toBe(0);
});

test("fail-open keep of a previously-shed host emits restore", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => {
      if (host === "flaky") throw new Error("authority unreachable");
      return { verdict: "entitled" };
    },
  };
  const calls = [];
  const result = resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "flaky"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    previouslyShedHosts: new Set(["flaky"]),
  });
  expect(result).toEqual(["mini", "flaky"]);
  expect(calls.map((c) => c.name)).toContain("entitlement.restored.flaky");
});

test("previouslyShedHosts defaults to empty (no restore emits without opt-in)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const calls = [];
  resolveEntitledRoster({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls.push({ name, payload }),
    // no previouslyShedHosts
  });
  expect(calls.length).toBe(0);
});

// --- getEntitledHosts shed-state tracking --- (CTL-2108)

beforeEach(() => {
  __resetEntitlementShedState();
});

test("two-tick restore: provider verdict flips → shed on tick 1, restored on tick 2", () => {
  let callCount = 0;
  const provider = {
    ttlMs: 1,
    check: ({ host }) => {
      if (host !== "dead") return { verdict: "entitled" };
      return { verdict: callCount === 0 ? "unentitled" : "entitled" };
    },
  };
  const calls1 = [];
  callCount = 0;
  getEntitledHosts({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls1.push({ name, payload }),
    trackShedState: true,
  });
  callCount = 1;
  const calls2 = [];
  getEntitledHosts({
    mode: "enforce",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit: (name, payload) => calls2.push({ name, payload }),
    trackShedState: true,
  });
  expect(calls1.map((c) => c.name)).toContain("entitlement.shed.dead");
  expect(calls2.map((c) => c.name)).toContain("entitlement.restored.dead");
});

test("still-shed host is not re-restored across ticks", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  const calls = [];
  const emit = (name, payload) => calls.push({ name, payload });
  getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit, trackShedState: true });
  getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit, trackShedState: true });
  const names = calls.map((c) => c.name);
  expect(names).not.toContain("entitlement.restored.dead");
});

test("trackShedState defaults off: no restore emitted without opt-in", () => {
  let callCount = 0;
  const provider = {
    ttlMs: 1,
    check: ({ host }) => {
      if (host !== "dead") return { verdict: "entitled" };
      return { verdict: callCount === 0 ? "unentitled" : "entitled" };
    },
  };
  const calls = [];
  const emit = (name, payload) => calls.push({ name, payload });
  callCount = 0;
  getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit });
  callCount = 1;
  getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit });
  expect(calls.map((c) => c.name)).not.toContain("entitlement.restored.dead");
});

test("shadow mode never accumulates shed state (no restore even with trackShedState)", () => {
  let callCount = 0;
  const provider = {
    ttlMs: 1,
    check: ({ host }) => {
      if (host !== "dead") return { verdict: "entitled" };
      return { verdict: callCount === 0 ? "unentitled" : "entitled" };
    },
  };
  const calls = [];
  const emit = (name, payload) => calls.push({ name, payload });
  callCount = 0;
  getEntitledHosts({ mode: "shadow", provider, hosts: ["mini", "dead"], self: "mini", emit, trackShedState: true });
  callCount = 1;
  getEntitledHosts({ mode: "shadow", provider, hosts: ["mini", "dead"], self: "mini", emit, trackShedState: true });
  expect(calls.map((c) => c.name)).not.toContain("entitlement.restored.dead");
});

test("__resetEntitlementShedState clears accumulated state", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  getEntitledHosts({ mode: "enforce", provider, hosts: ["mini", "dead"], self: "mini", emit: () => {}, trackShedState: true });
  __resetEntitlementShedState();
  const provider2 = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const calls = [];
  getEntitledHosts({ mode: "enforce", provider: provider2, hosts: ["mini", "dead"], self: "mini", emit: (name, payload) => calls.push({ name, payload }), trackShedState: true });
  expect(calls.map((c) => c.name)).not.toContain("entitlement.restored.dead");
});
