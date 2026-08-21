// entitlement-shadow.test.mjs — CTL-1785 Phase 3. Shadow mode observes would-shed
// and emits `entitlement.would-shed.<host>` but changes NOTHING (still returns the
// full roster). The safe dry-run (mirrors CTL-1609 delegate-first shadow).
import { test, expect } from "bun:test";
import { getEntitledHosts } from "./config.mjs";
import { resolveEntitledRoster } from "./entitlement-roster.mjs";

// mockEmit — records (name, payload) calls; `.emitted(name)` checks a substring
// against the recorded names (the emitted name is `entitlement.would-shed.<host>`).
function mockEmit() {
  const calls = [];
  const fn = (name, payload) => calls.push({ name, payload });
  fn.calls = calls;
  fn.names = () => calls.map((c) => c.name);
  fn.emitted = (name) => calls.some((c) => c.name === name);
  return fn;
}

test("shadow: unentitled rostered host emits entitlement.would-shed but roster is unchanged", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({ verdict: host === "dead" ? "unentitled" : "entitled" }),
  };
  const emit = mockEmit();
  const hosts = getEntitledHosts({
    mode: "shadow",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit,
  });
  expect(hosts).toEqual(["mini", "dead"]); // NO behavior change in shadow
  expect(emit.emitted("entitlement.would-shed.dead")).toBe(true);
  expect(emit.emitted("entitlement.would-shed.mini")).toBe(false);
});

test("shadow: the would-shed payload carries host/self/reason/mode", () => {
  const provider = {
    ttlMs: 1,
    check: ({ host }) => ({
      verdict: host === "dead" ? "unentitled" : "entitled",
      reason: host === "dead" ? "absent-from-local-roster" : "present-in-local-roster",
    }),
  };
  const emit = mockEmit();
  getEntitledHosts({ mode: "shadow", provider, hosts: ["mini", "dead"], self: "mini", emit });
  const call = emit.calls.find((c) => c.name === "entitlement.would-shed.dead");
  expect(call).toBeTruthy();
  expect(call.payload).toMatchObject({ host: "dead", self: "mini", mode: "shadow" });
  expect(call.payload.reason).toBe("absent-from-local-roster");
});

test("shadow: fully-entitled roster emits nothing (positive control of the emit path)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  const emit = mockEmit();
  const hosts = getEntitledHosts({ mode: "shadow", provider, hosts: ["mini", "mini-2"], self: "mini", emit });
  expect(hosts).toEqual(["mini", "mini-2"]);
  expect(emit.calls.length).toBe(0);
});

test("shadow: a throwing provider fails open (no shed, no emit)", () => {
  const provider = {
    ttlMs: 1,
    check: () => {
      throw new Error("authority unreachable");
    },
  };
  const emit = mockEmit();
  const hosts = resolveEntitledRoster({
    mode: "shadow",
    provider,
    hosts: ["mini", "dead"],
    self: "mini",
    emit,
  });
  expect(hosts).toEqual(["mini", "dead"]); // fail-open preserves the roster
  expect(emit.calls.length).toBe(0); // a throw is ENTITLED → nothing would-shed
});

test("resolveEntitledRoster never throws on a malformed roster", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "unentitled" }) };
  expect(() => resolveEntitledRoster({ mode: "shadow", provider, hosts: null, self: "mini" })).not.toThrow();
  expect(resolveEntitledRoster({ mode: "shadow", provider, hosts: null, self: "mini" })).toBe(null);
});
