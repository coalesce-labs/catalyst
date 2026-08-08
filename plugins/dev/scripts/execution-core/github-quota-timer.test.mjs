import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  readGithubQuota,
  readGithubQuotaSweepConfig,
  sampleGithubQuotaOnce,
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

  // Codex P2 (CAT-40): setInterval coerces NaN to 1ms. With the timer enabled by
  // default, a mistyped intervalSeconds turned the quota SAMPLER into a `gh api
  // rate_limit` spawn storm — the exact budget exhaustion it exists to detect.
  // The daemon's `?? DEFAULTS` cannot catch it: a wrong TYPE is not null.
  test("a non-numeric interval falls back to the default cadence instead of NaN (1ms)", () => {
    const warnings = [];
    const log = { warn: (fields, msg) => warnings.push({ fields, msg }) };
    for (const bad of ["five minutes", {}, [], NaN, Infinity, 0, -30, null, undefined]) {
      const seen = [];
      const clock = { setInterval: (_fn, ms) => { seen.push(ms); return { unref() {} }; }, clearInterval() {}, now: () => NOW };
      startGithubQuotaTimer({ enabled: true, orchDir: "/unused", intervalSeconds: bad, clock, log }).stop();
      expect(seen).toEqual([DEFAULTS.intervalSeconds * 1_000]);
    }
    // Every rejection is loud — a silently-defaulted knob is how this class hides.
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a valid interval is passed through in milliseconds", () => {
    const seen = [];
    const clock = { setInterval: (_fn, ms) => { seen.push(ms); return { unref() {} }; }, clearInterval() {}, now: () => NOW };
    startGithubQuotaTimer({ enabled: true, orchDir: "/unused", intervalSeconds: 45, clock }).stop();
    startGithubQuotaTimer({ enabled: true, orchDir: "/unused", intervalSeconds: "90", clock }).stop();
    expect(seen).toEqual([45_000, 90_000]);
  });

  // Codex P1 (CAT-40, round 2): the daemon's first board-health pass runs
  // synchronously at boot, BEFORE this timer's first interval fires. Arming only
  // a future interval left that pass with no snapshot at all — under
  // CATALYST_BH_GH_QUOTA=enforce it advanced the board-health throttle while
  // quota read `unknown`, a blind window that could span two scans (~10 min).
  test("primeImmediately publishes a snapshot before startGithubQuotaTimer returns", () => {
    const orchDir = tempDir();
    try {
      const clock = fakeClock();
      // No tick(): the snapshot must exist purely from the call below.
      const timer = startGithubQuotaTimer({
        enabled: true, orchDir, clock, host: "mini-1",
        intervalSeconds: 300, primeImmediately: true,
        runGh: () => ({ status: 0, stdout: VALID }),
      });
      expect(timer.primed).toBe(true);
      expect(readGithubQuota(orchDir)).toMatchObject({ host: "mini-1", core: { remaining: 4900 } });
      timer.stop();
    } finally { rmSync(orchDir, { recursive: true, force: true }); }
  });

  test("without primeImmediately nothing is published until the first interval fires", async () => {
    const orchDir = tempDir();
    try {
      const clock = fakeClock();
      const timer = startGithubQuotaTimer({ enabled: true, orchDir, clock, runGh: () => ({ status: 0, stdout: VALID }) });
      expect(timer.primed).toBe(false);
      expect(readGithubQuota(orchDir)).toBeNull();
      await clock.tick();
      expect(readGithubQuota(orchDir)).toMatchObject({ core: { remaining: 4900 } });
      timer.stop();
    } finally { rmSync(orchDir, { recursive: true, force: true }); }
  });

  test("a failing prime is non-fatal: the timer still arms and reports primed=false", () => {
    const orchDir = tempDir();
    try {
      const clock = fakeClock();
      const timer = startGithubQuotaTimer({
        enabled: true, orchDir, clock, primeImmediately: true,
        runGh: () => { throw new Error("gh unavailable at boot"); },
        log: { warn() {} },
      });
      expect(timer.primed).toBe(false);
      expect(readGithubQuota(orchDir)).toBeNull();
      timer.stop();
    } finally { rmSync(orchDir, { recursive: true, force: true }); }
  });

  test("sampleGithubQuotaOnce is synchronous — the write lands before the next statement", () => {
    const orchDir = tempDir();
    try {
      // If this were async, `await`-free reads would see null even on success,
      // and the daemon's synchronous startDaemon could not order the prime
      // ahead of the scheduler's first board-health pass.
      expect(sampleGithubQuotaOnce({ orchDir, runGh: () => ({ status: 0, stdout: VALID }), host: "h" })).toBe(true);
      expect(readGithubQuota(orchDir)).toMatchObject({ core: { remaining: 4900 } });
      expect(sampleGithubQuotaOnce({ orchDir: null })).toBe(false);
    } finally { rmSync(orchDir, { recursive: true, force: true }); }
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
