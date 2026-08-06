// linear-remint.mjs — CTL-785 follow-up: re-mint the Catalyst Orchestrator
// app-actor token on a mid-run 401. The startup mint (catalyst-execution-core
// cmd_start) runs ONCE; a daemon crossing the OAuth expiry boundary would
// otherwise fail every Linear call until restarted. Secrets hygiene: the
// clientSecret/token are read into variables and never logged (house style:
// ratelimit-poller.mjs).
//
// CTL-1616 PR4: defaultLayer2Path/readOrchestratorCreds are folded onto the shared secret
// contract (resolveLayer2Path / resolveSecret("linear-orchestrator-actor")) so the Layer-2
// chain + config-path read are defined ONCE; the mint mechanics below (buildMintCurlArgs,
// defaultMint/defaultMintAsync) are UNCHANGED.
import { spawn, spawnSync } from "node:child_process";
import { log } from "./config.mjs";
import { registerRearmHook, resolveLayer2Path, resolveSecret } from "../lib/secret-contract.mjs";

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

// defaultLayer2Path — CTL-1616 PR4: delegates to the shared secret contract's
// resolveLayer2Path, which implements this SAME chain (CATALYST_LAYER2_CONFIG_FILE >
// CATALYST_MACHINE_CONFIG > $XDG_CONFIG_HOME/catalyst/config.json >
// ~/.config/catalyst/config.json — install-lifecycle.mjs order). Kept as a named export
// (rather than inlined at its one call site) for back-compat with any existing import.
export function defaultLayer2Path() {
  return resolveLayer2Path();
}

// readOrchestratorCreds — CTL-1616 PR4: the config-path + clientId/clientSecret READ is
// folded onto resolveSecret("linear-orchestrator-actor"), which resolves through the
// IDENTICAL Layer-2 chain and reads the SAME catalyst.linear.bot.orchestrator dotted path.
// `layer2Path` is accepted (and still honored) for back-compat with any existing caller that
// passes an explicit override path — it is threaded through as
// CATALYST_LAYER2_CONFIG_FILE (the highest-priority link in the chain, so an explicit
// override here still wins over ambient env).
export function readOrchestratorCreds(layer2Path) {
  const env = layer2Path
    ? { ...process.env, CATALYST_LAYER2_CONFIG_FILE: layer2Path }
    : process.env;
  const resolved = resolveSecret("linear-orchestrator-actor", { env });
  if (typeof resolved.value !== "string" || resolved.value.length === 0) return null;
  try {
    const parsed = JSON.parse(resolved.value);
    if (
      typeof parsed?.clientId === "string" &&
      parsed.clientId &&
      typeof parsed?.clientSecret === "string" &&
      parsed.clientSecret
    ) {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch {
    /* malformed canonicalized value — should be unreachable; fail-open */
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

// createOrchestratorActorRearmHook — CTL-1616 PR4: adapts ANY reminter's `.attempt()` (the
// createReminter/createAsyncReminter cooldown/read/mint/apply contract is UNCHANGED — this
// wraps it, never replaces it) into the registerRearmHook seam's synchronous
// `({env, deploymentMode}) => {rearmed}` contract. A pure function so it is unit-testable
// against a fully fake reminter — never the real `linearReminter` singleton — with zero risk
// of a hermetic test triggering a genuine network mint against api.linear.app.
export function createOrchestratorActorRearmHook(reminter) {
  return () => ({ rearmed: reminter.attempt() });
}

// Wire the process-wide sync reminter into the secret contract's rearm-hook seam (design
// §8/§9: "the cooldown reminters register as the row's on-401 rearm hook, unchanged in
// shape"). This is the reminter's mechanics UNCHANGED — only its existing .attempt() is now
// ALSO reachable through armSecret("linear-orchestrator-actor"), the same reminter
// withAuthRemint already drives reactively on an observed 401 below. registerRearmHook's own
// capability-ceiling check (design §6 rule 1) is what keeps a hookless re-armable row honest;
// this call is what satisfies it for this row.
//
// linearAsyncReminter (below) is DELIBERATELY NOT registered through this seam:
// registerRearmHook's contract is synchronous (armSecret reads `hook(...).rearmed`
// immediately, never awaiting), while the async reminter exists specifically so the broker's
// event loop is never blocked by a slow OAuth endpoint (CTL-1577 round 2) — forcing it
// through a synchronous hook would mean either blocking that event loop (defeating the
// reason it is async) or misreporting `rearmed` while a mint is still in flight. It keeps
// functioning exactly as today via withAuthRemint(rawExec, { reminter: linearAsyncReminter })
// in the broker's cache-reconcile path, untouched by this PR.
registerRearmHook("linear-orchestrator-actor", createOrchestratorActorRearmHook(linearReminter));

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
//
// CTL-1612 round 2 (Codex P2 follow-up): `failureCooldownMs` defaults to
// `cooldownMs` — so any EXISTING caller that doesn't pass it (the broker's
// cache-reconcile linearAsyncReminter singleton below) is byte-identical to
// before this change: the same cooldown gates both outcomes. A caller that
// DOES pass a shorter `failureCooldownMs` (the monitor's proactive
// self-mint — a Linear/network hiccup should be retried soon, not ride out
// the long success cooldown while every poll in between sends an expired
// token) gets a short retry window after a FAILED attempt (no creds
// configured, or a mint that returned no token) while a SUCCESSFUL mint still
// only re-attempts after the full `cooldownMs`.
// CTL-1612 round 5 (Codex P2 follow-up): `initialLastAttempt` seeds the
// cooldown gate's starting point. Default -Infinity is UNCHANGED from before
// this param existed — every existing caller (the broker's linearAsyncReminter
// singleton below) that omits it still fires on its very first attempt(),
// byte-identical to today. A caller that already has a KNOWN-FRESH token in
// hand at construction time — the monitor's server.ts, when the shell startup
// mint (catalyst-monitor.sh cmd_start → linear_app_actor_auth) already
// succeeded before this process even started — passes Date.now() so the
// FIRST attempt() call correctly honors the full cooldownMs instead of
// re-minting seconds after the shell already did (a redundant OAuth POST on
// every monitor start/restart, doubling production mint traffic).
export function createAsyncReminter({
  readCreds = readOrchestratorCreds,
  mint = defaultMintAsync,
  applyToken = defaultApplyToken,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  failureCooldownMs = cooldownMs,
  logger = log,
  initialLastAttempt = -Infinity,
} = {}) {
  let lastAttempt = initialLastAttempt;
  // The cooldown to apply to the CURRENT attempt's gate check — set by the
  // PREVIOUS attempt's outcome. Starts at cooldownMs (no prior outcome to
  // shorten it) so the very first call is never fast-tracked by an unset value.
  let nextCooldownMs = cooldownMs;
  // CTL-1612 round 3 (Codex P2 follow-up): the cooldown gate above is TIME-only
  // — it does not, by itself, stop a SECOND attempt() from starting while a
  // FIRST is still awaiting its mint. In practice the active cooldown is
  // always >= the mint's own worst-case duration (curl --max-time 30 inside
  // buildMintCurlArgs), so this never fires for a well-behaved caller — but a
  // caller-supplied failureCooldownMs/poll cadence shorter than that ceiling,
  // or a curl call that somehow outlives its own --max-time, would let two
  // mints race: duplicate network calls, and an out-of-order applyToken() if
  // the SECOND (later-started) call happens to resolve before the first.
  // inFlight is a simple latch, independent of the time gate, that closes
  // that gap unconditionally. Non-overlapping callers (the broker's
  // linearAsyncReminter singleton, which always awaits one attempt() before
  // issuing the next) never observe inFlight as true on entry, so this is
  // purely additive for them.
  let inFlight = false;
  return {
    async attempt(now = Date.now()) {
      if (inFlight) return false;
      if (now - lastAttempt < nextCooldownMs) return false;
      lastAttempt = now;
      inFlight = true;
      try {
        const creds = readCreds();
        if (!creds) {
          nextCooldownMs = failureCooldownMs;
          return false;
        }
        const token = await mint(creds);
        if (!token) {
          logger.warn({}, "ctl-785: orchestrator token re-mint FAILED — keeping current token");
          nextCooldownMs = failureCooldownMs;
          return false;
        }
        applyToken(token);
        logger.info({}, "ctl-785: orchestrator token re-minted after auth error");
        nextCooldownMs = cooldownMs;
        return true;
      } finally {
        inFlight = false;
      }
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
