// claude-accounts-rearm.mjs — CTL-1984. In-process rearm hook for the
// claude-accounts.env row (re-armable/timer). Mirrors rearmGithubTokenFromFile
// structurally (injectable readFile, byte-hygiene guards, never throws).
//
// WHAT THIS DOES. The daemon's launcher (catalyst-execution-core) sources
// claude-accounts.env at process start, exporting CLAUDE_CODE_OAUTH_TOKEN from
// the active-slot selector. When the fleet-ops tooling rotates the active slot in
// the cloud and cluster-sync materializes the updated file on disk, this hook reads
// the new active-slot token and mutates process.env.CLAUDE_CODE_OAUTH_TOKEN in-place,
// so the next SDK dispatch picks up the new account without a daemon restart.
//
// PATH RESOLUTION. The hook resolves the file the same way the launcher does:
//   env.CLAUDE_ACCOUNTS_ENV || join(homedir(), ".config/catalyst/claude-accounts.env")
// It does NOT use secretFileCandidates("claude-accounts.env"), whose override env-var
// name is CATALYST_CLAUDE-ACCOUNTS_ENV_FILE and whose chain differs from the launcher.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-rearm.test.mjs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log as defaultLog } from "./config.mjs";
import { containsNul, isValidUtf8RoundTrip } from "../lib/secret-contract.mjs";

// PLACEHOLDER sentinel that the generator writes when no real token is present.
const PLACEHOLDER = "PASTE_TOKEN_HERE";

// parseActiveOauthToken — pure, unit-testable. Reads the active-slot token from the
// text content of a claude-accounts.env file. Returns the resolved token string or null.
//
// The file format (written by catalyst-stack/setup-claude-accounts):
//   CLAUDE_TOKEN_acct1='sk-ant-oat...'  # email@example.com
//   CLAUDE_TOKEN_acct2='sk-ant-oat...'  # other@example.com
//   _catalyst_active_token="$CLAUDE_TOKEN_acct2"
//   case ... export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"
//
// Three resolution paths, in priority order:
// 1. Selector line  (`_catalyst_active_token="$CLAUDE_TOKEN_<label>"`) — canonical.
// 2. Direct literal (`export CLAUDE_CODE_OAUTH_TOKEN='<value>'`) — hand-authored fallback.
// 3. Single CLAUDE_TOKEN_* assignment with no selector — implicit single-account file.
export function parseActiveOauthToken(text) {
  const lines = text.split("\n");

  // Collect every CLAUDE_TOKEN_<label>=<value> assignment.
  const TOKEN_RE = /^(?:export\s+)?CLAUDE_TOKEN_([A-Za-z0-9_]+)=(.*)/;
  const tokenMap = new Map();
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(TOKEN_RE);
    if (!m) continue;
    const value = _parseValue(m[2]);
    // Never install an unexpanded shell reference as a credential. A quoted
    // form like CLAUDE_TOKEN_acct1="$SOMEVAR" survives _parseValue as the literal
    // string "$SOMEVAR" (quotes stripped), which the selector would then hand
    // back as the OAuth token (CTL-1984 review). A static parser must not follow
    // shell expansion — skip any value that is still a $-reference.
    if (!value || value === PLACEHOLDER || value.startsWith("$")) continue;
    tokenMap.set(m[1], value);
  }

  // Path 1 — selector line: _catalyst_active_token="$CLAUDE_TOKEN_<label>"
  const SELECTOR_RE = /_catalyst_active_token=["']?\$\{?CLAUDE_TOKEN_([A-Za-z0-9_]+)\}?["']?/;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(SELECTOR_RE);
    if (!m) continue;
    const tok = tokenMap.get(m[1]);
    if (tok) return tok;
  }

  // Path 2 — direct literal: export CLAUDE_CODE_OAUTH_TOKEN='<literal>'
  const DIRECT_RE = /^(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN=(.*)/;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(DIRECT_RE);
    if (!m) continue;
    const value = _parseValue(m[1]);
    // Only honor a literal value — never an unexpanded shell reference. The raw
    // `rhs.startsWith("$")` check caught the UNQUOTED `=$TOKEN` form but not the
    // canonical launcher line `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    // whose quotes _parseValue strips to the literal "$_catalyst_active_token" — a
    // variable NAME installed as the credential when Path 1 misses (unprovisioned
    // active slot). Guard on the PARSED value so both forms are rejected (CTL-1984 review).
    if (!value || value === PLACEHOLDER || value.startsWith("$")) continue;
    return value;
  }

  // Path 3 — single-account implicit: one CLAUDE_TOKEN_* entry with no selector
  if (tokenMap.size === 1) {
    const [tok] = tokenMap.values();
    return tok;
  }

  return null;
}

// _parseValue — parse the RHS of a shell assignment (quoted or unquoted).
// Strips the enclosing quote pair and ignores inline comments (same logic
// as claude-accounts-usage.mjs's parseAssignment, inlined to avoid importing
// a CLI-entrypoint module).
function _parseValue(rhs) {
  const s = (rhs ?? "").trimStart();
  let token;
  if (s[0] === "'" || s[0] === '"') {
    const q = s[0];
    const end = s.indexOf(q, 1);
    token = end === -1 ? s.slice(1) : s.slice(1, end);
  } else {
    const m = s.match(/^(\S+)/);
    token = m ? m[1] : s;
  }
  return token.trim();
}

// rearmClaudeAccountsFromFile — the registered rearm hook for the
// claude-accounts.env row. Returns { rearmed, reason }; never throws.
//
// Injected readFile (for testing): must accept a path and return a Buffer or string.
export function rearmClaudeAccountsFromFile({
  env = process.env,
  readFile = (p) => readFileSync(p),
  log = defaultLog,
} = {}) {
  try {
    const candidates = [
      env?.CLAUDE_ACCOUNTS_ENV,
      join(homedir(), ".config", "catalyst", "claude-accounts.env"),
    ].filter(Boolean);

    let tok = null;
    let anyFound = false;

    for (const file of candidates) {
      let raw;
      try {
        raw = readFile(file);
      } catch {
        continue; // file not present on this host — try next
      }
      anyFound = true;

      // Byte hygiene — same guards as rearmGithubTokenFromFile
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
      const decoded = buf.toString("utf8");
      if (!isValidUtf8RoundTrip(buf, decoded)) continue;
      if (containsNul(decoded)) continue;

      const resolved = parseActiveOauthToken(decoded);
      if (resolved && resolved !== PLACEHOLDER && resolved.trim()) {
        tok = resolved;
        break;
      }
    }

    if (!anyFound) return { rearmed: false, reason: "absent" };
    if (!tok || !tok.trim()) return { rearmed: false, reason: "empty" };

    if (tok === env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { rearmed: false, reason: "unchanged" };
    }

    env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    env.CATALYST_CLAUDE_ACCOUNTS_SOURCE = "shared-file-resynced";
    log?.warn?.(
      {},
      "claude-accounts-rearm: active-slot token changed on disk " +
        "(cluster-sync materialized a rotation or account-slot switch) — " +
        "re-armed in-process, no restart needed",
    );
    return { rearmed: true, reason: "rotated" };
  } catch (err) {
    log?.warn?.({ err: err?.message }, "claude-accounts-rearm: re-arm failed (continuing)");
    return { rearmed: false, reason: "error" };
  }
}
