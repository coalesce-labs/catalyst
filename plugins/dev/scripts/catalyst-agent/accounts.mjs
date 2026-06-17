// accounts.mjs — CTL-812 Domain 1. Enumerate the Claude accounts the agent
// should sample rate-limit usage for: the locally-active account plus any
// claude-swap backups.
//
// On most hosts there is exactly ONE account — the active one read from
// ~/.claude/.credentials.json (the file current Claude Code writes everywhere),
// with the macOS Keychain tried first as a legacy fallback. When the
// operator uses claude-swap (cswap), each swapped-out account is persisted as a
// JSON file under ~/.claude-swap-backup/credentials/ with the same
// { claudeAiOauth: { accessToken, refreshToken } } shape. Those backup tokens
// can be STALE, so each is refreshed via the platform OAuth token endpoint
// before use; an account whose refresh fails is dropped from the run.
//
// SELF-CONTAINED: zero npm deps, node:* builtins only; runs under node>=18 and
// bun. The standalone agent does NOT import from execution-core.
//
// SECRETS HYGIENE (hard rule): OAuth access/refresh tokens are read into local
// variables and used without ever being logged, echoed, or placed in an error
// message. The refresh-failure warning carries the FILE name only — never the
// token. NEVER print a token.
//
// All side effects (readActiveToken, listBackups, refreshToken) are injected so
// enumerateAccounts() is fully unit-testable with no real keychain, filesystem,
// or network.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log } from "./config.mjs";

// The platform OAuth token endpoint + the public client id, per the locked
// CTL-812 spec. A swapped-out backup token is refreshed (read-only — the
// refreshed token is used in-memory for this run and NEVER written back).
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// The claude-swap backup credentials directory. Each entry is one JSON file
// carrying the same { claudeAiOauth } shape as the live credentials.
function backupCredentialsDir() {
  return resolve(homedir(), ".claude-swap-backup", "credentials");
}

// defaultReadActiveToken — resolve the locally-active OAuth access token. The
// token blob ({ claudeAiOauth: { accessToken } }) lives in one of two places:
//   • ~/.claude/.credentials.json — the FILE that current Claude Code (2.1.x)
//     writes on EVERY platform, macOS included. This is the source of truth on
//     modern installs.
//   • the macOS Keychain generic password "Claude Code-credentials" — where
//     OLDER Claude Code stored it on macOS. Some hosts still carry this entry.
// On macOS we therefore try the Keychain FIRST (legacy hosts) and fall back to
// the file; everywhere else we read the file directly. Previously macOS read
// ONLY the Keychain, so a node whose token lived solely in the file (the modern
// default) reported "no active OAuth token" and emitted no quota telemetry.
// Returns null on ANY error — never throws, never logs the token. All I/O seams
// are injectable so the keychain-hit / keychain-miss→file / file-only paths are
// unit-testable with no real keychain, fs, or platform.
export function defaultReadActiveToken({
  platform = process.platform,
  exec = execFileSync,
  readFile = readFileSync,
  home = homedir(),
} = {}) {
  const parseToken = (raw) => {
    try {
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    } catch {
      return null;
    }
  };
  const fromFile = () => {
    try {
      return parseToken(readFile(resolve(home, ".claude", ".credentials.json"), "utf8"));
    } catch {
      return null;
    }
  };
  if (platform === "darwin") {
    try {
      const raw = exec(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      );
      const token = parseToken(raw);
      if (token) return token;
    } catch {
      /* Keychain item absent (current Claude on macOS) → fall through to the file */
    }
    return fromFile();
  }
  return fromFile();
}

// defaultListBackups — enumerate the claude-swap backup credential files,
// returning [{ file, token, refreshToken }] for each parseable JSON entry. A
// missing directory (the common single-account case) or an unreadable/garbled
// file yields an empty list / skips that entry — never throws, never logs a
// token. `file` is the BASENAME only (low-cardinality, no path leakage in logs).
export function defaultListBackups(dir = backupCredentialsDir()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // dir absent → single-account host
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(resolve(dir, name), "utf8");
      const oauth = JSON.parse(raw)?.claudeAiOauth;
      const token = oauth?.accessToken ?? null;
      const refreshToken = oauth?.refreshToken ?? null;
      out.push({ file: name, token, refreshToken });
    } catch {
      // Unreadable / non-JSON backup file — skip it silently (no token to leak).
    }
  }
  return out;
}

// defaultRefreshToken — POST a refresh_token grant to the platform OAuth
// endpoint and return the fresh access token, or null on ANY failure. The
// refreshed token is used in-memory for this run only; it is NEVER written back
// to disk (read-only v1). NEVER throws, NEVER logs the token. `fetchImpl` is
// injectable for tests.
export async function defaultRefreshToken(refreshToken, { fetchImpl = fetch } = {}) {
  if (!refreshToken) return null;
  try {
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (res?.status !== 200) return null;
    const body = await res.json();
    // The fresh token may live under .access_token (OAuth) or, defensively,
    // the nested .claudeAiOauth.accessToken shape.
    const token = body?.access_token ?? body?.claudeAiOauth?.accessToken ?? null;
    return token || null;
  } catch {
    return null;
  }
}

/**
 * enumerateAccounts — resolve every account the agent should sample this run.
 * Returns an array of { source, token, file? }:
 *   - the active account first (source:'active'), when a token is available
 *   - then one entry per claude-swap backup (source:'backup', file:<basename>)
 *     whose stale token refreshed successfully
 * A backup whose refresh fails is dropped with a warning that carries the FILE
 * name only — never the token. NEVER throws.
 *
 * All seams are injected so the function is fully unit-testable with no real
 * keychain, filesystem, or network.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.readActiveToken=defaultReadActiveToken] sync; returns string|null
 * @param {Function} [opts.listBackups=defaultListBackups]         sync; returns [{file,token,refreshToken}]
 * @param {Function} [opts.refreshToken=defaultRefreshToken]       async (refreshToken) → string|null
 * @returns {Promise<Array<{source:'active'|'backup', token:string, file?:string}>>}
 */
export async function enumerateAccounts({
  readActiveToken = defaultReadActiveToken,
  listBackups = defaultListBackups,
  refreshToken = defaultRefreshToken,
} = {}) {
  const accounts = [];

  // 1. The active account (keychain / credentials file). Listed first.
  let activeToken = null;
  try {
    activeToken = readActiveToken();
  } catch {
    activeToken = null;
  }
  if (activeToken) {
    accounts.push({ source: "active", token: activeToken });
  } else {
    log.warn("accounts: no active OAuth token available");
  }

  // 2. The claude-swap backups. Each stale token is refreshed before use; a
  //    refresh failure drops the account (the run still proceeds for the rest).
  let backups = [];
  try {
    backups = listBackups() ?? [];
  } catch {
    backups = []; // unreadable backup dir → active-only
  }
  for (const backup of backups) {
    let fresh = null;
    try {
      // Pass ONLY the refresh token: defaultRefreshToken's 2nd arg is { fetchImpl }
      // (the file name is not one of its params). An earlier version passed
      // { file } here, which defaultRefreshToken silently ignored — harmless but
      // misleading (CTL-812 review). The file is used only for the warning below.
      fresh = await refreshToken(backup.refreshToken);
    } catch {
      fresh = null;
    }
    if (!fresh) {
      // Warn with the FILE name ONLY — the token is never included.
      log.warn({ file: backup.file }, "accounts: backup token refresh failed; skipping account");
      continue;
    }
    accounts.push({ source: "backup", token: fresh, file: backup.file });
  }

  return accounts;
}
