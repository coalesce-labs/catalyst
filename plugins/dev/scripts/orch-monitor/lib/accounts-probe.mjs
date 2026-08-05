// accounts-probe.mjs — CTL-1653. Node-scoped Claude-account posture for the
// orch-monitor read surfaces (/api/accounts, the SSE stream, both dashboards).
//
// Three exports:
//   defaultAccountsProbeExec — the production child-process runner. Spawns the
//     CTL-1650 probe (claude-accounts-usage.mjs --json) in a SUBSHELL that sources
//     claude-accounts.env so CLAUDE_CODE_OAUTH_TOKEN is set for active-account
//     detection and dies with the child — the token NEVER enters this long-lived
//     monitor process's env (secrets hygiene, claude-accounts-usage.mjs:23-26).
//   deriveAccountsSummary — PURE. Whitelist-maps the token-free probe record into
//     the node-scoped summary the API/dashboards consume (active account, node
//     status, siblingWithHeadroom). Never spreads the raw record, so a leaked
//     `token` field can't ride along.
//   createAccountsProbe — an async TTL cache around an injected exec (the sync
//     createMemoizedRead can't wrap an async child-process probe).
//
// Exec and clock are injectable, so the whole module is unit-testable with no
// subprocess and no network.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const execFileP = promisify(execFile);
const PROBE = resolve(import.meta.dir, "..", "..", "claude-accounts-usage.mjs");
const ENV_FILE =
  process.env.CLAUDE_ACCOUNTS_ENV ?? resolve(homedir(), ".config/catalyst/claude-accounts.env");
// bun else node — mirrors catalyst-stack's _ca_node_runtime choice. The probe is
// pure node:* + fetch, so either runtime runs it.
const RUNTIME = existsSync(resolve(homedir(), ".bun/bin/bun")) ? "bun" : "node";

/**
 * defaultAccountsProbeExec — run the CTL-1650 probe in a subshell that sources the
 * accounts env so CLAUDE_CODE_OAUTH_TOKEN is visible for active-account detection
 * and never enters this (long-lived monitor) process's env. Returns the token-free
 * JSON record ({generatedAt, accounts:[…]}). When no env file exists, returns an
 * empty record so the surfaces render "unavailable"/quiet rather than erroring.
 */
export async function defaultAccountsProbeExec({ envFile = ENV_FILE, timeoutMs = 30000 } = {}) {
  if (!existsSync(envFile)) return { generatedAt: new Date().toISOString(), accounts: [] };
  // `set -a` exports every sourced var to the exec'd child only; the token dies
  // with this bash -c subshell and never reaches the monitor's own env.
  const script = `set -a; . "$CATALYST_ACCOUNTS_ENV"; set +a; exec "$RT" "$PROBE" --json`;
  const { stdout } = await execFileP("bash", ["-c", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CATALYST_ACCOUNTS_ENV: envFile, RT: RUNTIME, PROBE },
  });
  return JSON.parse(stdout);
}

// ── pure status mapping (the single canonical map Phases 3-6 import) ─────────

// The probe's per-window/overall status vocabulary → the surface tone vocabulary.
const WINDOW_STATUS_MAP = {
  allowed: "ok",
  allowed_warning: "degraded",
  rejected: "rejected",
};

function mapWindowStatus(status) {
  return WINDOW_STATUS_MAP[status] ?? "unknown";
}

// The active account's binding window's raw status, via representativeClaim.
function bindingWindowStatus(active) {
  if (!active) return null;
  if (active.representativeClaim === "five_hour") return active.fiveHour?.status ?? null;
  if (active.representativeClaim === "seven_day") return active.sevenDay?.status ?? null;
  // No representative claim — fall back to the overall status.
  return active.overallStatus ?? null;
}

// Whitelist-map ONE raw account to a token-free view. Explicit field pick — never
// spread the raw record, so a leaked `token` (or any other unexpected field) can't
// ride along into the summary.
function pickAccount(a) {
  return {
    label: a?.label ?? null,
    isActive: Boolean(a?.isActive),
    email: a?.email ?? null,
    overallStatus: a?.overallStatus ?? null,
    representativeClaim: a?.representativeClaim ?? null,
    fiveHour: a?.fiveHour ?? null,
    sevenDay: a?.sevenDay ?? null,
    error: a?.error ?? null,
  };
}

/**
 * deriveAccountsSummary — PURE. Map the token-free probe record into the
 * node-scoped summary. Node `status`:
 *   - no active account            → "unknown"
 *   - active.error (transport)     → "error" (sensor broken, distinct from rejected)
 *   - else the active binding window's status mapped ok|degraded|rejected|unknown
 *
 * @param {object} raw   the probe's {generatedAt, accounts:[…]} record
 * @param {object} opts  { node }
 * @returns {{node, generatedAt, status, active, accounts, siblingWithHeadroom}}
 */
export function deriveAccountsSummary(raw, { node } = {}) {
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts.map(pickAccount) : [];
  const active = accounts.find((a) => a.isActive) ?? null;

  let status;
  if (!active) {
    status = "unknown";
  } else if (active.error) {
    status = "error";
  } else {
    status = mapWindowStatus(bindingWindowStatus(active));
  }

  const activeView = active
    ? {
        ...active,
        bindingWindow: active.representativeClaim,
        bindingStatus: bindingWindowStatus(active),
      }
    : null;

  const sibling = accounts.find((a) => !a.isActive && a.overallStatus === "allowed");
  const siblingWithHeadroom = sibling ? { label: sibling.label, email: sibling.email } : null;

  return {
    node: node ?? null,
    generatedAt: raw?.generatedAt ?? null,
    status,
    active: activeView,
    accounts,
    siblingWithHeadroom,
  };
}

/**
 * createAccountsProbe — an async TTL cache around an injected exec. `get({refresh})`
 * serves the cached summary while fresh; otherwise probes, derives, caches, returns.
 * A throwing exec yields an error posture that is NOT cached (so a transient failure
 * retries next call). `latest()` returns the last posture without probing.
 *
 * @param {object} o
 * @param {Function} o.exec         async () => raw probe record
 * @param {number}   [o.ttlMs]      cache TTL (default 5 min)
 * @param {Function} [o.now]        injectable clock (default Date.now)
 * @param {string}   o.node         this node's identity
 * @returns {{get, latest}}
 */
export function createAccountsProbe({ exec, ttlMs = 5 * 60 * 1000, now = () => Date.now(), node }) {
  let cache = null; // { summary, probedAt }

  async function get({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.probedAt < ttlMs) {
      return { ...cache.summary, probedAt: cache.probedAt, cached: true };
    }
    let raw;
    try {
      raw = await exec();
    } catch (err) {
      // Build an error posture over a synthetic error record; return WITHOUT
      // caching so the next call retries rather than serving a stale error.
      const errRecord = {
        generatedAt: new Date(now()).toISOString(),
        accounts: [
          {
            label: null,
            isActive: true,
            email: null,
            overallStatus: null,
            representativeClaim: null,
            fiveHour: null,
            sevenDay: null,
            error: err?.message ?? String(err),
          },
        ],
      };
      const summary = deriveAccountsSummary(errRecord, { node });
      return { ...summary, probedAt: now(), cached: false };
    }
    const summary = deriveAccountsSummary(raw, { node });
    cache = { summary, probedAt: now() };
    return { ...summary, probedAt: cache.probedAt, cached: false };
  }

  function latest() {
    return cache?.summary ?? null;
  }

  return { get, latest };
}
