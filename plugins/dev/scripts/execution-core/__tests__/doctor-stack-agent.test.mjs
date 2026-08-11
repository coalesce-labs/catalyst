import { describe, test, expect } from "bun:test";
import { checkStackAgent, STATUS } from "../doctor.mjs";

const supervised = `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>catalyst-stack</string><string>start</string><string>--supervised</string></array><key>StartInterval</key><integer>600</integer></dict></plist>`;

function deps(overrides = {}) {
  return {
    readPlist: () => supervised,
    runLaunchctl: () => ({ loaded: true }),
    readHaltMarker: () => null,
    nowMs: () => Date.parse("2026-08-11T22:00:00Z"),
    ...overrides,
  };
}

describe("checkStackAgent", () => {
  test("requires every I/O seam", () => {
    expect(() => checkStackAgent()).toThrow(/readPlist/);
    expect(() => checkStackAgent({ readPlist: () => null })).toThrow(/runLaunchctl/);
  });

  test("absent plist fails with install command", () => {
    const rows = checkStackAgent(deps({ readPlist: () => null }));
    expect(rows[0].status).toBe(STATUS.FAIL);
    expect(rows[0].detail).toContain("catalyst-stack install-services");
  });

  test("unloaded agent fails", () => {
    const rows = checkStackAgent(deps({ runLaunchctl: () => ({ loaded: false }) }));
    expect(rows[0].status).toBe(STATUS.FAIL);
    expect(rows[0].detail).toMatch(/not loaded/i);
  });

  test("stale plist warns that stops are undone", () => {
    const rows = checkStackAgent(deps({ readPlist: () => supervised.replace("<string>--supervised</string>", "") }));
    expect(rows[0].status).toBe(STATUS.WARN);
    expect(rows[0].detail).toMatch(/undone within 600s/i);
    expect(rows[0].detail).toContain("catalyst-stack install-services");
  });

  test("loaded supervised agent passes", () => {
    expect(checkStackAgent(deps())[0].status).toBe(STATUS.PASS);
  });

  test("active marker is visible, expired marker is not", () => {
    const active = checkStackAgent(deps({ readHaltMarker: () => ({ haltedAt: 1786482000, ttlSecs: 7200, reason: "maintenance" }) }));
    expect(active.some((r) => r.name === "stack-halt" && [STATUS.INFO, STATUS.WARN].includes(r.status))).toBe(true);
    expect(active.find((r) => r.name === "stack-halt").detail).toContain("maintenance");

    const expired = checkStackAgent(deps({ readHaltMarker: () => ({ haltedAt: 1786442400, ttlSecs: 60, reason: "old" }) }));
    expect(expired.some((r) => r.name === "stack-halt")).toBe(false);
  });
});
