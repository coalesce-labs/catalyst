import { describe, test, expect } from "bun:test";
import { checkLivenessAnchor, STATUS } from "../doctor.mjs";

const ok = {
  ok: true, found: true, identifier: "CAT-1", stateName: "In Progress",
  stateType: "started", archived: false, closed: false, error: null,
};

const deps = (over = {}) => ({
  getLivenessAnchorIssue: () => "CAT-1",
  getLivenessReadSource: () => "linear",
  hasLinearToken: () => true,
  readAnchorHealth: async () => ok,
  ...over,
});

describe("checkLivenessAnchor (CAT-46)", () => {
  test("PASS on a healthy open anchor", async () => {
    const [check] = await checkLivenessAnchor(deps());
    expect(check.name).toBe("liveness-anchor");
    expect(check.status).toBe(STATUS.PASS);
    expect(check.detail).toContain("CAT-1");
  });

  test("INFO when no anchor is configured", async () => {
    const [check] = await checkLivenessAnchor(deps({ getLivenessAnchorIssue: () => null }));
    expect(check.status).toBe(STATUS.INFO);
    expect(check.detail).toContain("catalyst.cluster.livenessAnchorIssue");
  });

  test("INFO when the read source is loki without probing", async () => {
    let probed = false;
    const [check] = await checkLivenessAnchor(deps({
      getLivenessReadSource: () => "loki",
      readAnchorHealth: async () => { probed = true; return ok; },
    }));
    expect(check.status).toBe(STATUS.INFO);
    expect(probed).toBe(false);
  });

  test("FAIL when the anchor does not resolve", async () => {
    const [check] = await checkLivenessAnchor(deps({
      readAnchorHealth: async () => ({ ...ok, ok: false, found: false, identifier: null }),
    }));
    expect(check.status).toBe(STATUS.FAIL);
    expect(check.detail).toMatch(/does not resolve|deleted/i);
  });

  test("FAIL when the anchor is archived", async () => {
    const [check] = await checkLivenessAnchor(deps({
      readAnchorHealth: async () => ({ ...ok, ok: false, archived: true, closed: true, stateType: "completed", stateName: "Done" }),
    }));
    expect(check.status).toBe(STATUS.FAIL);
    expect(check.detail).toMatch(/archived/i);
  });

  test("WARN when the anchor is closed but present", async () => {
    const [check] = await checkLivenessAnchor(deps({
      readAnchorHealth: async () => ({ ...ok, closed: true, stateType: "completed", stateName: "Done" }),
    }));
    expect(check.status).toBe(STATUS.WARN);
    expect(check.detail).toMatch(/reopen|still serves/i);
  });

  test("WARN with no Linear token", async () => {
    const [check] = await checkLivenessAnchor(deps({ hasLinearToken: () => false }));
    expect(check.status).toBe(STATUS.WARN);
  });

  test("WARN on a transport error", async () => {
    const [check] = await checkLivenessAnchor(deps({
      readAnchorHealth: async () => ({ ...ok, ok: false, found: null, error: "http 500" }),
    }));
    expect(check.status).toBe(STATUS.WARN);
    expect(check.detail).toContain("http 500");
  });

  test("never throws even if a dependency throws", async () => {
    const [check] = await checkLivenessAnchor(deps({
      readAnchorHealth: async () => { throw new Error("boom"); },
    }));
    expect(check.status).toBe(STATUS.WARN);
    expect(check.detail).toContain("boom");
  });

  test("is registered in the worker check set", async () => {
    const src = await Bun.file(new URL("../doctor.mjs", import.meta.url)).text();
    expect(src).toContain("checkLivenessAnchor()");
  });
});
