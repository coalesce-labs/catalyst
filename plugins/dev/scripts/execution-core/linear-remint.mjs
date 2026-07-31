// linear-remint.mjs — CTL-785 follow-up: re-mint the Catalyst Orchestrator
// app-actor token on a mid-run 401. The startup mint (catalyst-execution-core
// cmd_start) runs ONCE; a daemon crossing the OAuth expiry boundary would
// otherwise fail every Linear call until restarted. Secrets hygiene: the
// clientSecret/token are read into variables and never logged (house style:
// ratelimit-poller.mjs).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log } from "./config.mjs";

const OAUTH_ENDPOINT = "https://api.linear.app/oauth/token";
const MINT_SCOPE = "read,write,comments:create,app:assignable,app:mentionable";
const DEFAULT_COOLDOWN_MS = 60_000;

// isAuthError — Linear auth failures as surfaced on linearis stderr. Matched
// loosely (message wording unverified against a live expired token; the
// GraphQL contract is errors[].extensions.code === "AUTHENTICATION_ERROR"
// with "Authentication required" messages; the oauth layer can serve 401).
// CTL-1078: broadened to also match OAuth scope rejections (400 invalid_scope,
// 403 forbidden, insufficient_scope) which the CTL-835 incident produced.
// Deliberately does NOT overlap isRateLimitError (no 429/rate-limit).
export function isAuthError(stderr) {
  return /authentication[ _-]?(required|error)|unauthorized|\b401\b|\b403\b|invalid[_ -]?scope|insufficient[_ -]?scope|forbidden/i.test(
    String(stderr ?? ""),
  );
}

// isBatchAuthError — GraphQL errors[] auth shape (sibling of isBatchRateLimited).
export function isBatchAuthError(errors) {
  return (errors ?? []).some(
    (e) => e?.extensions?.code === "AUTHENTICATION_ERROR" || isAuthError(e?.message),
  );
}

// defaultLayer2Path — the FULL Layer-2 selection chain (install-lifecycle.mjs
// order: CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG >
// $XDG_CONFIG_HOME/catalyst/config.json > ~/.config/catalyst/config.json).
// CTL-1577 round 2: previously only the first env override was honored, so a
// daemon launched with MACHINE_CONFIG/XDG would startup-mint fine (the bash
// helper resolves the chain) but find NO creds at re-mint time.
function defaultLayer2Path() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    process.env.CATALYST_MACHINE_CONFIG ||
    (process.env.XDG_CONFIG_HOME
      ? resolve(process.env.XDG_CONFIG_HOME, "catalyst", "config.json")
      : resolve(homedir(), ".config", "catalyst", "config.json"))
  );
}

export function readOrchestratorCreds(layer2Path = defaultLayer2Path()) {
  try {
    const parsed = JSON.parse(readFileSync(layer2Path, "utf8"));
    const o = parsed?.catalyst?.linear?.bot?.orchestrator;
    if (
      typeof o?.clientId === "string" &&
      o.clientId &&
      typeof o?.clientSecret === "string" &&
      o.clientSecret
    ) {
      return { clientId: o.clientId, clientSecret: o.clientSecret };
    }
  } catch {
    /* unreadable/malformed → null (fail-open) */
  }
  return null;
}

// buildMintCurlArgs — argv + form payload for the client_credentials mint.
// Mirrors the bash startup mint: --noproxy '*' keeps it off the audit MITM.
// Secret travels via --data @- (stdin), never argv. Exported for unit coverage.
export function buildMintCurlArgs({ clientId, clientSecret }) {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: MINT_SCOPE,
    actor: "app",
  }).toString();
  return {
    args: [
      "-sS",
      "--max-time",
      "30",
      "--noproxy",
      "*",
      "-X",
      "POST",
      OAUTH_ENDPOINT,
      "--data",
      "@-",
    ],
    payload,
  };
}

export function parseMintResponse({ code, stdout }) {
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout)?.access_token || null;
  } catch {
    return null;
  }
}

// defaultMint — synchronous (the scheduler tick is sync; see defaultBatchExec).
function defaultMint(creds) {
  const { args, payload } = buildMintCurlArgs(creds);
  const res = spawnSync("curl", args, { input: payload, encoding: "utf8" });
  return parseMintResponse({ code: res.status ?? 1, stdout: res.stdout ?? "" });
}

function defaultApplyToken(token) {
  process.env.LINEAR_API_TOKEN = token;
  process.env.LINEAR_API_KEY = token;
}

// createReminter — cooldown-guarded re-mint. attempt() returns true iff a new
// token was minted AND applied. At most one mint per cooldown window regardless
// of outcome (storm guard for revoked creds); recovers automatically once the
// cooldown elapses. No creds configured → permanent no-op (fail-open: the
// daemon keeps whatever token it has).
export function createReminter({
  readCreds = readOrchestratorCreds,
  mint = defaultMint,
  applyToken = defaultApplyToken,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  logger = log,
} = {}) {
  let lastAttempt = -Infinity;
  return {
    attempt(now = Date.now()) {
      if (now - lastAttempt < cooldownMs) return false;
      lastAttempt = now;
      const creds = readCreds();
      if (!creds) return false;
      const token = mint(creds);
      if (!token) {
        logger.warn({}, "ctl-785: orchestrator token re-mint FAILED — keeping current token");
        return false;
      }
      applyToken(token);
      logger.info({}, "ctl-785: orchestrator token re-minted after auth error");
      return true;
    },
  };
}

// Process-wide singleton (same pattern as linearBreaker).
export const linearReminter = createReminter();

// defaultMintAsync — non-blocking mint (spawn, not spawnSync) for daemons whose
// event loop must stay free during a slow OAuth endpoint (the broker routes
// webhooks and tails the event log; a 30s spawnSync would freeze both —
// CTL-1577 round 2). Same argv/payload as defaultMint; secret rides stdin.
function defaultMintAsync(creds) {
  const { args, payload } = buildMintCurlArgs(creds);
  return new Promise((resolveMint) => {
    let child;
    try {
      child = spawn("curl", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolveMint(null);
      return;
    }
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", () => resolveMint(null));
    child.on("close", (code) =>
      resolveMint(parseMintResponse({ code: code ?? 1, stdout: out })),
    );
    // A curl that dies before draining stdin EPIPEs this pipe; unhandled, that
    // is an uncaught 'error' that would kill the daemon instead of taking the
    // fail-open null path. Swallow it — the close handler still resolves.
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(payload);
    } catch {
      /* stream already destroyed — close handler resolves the mint as failed */
    }
  });
}

// createAsyncReminter — the async twin of createReminter (identical cooldown +
// fail-open contract; attempt() resolves true iff a new token was minted AND
// applied). The cooldown stamp is taken BEFORE the await so overlapping callers
// within one window collapse to a single mint.
export function createAsyncReminter({
  readCreds = readOrchestratorCreds,
  mint = defaultMintAsync,
  applyToken = defaultApplyToken,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  logger = log,
} = {}) {
  let lastAttempt = -Infinity;
  return {
    async attempt(now = Date.now()) {
      if (now - lastAttempt < cooldownMs) return false;
      lastAttempt = now;
      const creds = readCreds();
      if (!creds) return false;
      const token = await mint(creds);
      if (!token) {
        logger.warn({}, "ctl-785: orchestrator token re-mint FAILED — keeping current token");
        return false;
      }
      applyToken(token);
      logger.info({}, "ctl-785: orchestrator token re-minted after auth error");
      return true;
    },
  };
}

// Process-wide singleton for async consumers (the broker's cache reconcile).
export const linearAsyncReminter = createAsyncReminter();

// withAuthRemint — wrap a raw exec: on an auth-error failure, attempt ONE
// re-mint; if a fresh token was applied, retry the call once (the spawned
// child inherits the updated process.env). Composes UNDER withBreaker so an
// open breaker still short-circuits before any spawn.
// CTL-1339: a 3rd `opts` arg (e.g. { timeoutMs }) is forwarded to the wrapped
// exec on BOTH the initial call AND the post-remint retry, so the opt-in
// per-call wall-clock cap applies to both attempts. The remint logic is unchanged.
export function withAuthRemint(rawExec, { reminter = linearReminter, now = Date.now } = {}) {
  return (cmd, args, opts) => {
    const res = rawExec(cmd, args, opts);
    if (res.code !== 0 && isAuthError(res.stderr) && reminter.attempt(now())) {
      return rawExec(cmd, args, opts);
    }
    return res;
  };
}
