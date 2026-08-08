import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { log as defaultLog } from "./config.mjs";
import { parseRateLimitBody } from "./github-quota.mjs";

export const DEFAULTS = { intervalSeconds: 300 };
const GH_TIMEOUT_MS = 10_000;

export function readGithubQuotaSweepConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"))?.catalyst?.orchestration?.githubQuotaSweep ?? {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      defaultLog.warn({ configPath, err: err?.message }, "github-quota-timer: config unreadable; using defaults");
    }
    return {};
  }
}

export function readGithubQuota(orchDir, { log = defaultLog } = {}) {
  const path = join(orchDir, "github-quota.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    log?.warn?.({ path, err: err?.message }, "github-quota-timer: github-quota.json corrupt — skipping");
    return null;
  }
}

function defaultRunGh() {
  return spawnSync("gh", ["api", "rate_limit"], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
  });
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    now: () => Date.now(),
  };
}

export function startGithubQuotaTimer({
  orchDir,
  intervalSeconds = DEFAULTS.intervalSeconds,
  enabled = false,
  runGh = defaultRunGh,
  clock = realClock(),
  now,
  host = hostname(),
  log = defaultLog,
  fileOps = { writeFileSync, renameSync },
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };
  const intervalMs = Math.max(1, intervalSeconds) * 1_000;
  const handle = clock.setInterval(async () => {
    try {
      const result = await runGh();
      if (!result || result.status !== 0) return;
      const nowMs = typeof now === "function" ? now() : clock.now();
      const snapshot = parseRateLimitBody(result.stdout, { host, nowMs });
      if (!snapshot) return;
      mkdirSync(orchDir, { recursive: true });
      const finalPath = join(orchDir, "github-quota.json");
      const tmpPath = join(orchDir, `github-quota.json.tmp.${process.pid}`);
      fileOps.writeFileSync(tmpPath, JSON.stringify(snapshot));
      fileOps.renameSync(tmpPath, finalPath);
    } catch (err) {
      log?.warn?.({ err: err?.message }, "github-quota-timer: tick error");
    }
  }, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}
