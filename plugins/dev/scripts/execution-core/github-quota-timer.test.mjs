import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  readGithubQuota,
  readGithubQuotaSweepConfig,
  startGithubQuotaTimer,
} from "./github-quota-timer.mjs";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const VALID = JSON.stringify({ resources: { core: { limit: 5000, used: 100, remaining: 4900, reset: 1786194000 } } });

function fakeClock() {
  let callback;
  let cleared = false;
  return {
    setInterval(fn) { callback = fn; return { unref() {} }; },
    clearInterval() { cleared = true; },
    now: () => NOW,
    async tick() { if (!cleared) await callback?.(); },
  };
}

function tempDir() { return mkdtempSync(join(tmpdir(), "github-quota-")); }

describe("github quota timer", () => {
  test("a successful tick atomically publishes a snapshot that round-trips", async () => {
    const orchDir = tempDir();
    const clock = fakeClock();
    const operations = [];
    try {
      const timer = startGithubQuotaTimer({ enabled: true, orchDir, clock, host: "mini-1", runGh: () => ({ status: 0, stdout: VALID }),
        fileOps: {
          writeFileSync(path, value) { operations.push(["write", path]); writeFileSync(path, value); },
          renameSync(from, to) { operations.push(["rename", from, to]); expect(readFileSync(from, "utf8")).toContain('"core"'); expect(() => readFileSync(to)).toThrow(); copyFileSync(from, to); unlinkSync(from); },
        },
      });
      await clock.tick();
      expect(operations[0][0]).toBe("write");
      expect(operations[0][1]).toContain("github-quota.json.tmp.");
      expect(operations[1][0]).toBe("rename");
      expect(readGithubQuota(orchDir)).toMatchObject({ host: "mini-1", core: { remaining: 4900 } });
      timer.stop();
    } finally { rmSync(orchDir, { recursive: true, force: true }); }
  });

  test("non-zero, throwing, and garbage samples preserve the previous snapshot", async () => {
    for (const runGh of [() => ({ status: 1, stdout: "", stderr: "no" }), () => { throw new Error("boom"); }, () => ({ status: 0, stdout: "garbage" })]) {
      const orchDir = tempDir();
      writeFileSync(join(orchDir, "github-quota.json"), '{"sentinel":true}');
      const clock = fakeClock();
      startGithubQuotaTimer({ enabled: true, orchDir, clock, runGh, log: { warn() {} } });
      await expect(clock.tick()).resolves.toBeUndefined();
      expect(readFileSync(join(orchDir, "github-quota.json"), "utf8")).toBe('{"sentinel":true}');
      rmSync(orchDir, { recursive: true, force: true });
    }
  });

  test("missing and corrupt reads return null; corrupt warns once", () => {
    const orchDir = tempDir();
    const warnings = [];
    expect(readGithubQuota(orchDir, { log: { warn: (...args) => warnings.push(args) } })).toBeNull();
    writeFileSync(join(orchDir, "github-quota.json"), "not-json");
    expect(readGithubQuota(orchDir, { log: { warn: (...args) => warnings.push(args) } })).toBeNull();
    expect(warnings).toHaveLength(1);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("stop clears the interval and disabled mode never samples", async () => {
    let calls = 0;
    const clock = fakeClock();
    const timer = startGithubQuotaTimer({ enabled: true, orchDir: "/unused", clock, runGh: () => { calls++; return { status: 0, stdout: VALID }; } });
    timer.stop();
    await clock.tick();
    expect(calls).toBe(0);
    const disabled = startGithubQuotaTimer({ enabled: false, orchDir: "/unused", clock, runGh: () => { calls++; } });
    disabled.stop();
    expect(calls).toBe(0);
  });

  test("reads config and exports a five-minute default", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ catalyst: { orchestration: { githubQuotaSweep: { enabled: true, intervalSeconds: 12 } } } }));
    expect(readGithubQuotaSweepConfig(path)).toEqual({ enabled: true, intervalSeconds: 12 });
    expect(readGithubQuotaSweepConfig(join(dir, "missing"))).toEqual({});
    expect(DEFAULTS.intervalSeconds).toBe(300);
    rmSync(dir, { recursive: true, force: true });
  });
});
