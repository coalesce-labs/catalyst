// host-boot-identity.test.mjs — unit tests for the pure resolver (CTL-1093 Phase 1).
// Run: cd plugins/dev/scripts/execution-core && bun test host-boot-identity.test.mjs

import { test, expect } from "bun:test";
import { isHostNamePinned, resolveBootIdentity } from "./host-boot-identity.mjs";

// --- isHostNamePinned ---

test("isHostNamePinned: true when env override set", () => {
  expect(isHostNamePinned({ env: "mini", layer2Name: undefined })).toBe(true);
});
test("isHostNamePinned: true when Layer-2 name set", () => {
  expect(isHostNamePinned({ env: undefined, layer2Name: "mini" })).toBe(true);
});
test("isHostNamePinned: false when neither set", () => {
  expect(isHostNamePinned({ env: undefined, layer2Name: undefined })).toBe(false);
});
test("isHostNamePinned: false when both are empty strings", () => {
  expect(isHostNamePinned({ env: "", layer2Name: "" })).toBe(false);
});

// --- resolveBootIdentity ---

// roster=["mini","laptop"], pinned → use pinned name, record it, no warning
test("resolveBootIdentity: pinned multi-host uses + records pinned name", () => {
  const r = resolveBootIdentity({
    pinned: true, resolvedName: "mini", sticky: null, multiHost: true,
  });
  expect(r.name).toBe("mini");
  expect(r.action).toBe("record");
  expect(r.warning).toBeNull();
});

// unpinned + multi-host + sticky exists → restore sticky, loud warn
test("resolveBootIdentity: unpinned multi-host restores sticky with warning", () => {
  const r = resolveBootIdentity({
    pinned: false, resolvedName: "RyansMini250233.rozich",
    sticky: "mini", multiHost: true,
  });
  expect(r.name).toBe("mini");
  expect(r.action).toBe("restore");
  expect(r.warning).toMatch(/sticky|pin catalyst\.host\.name/i);
});

// unpinned + multi-host + no sticky → record current os name, loud warn
test("resolveBootIdentity: unpinned multi-host with no sticky records + warns", () => {
  const r = resolveBootIdentity({
    pinned: false, resolvedName: "RyansMini250233.rozich",
    sticky: null, multiHost: true,
  });
  expect(r.name).toBe("RyansMini250233.rozich");
  expect(r.action).toBe("record");
  expect(r.warning).toMatch(/no pinned|os\.hostname|pin catalyst\.host\.name/i);
});

// single-host → strict no-op: no warning regardless of pinned
test("resolveBootIdentity: single-host is a no-op (no warning)", () => {
  const r = resolveBootIdentity({
    pinned: false, resolvedName: "anything", sticky: null, multiHost: false,
  });
  expect(r.warning).toBeNull();
  expect(r.action).toBe("noop");
  expect(r.name).toBe("anything");
});

test("resolveBootIdentity: single-host pinned is also a no-op", () => {
  const r = resolveBootIdentity({
    pinned: true, resolvedName: "mini", sticky: "mini", multiHost: false,
  });
  expect(r.warning).toBeNull();
  expect(r.action).toBe("noop");
  expect(r.name).toBe("mini");
});
