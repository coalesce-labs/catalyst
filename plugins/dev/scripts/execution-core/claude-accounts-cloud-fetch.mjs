// claude-accounts-cloud-fetch.mjs — CTL-1991. Cloud delivery of the
// claude-accounts.env secret (Claude OAuth subscription tokens).
//
// WHAT THIS DOES. Fetches the active claude-accounts.env content from the
// cloud product (CTC-732) and materializes it to ~/.config/catalyst/ so the
// existing catalyst-execution-core launcher (which sources the file at boot)
// and the live rearm hook (claude-accounts-rearm.mjs) keep working unchanged.
// All three downstream consumers that read the whole file for all N token
// slots (accounts-probe.mjs, ratelimit-accounts-probe.mjs, claude-accounts-
// usage.mjs) also keep reading the same on-disk path unchanged.
//
// WHY MATERIALIZE INSTEAD OF RESOLVING VIA SECRET-CONTRACT. resolveSecret(
// "claude-accounts.env") is presence-only (delivery: "env-file"). The token
// never flowed through resolveSecret; it flows through the launcher `source`
// and the rearm hook. Materializing to disk lets those paths continue working
// without change, and a rollback to SOPS delivery is a single flag flip.
//
// MINTING IS NOT IN SCOPE. The cloud product delivers and switches subscription
// OAuth tokens across hosts. Minting those tokens remains `claude login` on the
// machine — this module does not issue credentials, only deliver existing ones.
//
// SDK HAS NO SECRETS API. @catalyst-cloud/sdk has no secrets/slot entity in
// ENTITY_NAMES (verified on dist/node.d.ts + full dist/ grep for
// "secret|slot|activate|/me/|oauth" — returned nothing). Host-side fetch is
// a raw HTTP call, not an SDK method.
//
// ASSUMED CTC-732 ENDPOINT (must confirm before enabling "enforce" on a real
// cloud host):
//   GET {CATALYST_CLOUD_BASE_URL}/me/secrets/claude-accounts.env
//   Headers: Authorization: Bearer <cloud-token>
//   Body:    the active version's raw file content — full claude-accounts.env
//            text (all slots + _catalyst_active_token selector line) so the
//            probes that read all N slots keep working.
// The path is configurable via CATALYST_CLAUDE_ACCOUNTS_CLOUD_PATH so only
// that string changes if the real API differs.
//
// ROLLOUT. Tri-state CATALYST_CLAUDE_ACCOUNTS_CLOUD ∈ off (default) | shadow |
// enforce. Default "off" means no live change on merge. Only a confirmed cloud
// host should set "enforce". Shadow logs decisions without writing files.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-cloud-fetch.test.mjs

import { writeFileSync, chmodSync, renameSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { containsNul, isValidUtf8RoundTrip } from "../lib/secret-contract.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.catalyst-cloud.coalescelabs.ai/api/v1";
const DEFAULT_ACCOUNT = "tenant-0";
const DEFAULT_PATH = "/me/secrets/claude-accounts.env";

// ── resolveClaudeAccountsCloudMode ───────────────────────────────────────────

/**
 * Resolve CATALYST_CLAUDE_ACCOUNTS_CLOUD env-var → "off" | "shadow" | "enforce".
 * Unknown values degrade to "off" (matches resolveDepSkewMode pattern — never throws).
 */
export function resolveClaudeAccountsCloudMode(env) {
  const val = env?.CATALYST_CLAUDE_ACCOUNTS_CLOUD ?? "";
  if (val === "shadow") return "shadow";
  if (val === "enforce") return "enforce";
  return "off";
}

// ── fetchClaudeAccountsEnv ───────────────────────────────────────────────────

/**
 * fetchClaudeAccountsEnv — fetch the active claude-accounts.env content from
 * the cloud. All I/O is injected for testability; never throws.
 *
 * Returns:
 *   { ok:true, content } on success
 *   { ok:false, reason } on any failure:
 *     "no-cloud-token"  — token absent; no HTTP call made
 *     "http-<status>"   — non-2xx HTTP response
 *     "fetch-threw"     — fetchFn threw (network error, timeout, etc.)
 *     "empty"           — 200 with whitespace-only body
 *     "invalid-bytes"   — 200 but content contains NUL or fails UTF-8 round-trip
 *
 * @param {object} opts
 * @param {object} [opts.env]           env vars (default: process.env)
 * @param {function} [opts.fetchFn]     injectable fetch (default: globalThis.fetch)
 * @param {function} [opts.resolveToken] injectable token resolver → string|null
 * @param {object|null} [opts.log]      pino-style logger (null = silent)
 */
export async function fetchClaudeAccountsEnv({
  env = process.env,
  fetchFn = globalThis.fetch,
  resolveToken,
  log,
} = {}) {
  try {
    const safeEnv = env ?? {};

    // Resolve the bearer token first. Never make the HTTP call without one.
    const token = resolveToken ? resolveToken(safeEnv) : null;
    if (!token) {
      return { ok: false, reason: "no-cloud-token" };
    }

    // Build the request URL.
    const baseUrl = (safeEnv.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const path = safeEnv.CATALYST_CLAUDE_ACCOUNTS_CLOUD_PATH ?? DEFAULT_PATH;
    const url = `${baseUrl}${path}`;

    // Perform the HTTP GET.
    let response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      log?.warn?.({ err: err?.message }, "claude-accounts-cloud-fetch: fetch threw");
      return { ok: false, reason: "fetch-threw" };
    }

    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }

    const text = await response.text();

    // Empty / whitespace-only body guard.
    if (!text || !text.trim()) {
      return { ok: false, reason: "empty" };
    }

    // Byte hygiene: NUL bytes and invalid-UTF-8 sequences are rejected (same
    // guards as rearmClaudeAccountsFromFile / rearmGithubTokenFromFile).
    const buf = Buffer.from(text, "utf8");
    const decoded = buf.toString("utf8");
    if (!isValidUtf8RoundTrip(buf, decoded) || containsNul(decoded)) {
      return { ok: false, reason: "invalid-bytes" };
    }

    return { ok: true, content: text };
  } catch (err) {
    log?.warn?.({ err: err?.message }, "claude-accounts-cloud-fetch: unexpected error (continuing)");
    return { ok: false, reason: "unexpected-error" };
  }
}

// ── defaultWriteFile ──────────────────────────────────────────────────────────

// Symlink-safe 0o600 tmp+rename writer — mirrors cluster-sync.mjs :267-282
// (the `defaultWriteFile` function there). Writes to a sibling tmp file then
// renameSync into place. rename replaces a symlink at `path` rather than
// following it to its target — unlike writeFileSync (O_TRUNC follows symlinks).
function defaultWriteFile(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    chmodSync(tmp, 0o600); // defensively re-assert (umask can mask the create mode)
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ── materializeClaudeAccountsEnv ─────────────────────────────────────────────

/**
 * materializeClaudeAccountsEnv — write `content` to `path` at 0o600 via
 * tmp+rename. No-churn: if the on-disk content already equals `content`,
 * returns { written:false, reason:"unchanged" } without writing.
 *
 * Injectable readFile / writeFile seams for tests; never throws.
 *
 * Returns:
 *   { written:true }                   — file was written (content changed)
 *   { written:false, reason:"unchanged" } — content identical, no write
 *   { written:false, reason:"error" }  — write threw; no litter left
 */
export async function materializeClaudeAccountsEnv({
  content,
  path,
  readFile = (p) => readFileSync(p, "utf8"),
  writeFile = defaultWriteFile,
  log,
} = {}) {
  try {
    // No-churn idempotency: compare by exact bytes. Prevents mtime churn and
    // stops the rearm hook (which watches for env changes) from firing every tick.
    try {
      const existing = readFile(path);
      const existingStr = Buffer.isBuffer(existing) ? existing.toString("utf8") : String(existing);
      if (existingStr === content) {
        return { written: false, reason: "unchanged" };
      }
    } catch {
      // ENOENT or unreadable — proceed with the write
    }

    try {
      writeFile(path, content);
      return { written: true };
    } catch (err) {
      log?.warn?.({ err: err?.message }, "claude-accounts-cloud-fetch: materialize write failed");
      return { written: false, reason: "error" };
    }
  } catch (err) {
    log?.warn?.({ err: err?.message }, "claude-accounts-cloud-fetch: materialize unexpected error");
    return { written: false, reason: "error" };
  }
}

// ── syncClaudeAccountsFromCloud ───────────────────────────────────────────────

/**
 * syncClaudeAccountsFromCloud — orchestration gate: deployment-mode guard +
 * tri-state (off/shadow/enforce) dispatch. Composes fetchClaudeAccountsEnv and
 * materializeClaudeAccountsEnv. Never throws.
 *
 * Returns one of:
 *   { skipped:true, reason:"not-cloud" }  — deployment mode is not genuinely cloud
 *   { skipped:true, reason:"disabled" }   — mode is "off"
 *   { shadow:true, wouldWrite:<bool> }     — shadow mode (fetch but no write)
 *   { written:<bool>, [reason] }           — enforce mode, materialize result
 *   { ok:false, reason }                   — enforce mode, fetch failed (disk untouched)
 *
 * The "genuine cloud" predicate matches resolveSecret's (CTL-1617):
 *   deploymentMode.mode === "cloud" && !deploymentMode.inferred && deploymentMode.recognized !== false
 *
 * @param {object} opts
 * @param {object} [opts.env]              env vars (default: process.env)
 * @param {object} [opts.deploymentMode]   result of resolveDeploymentMode()
 * @param {string} [opts.mode]             "off" | "shadow" | "enforce" (default: resolves from env)
 * @param {function} [opts.fetchFn]        injectable fetch
 * @param {function} [opts.resolveToken]   injectable token resolver → string|null
 * @param {string} [opts.path]             target file path (default: ~/.config/catalyst/claude-accounts.env)
 * @param {object|null} [opts.log]         pino-style logger
 */
export async function syncClaudeAccountsFromCloud({
  env = process.env,
  deploymentMode,
  mode,
  fetchFn = globalThis.fetch,
  resolveToken,
  path,
  log,
} = {}) {
  try {
    const safeEnv = env ?? {};

    // Resolve the target path the same way the launcher (catalyst-execution-core)
    // and the rearm hook resolve it: env override or default config location.
    const targetPath = path ??
      safeEnv.CLAUDE_ACCOUNTS_ENV ??
      join(homedir(), ".config", "catalyst", "claude-accounts.env");

    // Deployment-mode gate: only activate on a genuinely declared cloud node.
    // Never on inferred cloud (might be a laptop that just hasn't declared a mode),
    // and never on an unrecognized/invalid value degraded to cloud.
    const isGenuineCloud =
      deploymentMode?.mode === "cloud" &&
      deploymentMode?.inferred === false &&
      deploymentMode?.recognized !== false;

    if (!isGenuineCloud) {
      return { skipped: true, reason: "not-cloud" };
    }

    // Tri-state mode gate.
    const resolvedMode = mode ?? resolveClaudeAccountsCloudMode(safeEnv);
    if (resolvedMode === "off" || !resolvedMode) {
      return { skipped: true, reason: "disabled" };
    }

    // Fetch the content (shared by both shadow and enforce).
    const fetchResult = await fetchClaudeAccountsEnv({ env: safeEnv, fetchFn, resolveToken, log });

    if (resolvedMode === "shadow") {
      if (!fetchResult.ok) {
        return { shadow: true, wouldWrite: false, fetchReason: fetchResult.reason };
      }
      // Compute would-write by checking if on-disk content differs, without writing.
      let wouldWrite = true;
      try {
        const existing = readFileSync(targetPath, "utf8");
        wouldWrite = existing !== fetchResult.content;
      } catch {
        // File absent or unreadable — would write
      }
      log?.info?.({ wouldWrite, path: targetPath }, "claude-accounts-cloud-fetch: shadow — would materialize");
      return { shadow: true, wouldWrite };
    }

    // enforce mode: materialize only on a successful fetch. A cloud outage must
    // never blank the existing on-disk token — so a fetch failure returns the
    // error result and leaves the file untouched.
    if (!fetchResult.ok) {
      log?.warn?.({ reason: fetchResult.reason }, "claude-accounts-cloud-fetch: enforce — fetch failed, disk untouched");
      return { ok: false, reason: fetchResult.reason };
    }

    return await materializeClaudeAccountsEnv({
      content: fetchResult.content,
      path: targetPath,
      log,
    });
  } catch (err) {
    log?.warn?.({ err: err?.message }, "claude-accounts-cloud-fetch: sync unexpected error");
    return { ok: false, reason: "unexpected-error" };
  }
}
