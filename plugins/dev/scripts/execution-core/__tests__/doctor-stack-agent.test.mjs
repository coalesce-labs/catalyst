import { describe, test, expect } from "bun:test";
import { checkStackAgent, STATUS, summarize } from "../doctor.mjs";

const supervised = `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>catalyst-stack</string><string>start</string><string>--supervised</string></array><key>StartInterval</key><integer>600</integer></dict></plist>`;

function deps(overrides = {}) {
  return {
    readPlist: () => supervised,
    runLaunchctl: () => ({ loaded: true }),
    readHaltMarker: () => null,
    nowMs: () => Date.parse("2026-08-11T22:00:00Z"),
    platform: "darwin",
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

  test("non-darwin host warns instead of failing the join gate", () => {
    const rows = checkStackAgent(deps({ platform: "linux" }));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("stack-agent");
    expect(rows[0].status).toBe(STATUS.WARN);
    expect(rows[0].detail).toMatch(/launchd is macOS-only/i);
    expect(rows[0].detail).toContain("linux");
    expect(summarize(rows).fail).toBe(0);
  });

  test("non-darwin platform is graded BEFORE the plist read", () => {
    const rows = checkStackAgent(deps({
      platform: "linux",
      readPlist: () => { throw new Error("ENOENT: no such file or directory"); },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(STATUS.WARN);
    expect(rows[0].detail).not.toMatch(/not installed/i);
    expect(summarize(rows).fail).toBe(0);
  });

  test("a non-darwin platform other than linux degrades too", () => {
    const rows = checkStackAgent(deps({ platform: "win32" }));
    expect(rows[0].status).toBe(STATUS.WARN);
    expect(rows[0].detail).toContain("win32");
    expect(summarize(rows).fail).toBe(0);
  });

  test("absent plist is install-remediable: WARN under preinstall, FAIL otherwise", () => {
    const pre = checkStackAgent(deps({ readPlist: () => null, preinstall: true }));
    expect(pre[0].status).toBe(STATUS.WARN);
    expect(pre[0].detail).toContain("catalyst-stack install-services");
    expect(summarize(pre).fail).toBe(0);

    const strict = checkStackAgent(deps({ readPlist: () => null, preinstall: false }));
    expect(strict[0].status).toBe(STATUS.FAIL);
    expect(summarize(strict).fail).toBe(1);
  });

  test("preinstall does NOT downgrade the unloaded rung (CAT-239 blind spot)", () => {
    const rows = checkStackAgent(deps({
      runLaunchctl: () => ({ loaded: false }),
      preinstall: true,
    }));
    expect(rows[0].status).toBe(STATUS.FAIL);
    expect(rows[0].detail).toMatch(/present but not loaded/i);
    expect(summarize(rows).fail).toBe(1);
  });

  test("platform and preinstall are optional values, not required I/O seams", () => {
    expect(() => checkStackAgent()).toThrow(/readPlist/);
    expect(() => checkStackAgent({ readPlist: () => null })).toThrow(/runLaunchctl/);

    const { platform: _p, ...noPlatform } = deps({ platform: "linux" });
    expect(() => checkStackAgent(noPlatform)).not.toThrow();
    expect(checkStackAgent(noPlatform)[0].status).toBe(STATUS.PASS);
  });

  test("non-darwin platform is graded before plist I/O", () => {
    const rows = checkStackAgent(deps({ platform: "freebsd", readPlist: () => { throw new Error("must not run"); } }));
    expect(rows[0].status).toBe(STATUS.WARN);
    expect(rows[0].detail).toContain("freebsd");
  });

  test("darwin absent plist still fails", () => {
    expect(checkStackAgent(deps({ platform: "darwin", readPlist: () => null }))[0].status).toBe(STATUS.FAIL);
  });

  test("darwin unloaded agent still fails", () => {
    expect(checkStackAgent(deps({ platform: "darwin", runLaunchctl: () => ({ loaded: false }) }))[0].status).toBe(STATUS.FAIL);
  });

  test("omitted platform conservatively defaults to darwin", () => {
    const rows = checkStackAgent({ readPlist: () => supervised, runLaunchctl: () => ({ loaded: true }), readHaltMarker: () => null });
    expect(rows[0].status).toBe(STATUS.PASS);
  });

  test("a numeric epoch-seconds haltedAt is read as seconds, not milliseconds", () => {
    const now = Date.parse("2026-08-11T22:00:00Z");
    const oneHourAgoSecs = Math.floor(now / 1000) - 3600;
    const active = checkStackAgent(deps({ readHaltMarker: () => ({ haltedAt: oneHourAgoSecs, ttlSecs: 7200, reason: "maintenance" }) }));
    expect(active.find((r) => r.name === "stack-halt")?.status).toBe(STATUS.INFO);
    expect(active.find((r) => r.name === "stack-halt")?.detail).toContain("maintenance");
    const expired = checkStackAgent(deps({ readHaltMarker: () => ({ haltedAt: oneHourAgoSecs, ttlSecs: 1800, reason: "old" }) }));
    expect(expired.some((r) => r.name === "stack-halt")).toBe(false);
  });
});
