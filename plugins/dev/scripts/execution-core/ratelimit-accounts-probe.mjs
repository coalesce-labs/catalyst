// ratelimit-accounts-probe.mjs — CTL-2056. Durable setup-token probe for the
// ratelimit-poller. Spawns claude-accounts-usage.mjs --json in a bash -c
// subshell that sources ~/.config/catalyst/claude-accounts.env (so
// CLAUDE_CODE_OAUTH_TOKEN is set for active-account detection) and dies with
// the child — the token never enters this long-lived daemon's env.
//
// Mirrors the CTL-1653 pattern (orch-monitor/lib/accounts-probe.mjs:185) but
// kept inside execution-core to avoid a cross-package import.
//
// Two exports:
//   defaultProbeAccounts({ execFn }) — spawn the probe; never throws.
//   pickActiveAccount(probe) — pure; return active or highest-5h account.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./config.mjs";

const execFileP = promisify(execFile);

// Absolute paths — required for restricted-PATH daemon safety.
const PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "claude-accounts-usage.mjs",
);

const ENV_FILE =
  process.env.CLAUDE_ACCOUNTS_ENV ?? resolve(homedir(), ".config/catalyst/claude-accounts.env");

function resolveOnPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = resolve(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveRuntime({ homeDir = homedir() } = {}) {
  const bunHome = resolve(homeDir, ".bun/bin/bun");
  if (existsSync(bunHome)) return bunHome;
  const onPath = resolveOnPath("bun");
  if (onPath) return onPath;
  const nodeOnPath = resolveOnPath("node");
  if (nodeOnPath) return nodeOnPath;
  return "node";
}

const RUNTIME = resolveRuntime();

/**
 * defaultProbeAccounts — spawn claude-accounts-usage.mjs --json and return
 * its parsed JSON. Returns { accounts: [] } on any failure (never throws).
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFn] injectable for tests; same call signature as
 *   promisify(execFile): (cmd, args, options) => Promise<{stdout}>
 * @param {string} [opts.envFile]
 * @param {string} [opts.probePath]
 * @param {string} [opts.runtime]
 * @param {number} [opts.timeoutMs]
 */
export async function defaultProbeAccounts({
  execFn = null,
  envFile = ENV_FILE,
  probePath = PROBE,
  runtime = RUNTIME,
  timeoutMs = 30000,
} = {}) {
  const exec = execFn ?? execFileP;
  // `set -a` exports every sourced var to the child only; token dies with this
  // subshell and never reaches the daemon's own env.
  const script = `set -a; . "$CATALYST_ACCOUNTS_ENV"; set +a; exec "$RT" "$PROBE" --json`;
  const childEnv = {
    ...process.env,
    CATALYST_ACCOUNTS_ENV: envFile,
    RT: runtime,
    PROBE: probePath,
  };
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const { stdout } = await exec("bash", ["-c", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: childEnv,
    });
    const parsed = JSON.parse(stdout);
    if (!parsed || !Array.isArray(parsed.accounts)) return { accounts: [] };
    return parsed;
  } catch (err) {
    log.warn({ err: err?.message }, "ratelimit-accounts-probe: probe failed; returning empty");
    return { accounts: [] };
  }
}

/**
 * pickActiveAccount — pure function. Returns the isActive account, else the
 * account with the highest fiveHour.pct, else null.
 *
 * @param {{ accounts: Array }} probe
 * @returns {object|null}
 */
export function pickActiveAccount(probe) {
  const accounts = probe?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const active = accounts.find((a) => a.isActive === true);
  if (active) return active;
  let best = null;
  let bestPct = -Infinity;
  for (const a of accounts) {
    const pct = typeof a?.fiveHour?.pct === "number" ? a.fiveHour.pct : -Infinity;
    if (pct > bestPct) {
      bestPct = pct;
      best = a;
    }
  }
  return best;
}
