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

import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { log as defaultLog, getEventLogPath } from "./config.mjs";
import { containsNul, isValidUtf8RoundTrip } from "../lib/secret-contract.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// PLACEHOLDER sentinel that the generator writes when no real token is present.
const PLACEHOLDER = "PASTE_TOKEN_HERE";

// The event this hook emits on a genuine rotation (CTL-2147 Phase 1). Exported so
// producer-parity tests import it rather than re-typing the literal.
export const ACCOUNT_REARM_APPLIED_EVENT = "account.rearm.applied";

// parseActiveOauthTokenDetailed — pure, unit-testable. Reads the active-slot token
// (and, since CTL-2147, the selector's handle) from the text content of a
// claude-accounts.env file. Returns { token, handle }; either may be null.
//
// The file format (written by catalyst-stack/setup-claude-accounts):
//   CLAUDE_TOKEN_acct1='sk-ant-oat...'  # email@example.com
//   CLAUDE_TOKEN_acct2='sk-ant-oat...'  # other@example.com
//   _catalyst_active_token="$CLAUDE_TOKEN_acct2"
//   case ... export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"
//
// Three resolution paths, in priority order:
// 1. Selector line  (`_catalyst_active_token="$CLAUDE_TOKEN_<label>"`) — canonical.
//    The handle is the <label>.
// 2. Direct literal (`export CLAUDE_CODE_OAUTH_TOKEN='<value>'`) — hand-authored
//    fallback. No selector to name, so handle is null.
// 3. Single CLAUDE_TOKEN_* assignment with no selector — implicit single-account
//    file. The handle is that single label.
export function parseActiveOauthTokenDetailed(text) {
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
    if (tok) return { token: tok, handle: m[1] };
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
    return { token: value, handle: null };
  }

  // Path 3 — single-account implicit: one CLAUDE_TOKEN_* entry with no selector
  if (tokenMap.size === 1) {
    const [[label, tok]] = tokenMap.entries();
    return { token: tok, handle: label };
  }

  return { token: null, handle: null };
}

// parseActiveOauthToken — back-compat wrapper. Existing callers only ever wanted
// the token string; keep the exact contract so none of them change.
export function parseActiveOauthToken(text) {
  return parseActiveOauthTokenDetailed(text).token;
}

// rearmEventEnvelope — pure v2 OTel envelope builder for a genuine rearm (CTL-2147
// Phase 1), modelled on cloud-sync-deps.mjs's depSkewEventEnvelope. Never carries a
// token or email — only the account HANDLE (a label like "acct2") and the node name.
export function rearmEventEnvelope({
  handle = null,
  host = null,
  ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  id = null,
  traceId = null,
  spanId = null,
  resource = null,
} = {}) {
  return {
    ts,
    id,
    observedTs: ts,
    // INFO, not WARN: a successful account rotation is normal operation.
    severityText: "INFO",
    severityNumber: 9,
    traceId,
    spanId,
    resource,
    attributes: {
      "event.name": ACCOUNT_REARM_APPLIED_EVENT,
      "event.entity": "account",
      "event.action": "rearm-applied",
      "account.handle": handle,
      "node.name": host,
    },
    body: {
      message: `claude-accounts: re-armed in-process${handle ? ` to ${handle}` : ""} — no restart needed`,
      payload: { handle },
    },
  };
}

// defaultEmitRearmEvent — the real fs-append seam. Fail-open: a failed append must
// never surface as a rearm failure (the rearm already happened; the event is the
// receipt, never the act). Same shape as cloud-sync.mjs's emit* helpers.
function defaultEmitRearmEvent(envelope) {
  try {
    const logPath = getEventLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(envelope)}\n`);
    return true;
  } catch {
    return false;
  }
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
// claude-accounts.env row. Returns { rearmed, reason, handle }; never throws.
// `handle` is the rotated-to account's label on a "rotated" result, null on every
// other path.
//
// Injected readFile (for testing): must accept a path and return a Buffer or string.
// Injected emit (CTL-2147, default defaultEmitRearmEvent): appends the
// account.rearm.applied event on a genuine rotation; fires AFTER the env mutation,
// inside its own try/catch, so a throwing emit can never prevent or undo the rearm.
export function rearmClaudeAccountsFromFile({
  env = process.env,
  readFile = (p) => readFileSync(p),
  log = defaultLog,
  emit = defaultEmitRearmEvent,
  host = hostname(),
} = {}) {
  try {
    const candidates = [
      env?.CLAUDE_ACCOUNTS_ENV,
      join(homedir(), ".config", "catalyst", "claude-accounts.env"),
    ].filter(Boolean);

    let tok = null;
    let handle = null;
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

      const resolved = parseActiveOauthTokenDetailed(decoded);
      if (resolved.token && resolved.token !== PLACEHOLDER && resolved.token.trim()) {
        tok = resolved.token;
        handle = resolved.handle;
        break;
      }
    }

    if (!anyFound) return { rearmed: false, reason: "absent", handle: null };
    if (!tok || !tok.trim()) return { rearmed: false, reason: "empty", handle: null };

    if (tok === env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { rearmed: false, reason: "unchanged", handle: null };
    }

    env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    env.CATALYST_CLAUDE_ACCOUNTS_SOURCE = "shared-file-resynced";
    log?.warn?.(
      {},
      "claude-accounts-rearm: active-slot token changed on disk " +
        "(cluster-sync materialized a rotation or account-slot switch) — " +
        "re-armed in-process, no restart needed",
    );
    try {
      emit(
        rearmEventEnvelope({
          handle,
          host,
          id: randomBytes(8).toString("hex"),
          traceId: randomBytes(16).toString("hex"),
          spanId: randomBytes(8).toString("hex"),
          resource: buildCatalystResource({ serviceName: "catalyst.execution-core", host }),
        }),
      );
    } catch {
      // fail-open: the rearm is the act; the event is the receipt. Never let the
      // receipt fail the act — a full disk must not pin the fleet to a walled account.
    }
    return { rearmed: true, reason: "rotated", handle };
  } catch (err) {
    log?.warn?.({ err: err?.message }, "claude-accounts-rearm: re-arm failed (continuing)");
    return { rearmed: false, reason: "error", handle: null };
  }
}

// makeRearmSignalHandler — CTL-2147. The on-demand counterpart to the 5-minute
// cluster-sync tick. Deliberately arms ONLY claude-accounts.env: a signal handler
// must not perform network I/O (git pull / sops) or touch unrelated credentials.
export function makeRearmSignalHandler({ armSecret, env = process.env, log = defaultLog } = {}) {
  return function onRearmSignal() {
    try {
      const r = armSecret("claude-accounts.env", { env });
      log?.info?.({ armed: r?.armed === true }, "SIGHUP: claude-accounts rearm requested");
    } catch (err) {
      // A signal handler that throws takes the daemon down. Never.
      log?.warn?.({ err: err?.message }, "SIGHUP: rearm threw (continuing)");
    }
  };
}

// wireRearmSighup — CTL-2147. The daemon's actual production wiring, extracted
// out of daemon.mjs's main() so it is unit-testable: main() itself boots real
// timers/fs.watch/child processes and is deliberately never called from a test,
// which left the previous inline `process.on("SIGHUP", ...)` line provable only
// by a source-scan regex (daemon-signals.test.mjs), never by actually firing the
// signal and observing armSecret get called. Call with a real `process` in
// production; a test passes any EventEmitter-shaped stand-in. Returns the
// registered handler so a test can also invoke it directly without going
// through emit().
export function wireRearmSighup(proc = process, { armSecret, env = process.env, log = defaultLog } = {}) {
  const handler = makeRearmSignalHandler({ armSecret, env, log });
  proc.on("SIGHUP", handler);
  return handler;
}
