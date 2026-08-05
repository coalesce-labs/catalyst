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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
// fileURLToPath(import.meta.url) resolves under BOTH bun and node (import.meta.dir
// is a bun-only extension), so this module loads regardless of the parent runtime.
const PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "claude-accounts-usage.mjs",
);
const ENV_FILE =
  process.env.CLAUDE_ACCOUNTS_ENV ?? resolve(homedir(), ".config/catalyst/claude-accounts.env");

// resolveOnPath — mirrors catalyst-stack's `_ca_node_runtime` (`command -v bun`):
// scan $PATH for the binary and return its ABSOLUTE path (not a bare command
// name) — see resolveRuntime's doc comment for why the bare name is unsafe.
function resolveOnPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = resolve(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const BUN_HOME_DEFAULT = resolve(homedir(), ".bun/bin/bun");

/**
 * resolveRuntime — the CHILD runtime that runs the probe. ALWAYS an absolute
 * path when bun is the choice, never the bare `bun` command name: the bash -c
 * subshell this spawns into (defaultAccountsProbeExec, below) inherits this
 * process's PATH, but a launchd/mise-managed monitor can be launched via an
 * ABSOLUTE Bun path on a restricted PATH that omits bun's own directory — the
 * bare command name then exits command-not-found in the child and every real
 * probe degrades to a spawn/error posture (CTL-1653 Codex round-2 finding: the
 * round-1 fix detected bun's PRESENCE correctly but still returned the literal
 * string "bun" instead of a usable path).
 *
 * Preference order, each one proven independently of the others:
 *   (1) this process's OWN Bun executable (`process.execPath`) — when the
 *       monitor itself is running under bun, this is proven valid regardless
 *       of PATH;
 *   (2) `bun` resolved from PATH, as an absolute path (mirrors catalyst-stack's
 *       `_ca_node_runtime` / `command -v bun` — catches a Homebrew/managed
 *       install this process happens not to be running under);
 *   (3) the historical `~/.bun/bin/bun` default-install path, kept for
 *       back-compat;
 *   (4) `node` (bare command name; last resort — mirrors catalyst-stack's own
 *       node fallback, which is also a bare name).
 *
 * All five inputs are injectable so every branch is independently testable
 * without depending on whether THIS test process happens to be running under
 * bun (it always is, under `bun test`) or what the test host's PATH contains.
 *
 * @param {object} [o]
 * @param {boolean}  [o.isBun]         default: typeof Bun !== "undefined"
 * @param {string}   [o.execPath]      default: process.execPath
 * @param {Function} [o.resolveOnPath] default: the module's own PATH scanner
 * @param {string}   [o.bunHomeDefault] default: BUN_HOME_DEFAULT
 * @param {boolean}  [o.bunHomeExists] default: existsSync(BUN_HOME_DEFAULT)
 * @returns {string}
 */
export function resolveRuntime({
  isBun = typeof Bun !== "undefined",
  execPath = process.execPath,
  resolveOnPath: resolveOnPathFn = resolveOnPath,
  bunHomeDefault = BUN_HOME_DEFAULT,
  bunHomeExists = existsSync(BUN_HOME_DEFAULT),
} = {}) {
  if (isBun) return execPath;
  const onPath = resolveOnPathFn("bun");
  if (onPath) return onPath;
  if (bunHomeExists) return bunHomeDefault;
  return "node";
}

const RUNTIME = resolveRuntime();

// The token-assignment line shape the env-file contract defines (mirrors
// claude-accounts-usage.mjs's parseAccountsEnv regex byte-for-byte — see that
// file's SECRETS HYGIENE header comment for the full contract).
const CLAUDE_TOKEN_LINE_RE = /^(?:export\s+)?CLAUDE_TOKEN_[A-Za-z0-9_]+=(.*)$/;
const PASTE_TOKEN_PLACEHOLDER = "PASTE_TOKEN_HERE";

/**
 * hasUsableAccountsEnv — cheap parse: does this env file define at least one
 * non-empty, non-placeholder `CLAUDE_TOKEN_<label>=…` entry? The env-file
 * contract (claude-accounts-usage.mjs's parseAccountsEnv, and its own exit-1
 * "No CLAUDE_TOKEN_* tokens found" message) treats a file that exists but has
 * no USABLE entry the same as an absent file — this mirrors that regex + the
 * same placeholder skip so this check agrees with what the probe itself would
 * find (CTL-1653 Codex round-2 finding: existence alone let an empty or
 * placeholder-only file still spawn the probe, which then exits nonzero with
 * no JSON and surfaced as available:true/status:"error" instead of the
 * documented available:false contract).
 *
 * SECRETS HYGIENE: a candidate token value is held in a local var only long
 * enough to test truthiness/placeholder-equality (identical discipline to
 * parseAccountsEnv itself) — it is never logged, stored beyond this function,
 * or returned.
 *
 * THROWS on a read failure that is NOT "the file is gone" (permission denied,
 * ownership, or any other I/O error) — CTL-1653 Codex round-3 finding: an
 * unreadable-but-present file (broken permissions/ownership on a real secret
 * deployment) must surface as a probe ERROR, not silently look like the same
 * "intentionally disabled" state as a genuinely absent/empty file. The throw
 * propagates out of defaultAccountsProbeExec (below) uncaught, so
 * createAccountsProbe's existing runProbe() catch synthesizes the SAME
 * status:"error" posture it already builds for any other exec() failure —
 * reusing that machinery rather than inventing a second error shape.
 */
function hasUsableAccountsEnv(envFile) {
  let raw;
  try {
    raw = readFileSync(envFile, "utf8");
  } catch (err) {
    // ENOENT here (vs. the existsSync gate above) is a benign TOCTOU race —
    // the file vanished between the two checks — and is still "absent".
    // Anything else (EACCES, EPERM, ownership, …) is a real misconfiguration.
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(CLAUDE_TOKEN_LINE_RE);
    if (!m) continue;
    const rhs = m[1].trimStart();
    const q = rhs[0];
    const token =
      q === "'" || q === '"'
        ? (() => {
            const end = rhs.indexOf(q, 1);
            return end === -1 ? rhs.slice(1) : rhs.slice(1, end);
          })()
        : (rhs.match(/^(\S+)/)?.[1] ?? "");
    if (token && token !== PASTE_TOKEN_PLACEHOLDER) return true;
  }
  return false;
}

/**
 * defaultAccountsProbeExec — run the CTL-1650 probe in a subshell that sources the
 * accounts env so CLAUDE_CODE_OAUTH_TOKEN is visible for active-account detection
 * and never enters this (long-lived monitor) process's env. Returns the token-free
 * JSON record ({generatedAt, accounts:[…]}). When no env file exists — OR one
 * exists but defines no usable CLAUDE_TOKEN_* entry (empty file, comments-only,
 * every entry still the PASTE_TOKEN_HERE placeholder) — returns an empty
 * `available:false` record so the surfaces render "unavailable"/quiet rather
 * than erroring (deriveAccountsSummary propagates the flag; see below). When the
 * file EXISTS but is unreadable (permission/ownership — a real misconfiguration,
 * not an intentional disabled state), THROWS instead — see hasUsableAccountsEnv's
 * doc comment; the caller's createAccountsProbe.runProbe() catch turns that into
 * the usual status:"error" posture. When the probe exits nonzero (e.g. every
 * configured account is invalid/auth-failing), the token-free JSON it already
 * wrote to stdout is recovered from the rejected exec's `.stdout` rather than
 * discarded — otherwise a diagnosable per-account auth error collapses into a
 * synthetic unlabeled spawn-error posture.
 */
export async function defaultAccountsProbeExec({
  envFile = ENV_FILE,
  timeoutMs = 30000,
  // probePath/runtime default to the module consts (production-identical); they are
  // injectable ONLY so the secrets-hygiene mechanism is unit-testable against a stub
  // probe with no network call — see accounts-probe.test.mjs.
  probePath = PROBE,
  runtime = RUNTIME,
} = {}) {
  if (!existsSync(envFile) || !hasUsableAccountsEnv(envFile)) {
    return { generatedAt: new Date().toISOString(), accounts: [], available: false };
  }
  // `set -a` exports every sourced var to the exec'd child only; the token dies
  // with this bash -c subshell and never reaches the monitor's own env.
  const script = `set -a; . "$CATALYST_ACCOUNTS_ENV"; set +a; exec "$RT" "$PROBE" --json`;
  // Defense-in-depth: strip any ambient CLAUDE_CODE_OAUTH_TOKEN from the child's
  // inherited env so the sourced accounts file is the SOLE authority for the
  // active-account selection — a monitor daemon mis-started with the token in its
  // own env can't silently forward it (the design keeps it out of the monitor env).
  const childEnv = { ...process.env, CATALYST_ACCOUNTS_ENV: envFile, RT: runtime, PROBE: probePath };
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const { stdout } = await execFileP("bash", ["-c", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
    });
    return JSON.parse(stdout);
  } catch (err) {
    // Node's promisified execFile attaches the child's stdout/stderr to the
    // rejection even on a nonzero exit. Recover and parse it so a diagnosable
    // per-account error (expired token, auth failure) survives; a parse failure
    // (truly no usable stdout) falls through to rethrowing the original error.
    if (typeof err?.stdout === "string" && err.stdout.trim() !== "") {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* fall through — rethrow below */
      }
    }
    throw err;
  }
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

// Whitelist-map ONE rate-limit window to a token-free view. RECURSIVE field pick
// so the "a leaked field can't ride along" guarantee holds at EVERY level, not
// just the top — a future upstream change that attached anything under a window
// object can never flow through to the API/SSE.
function pickWindow(w) {
  if (!w || typeof w !== "object") return null;
  return { pct: w.pct ?? null, resetsAt: w.resetsAt ?? null, status: w.status ?? null };
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
    fiveHour: pickWindow(a?.fiveHour),
    sevenDay: pickWindow(a?.sevenDay),
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
 * `raw.available === false` (defaultAccountsProbeExec's no-env-file record) short-
 * circuits to the SAME minimal shape the disabled (`accountsProbeExec:null`) path
 * returns — no status/active/accounts — so /api/accounts and the SSE frame can't
 * be told apart from a genuinely disabled probe by callers.
 *
 * @param {object} raw   the probe's {generatedAt, accounts:[…]} record
 * @param {object} opts  { node }
 * @returns {{node, generatedAt, status, active, accounts, siblingWithHeadroom}}
 */
export function deriveAccountsSummary(raw, { node } = {}) {
  if (raw?.available === false) return { node: node ?? null, available: false };
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
 * Two DoS guards (each real probe spends one Haiku call PER account):
 *  - **In-flight coalescing** — concurrent `get()` calls share ONE probe, so a
 *    burst of parallel requests can never fan out into N subprocesses.
 *  - **Refresh floor** — a forced `refresh` still serves the cache when it is
 *    younger than `refreshFloorMs` (< `ttlMs`), so a client cannot loop
 *    `?refresh=true` to spend unbounded inference / self-exhaust the accounts.
 *
 * @param {object} o
 * @param {Function} o.exec           async () => raw probe record
 * @param {number}   [o.ttlMs]        cache TTL for normal reads (default 5 min)
 * @param {number}   [o.refreshFloorMs] min age before a forced refresh re-probes (default 30 s)
 * @param {Function} [o.now]          injectable clock (default Date.now)
 * @param {string}   o.node           this node's identity
 * @returns {{get, latest}}
 */
export function createAccountsProbe({
  exec,
  ttlMs = 5 * 60 * 1000,
  refreshFloorMs = 30 * 1000,
  now = () => Date.now(),
  node,
}) {
  let cache = null; // { summary, probedAt }
  let inflight = null; // shared promise while a probe is running (coalescing)
  let lastProbeStartedAt = null; // probe INITIATION clock, set even when the probe errors
  let lastResult = null; // most recent returned summary (ok OR error posture)

  function serveCache() {
    return { ...cache.summary, probedAt: cache.probedAt, cached: true };
  }

  function runProbe() {
    if (inflight) return inflight; // coalesce concurrent callers onto one probe
    lastProbeStartedAt = now(); // floor gates INITIATION, so record it before exec()
    inflight = (async () => {
      try {
        const raw = await exec();
        const summary = deriveAccountsSummary(raw, { node });
        cache = { summary, probedAt: now() };
        lastResult = { ...summary, probedAt: cache.probedAt, cached: false };
        return lastResult;
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
        lastResult = { ...summary, probedAt: now(), cached: false };
        return lastResult;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function get({ refresh = false } = {}) {
    // Normal reads serve within the full TTL; a forced refresh serves within the
    // shorter floor. refreshFloorMs < ttlMs, so `refresh` still probes sooner — it
    // just cannot be looped faster than the floor.
    const threshold = refresh ? refreshFloorMs : ttlMs;
    if (cache && now() - cache.probedAt < threshold) return serveCache();
    // A probe already running: coalesce onto it regardless of the floor.
    if (inflight) return inflight;
    // Gate probe INITIATION on the same cadence, not just cache hits: during a
    // sustained probe failure (errors are intentionally uncached) or a cold start
    // there is no cache to gate on, yet re-probing must not spawn a fresh subprocess +
    // Haiku call faster than `threshold` (the DoS the finding flags for ?refresh=true).
    // Serve the most recent posture (which may be an error) instead of re-probing;
    // retry once the window lapses.
    if (lastProbeStartedAt !== null && now() - lastProbeStartedAt < threshold) {
      if (lastResult) return { ...lastResult, cached: true };
    }
    return runProbe();
  }

  function latest() {
    return cache?.summary ?? null;
  }

  return { get, latest };
}
