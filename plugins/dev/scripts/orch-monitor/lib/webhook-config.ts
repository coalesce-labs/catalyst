import { readFileSync } from "fs";
import { join } from "path";

export interface WebhookCliConfig {
  smeeChannel: string;
  secret: string;
  /** Env-var name the GitHub webhook secret is read from (e.g. "CATALYST_WEBHOOK_SECRET"). */
  secretEnvName: string;
  /**
   * Repos to subscribe to at startup, regardless of whether a worker has been
   * observed for them. Layer 1 only (team-wide). Empty array means
   * auto-discovery is the only subscription path. CTL-216.
   */
  watchRepos: string[];
  /**
   * Linear webhook signing secrets (CTL-273, CTL-285). Array of {key, secret} pairs,
   * where key is "workspace" or a team short key (e.g. "ctl", "adv"), and secret is
   * the HMAC signing secret. Resolution order per key (CTL-285):
   *   1. `~/.config/catalyst/linear-webhook-secret-{key}` (per-team file, mode 600)
   *      — for "workspace" key, reads `linear-webhook-secret` (no suffix)
   *   2. `process.env[linearWebhookSecretEnv]` from Layer 1 env-var name
   *   3. `process.env.CATALYST_LINEAR_WEBHOOK_SECRET` (fallback)
   * Empty array when no Linear config is present — the server then disables
   * `POST /api/webhook/linear`. The handler tries each secret in order until
   * one validates, supporting both workspace-wide and per-team webhooks.
   * CTL-210.
   */
  linearSecrets: Array<{ key: string; secret: string }>;
  /**
   * smee.io channel URL for Linear webhook delivery (Layer 2, per-machine).
   * Read from `catalyst.monitor.linear.smeeChannel` in `~/.config/catalyst/config.json`.
   * Env override: `CATALYST_LINEAR_SMEE_CHANNEL`. Empty string when not configured —
   * the server then skips creating the second tunnel. CTL-242.
   */
  linearSmeeChannel: string;
  /**
   * Linear bot user UUIDs for loop prevention. Suppresses issue events where the
   * actor matches any ID in the set before they reach the event log. CTL-263.
   * Collected from:
   *   1. NEW: `~/.config/catalyst/config.json` catalyst.linear.bot.worker.botUserId
   *   2. NEW: `~/.config/catalyst/config.json` catalyst.linear.bot.orchestrator.botUserId
   *   3. OLD: `.catalyst/config.json`           catalyst.monitor.linear.botUserId
   * Empty set when not configured — no suppression.
   */
  linearBotUserIds: ReadonlySet<string>;
  /**
   * Optional team→repo mapping read from `catalyst.monitor.linear.teams[]` in
   * Layer 1 (project config). Each entry is `{ key, vcsRepo }` where `key` is
   * the Linear team short key (e.g. "CTL") and `vcsRepo` is the canonical
   * `owner/repo` string written into `attributes["vcs.repository.name"]` for
   * issue/comment/cycle events from that team. Empty array when not configured —
   * the Linear webhook handler then leaves the repo attribute unset (current
   * pre-CTL-362 behaviour). CTL-362.
   */
  linearTeams: Array<{ key: string; vcsRepo: string }>;
  /**
   * OAuth app-actor credentials for the Catalyst Linear identity (CTL-550).
   * Loaded from the project-specific Layer-2 config
   * (`~/.config/catalyst/config-{projectKey}.json`).
   * Null when not configured — the phase agents fall back to personal-token
   * linearis CLI.
   */
  linearAgentConfig: LinearAgentConfig | null;
}

export interface LinearAgentConfig {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  botUserId?: string;
}

interface FileExtract {
  smeeChannel: string | null;
  webhookSecretEnv: string | null;
  watchRepos: string[];
  /** Env-var name holding the Linear webhook signing secret (Layer 1). */
  linearWebhookSecretEnv: string | null;
  /** smee.io channel URL for Linear, from Layer 2 only (per-machine). CTL-242. */
  linearSmeeChannel: string | null;
  /** Linear bot user UUID for loop prevention, from Layer 1 (project). CTL-263. */
  linearBotUserId: string | null; // single string; assembled into a Set in loadWebhookConfig
  /** Linear team→repo map from Layer 1 (project). CTL-362. */
  linearTeams: Array<{ key: string; vcsRepo: string }>;
}

let warnedDeprecatedSmeeChannel = false;

// Exposed for tests only.
export function _resetWebhookDeprecationWarning(): void {
  warnedDeprecatedSmeeChannel = false;
}

// Loose owner/repo shape: alphanumerics, dots, dashes, underscores, exactly one
// slash, non-empty parts. GitHub allows more characters in usernames but this
// covers every realistic case and rejects obvious typos like missing slashes
// or extra path components.
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function readWatchRepos(github: Record<string, unknown>): string[] {
  const raw = github.watchRepos;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (!REPO_SHAPE.test(trimmed)) {
      console.warn(
        `[webhook-config] Ignoring watchRepos entry "${trimmed}" — expected "owner/repo".`
      );
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// Helper to extract all Linear webhook secrets from the keyed Layer 2 structure.
// Reads each key in catalyst.monitor.linear and attempts to load its secret.
// Backward compatibility: If catalyst.monitor.linear is a single object,
// treat it as "workspace" key.
//
// Secret resolution order per key (CTL-285):
//   1. Per-team file: ~/.config/catalyst/linear-webhook-secret-{key}
//      (for "workspace" key: linear-webhook-secret, no suffix)
//   2. Env var named by linearWebhookSecretEnv from Layer 1
//   3. CATALYST_LINEAR_WEBHOOK_SECRET env var fallback
//
// Arguments:
//   linear: the catalyst.monitor.linear object/dict from Layer 2
//   linearWebhookSecretEnv: env-var name from Layer 1 (optional)
//   homeConfigDir: path to ~/.config/catalyst/ for per-team secret files
//
// Returns: array of {key, secret} pairs
function readAllLinearSecrets(
  linear: unknown,
  linearWebhookSecretEnv: string | null,
  homeConfigDir: string,
): Array<{ key: string; secret: string }> {
  if (!isRecord(linear)) return [];
  const out: Array<{ key: string; secret: string }> = [];

  const readSecretFile = (fileName: string): string => {
    try {
      return readFileSync(join(homeConfigDir, fileName), "utf8").trim();
    } catch {
      return "";
    }
  };

  const resolveSecret = (key: string): string => {
    const fileName =
      key === "workspace"
        ? "linear-webhook-secret"
        : `linear-webhook-secret-${key}`;
    const fileSecret = readSecretFile(fileName);
    if (fileSecret.length > 0) return fileSecret;
    return (
      (linearWebhookSecretEnv !== null
        ? process.env[linearWebhookSecretEnv]
        : undefined) ??
      process.env.CATALYST_LINEAR_WEBHOOK_SECRET ??
      ""
    );
  };

  // Check if this is the old single-object format
  const isSingleObject =
    typeof linear.webhookId === "string" &&
    linear.webhookId.length > 0;

  if (isSingleObject) {
    // Legacy single-object format — treat as "workspace" key
    const secret = resolveSecret("workspace");
    if (secret.length > 0) {
      out.push({ key: "workspace", secret });
    }
    return out;
  }

  // Keyed object format — iterate all keys
  for (const key in linear) {
    if (!Object.prototype.hasOwnProperty.call(linear, key)) continue;
    const entry = linear[key];
    if (!isRecord(entry)) continue;
    if (typeof entry.webhookId !== "string" || entry.webhookId.length === 0)
      continue;

    const secret = resolveSecret(key);
    if (secret.length > 0) {
      out.push({ key, secret });
    }
  }

  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// CTL-362: parse `catalyst.monitor.linear.teams[]` into a list of
// `{ key, vcsRepo }` pairs. Skips entries with missing keys or repos that
// don't match the `owner/repo` shape — same lenient-with-warnings behaviour
// as `readWatchRepos`. Deduplicates by `key` (last entry wins, with a warn).
function readLinearTeams(
  linear: Record<string, unknown>,
): Array<{ key: string; vcsRepo: string }> {
  const raw = linear.teams;
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      console.warn(`[webhook-config] Ignoring linear.teams entry — not an object: ${JSON.stringify(entry)}`);
      continue;
    }
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const vcsRepo = typeof entry.vcsRepo === "string" ? entry.vcsRepo.trim() : "";
    if (key.length === 0) {
      console.warn(`[webhook-config] Ignoring linear.teams entry with empty "key"`);
      continue;
    }
    if (vcsRepo.length === 0 || !REPO_SHAPE.test(vcsRepo)) {
      console.warn(
        `[webhook-config] Ignoring linear.teams entry for key "${key}" — vcsRepo "${vcsRepo}" must match "owner/repo".`,
      );
      continue;
    }
    if (byKey.has(key)) {
      console.warn(
        `[webhook-config] Duplicate linear.teams entry for key "${key}" — last entry wins ("${vcsRepo}").`,
      );
    }
    byKey.set(key, vcsRepo);
  }
  return Array.from(byKey.entries()).map(([key, vcsRepo]) => ({ key, vcsRepo }));
}

// Extract the Linear smee channel URL from a linear config object. Prefers the
// top-level smeeChannel (legacy / current normal case) and falls back to the
// first keyed team entry that carries one (CTL-273/285 keyed format, CTL-301).
// Returns null if no usable channel is found.
function readLinearSmeeChannel(linear: Record<string, unknown>): string | null {
  if (typeof linear.smeeChannel === "string" && linear.smeeChannel.length > 0) {
    return linear.smeeChannel;
  }
  for (const value of Object.values(linear)) {
    if (
      isRecord(value) &&
      typeof value.smeeChannel === "string" &&
      value.smeeChannel.length > 0
    ) {
      return value.smeeChannel;
    }
  }
  return null;
}

function readGithubSection(filePath: string): FileExtract | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.catalyst)) return null;
  const monitor = parsed.catalyst.monitor;
  if (!isRecord(monitor)) return null;
  const github = isRecord(monitor.github) ? monitor.github : null;
  const linear = isRecord(monitor.linear) ? monitor.linear : null;
  if (github === null && linear === null) return null;

  const smeeChannel =
    github !== null && typeof github.smeeChannel === "string" && github.smeeChannel.length > 0
      ? github.smeeChannel
      : null;
  const webhookSecretEnv =
    github !== null &&
    typeof github.webhookSecretEnv === "string" &&
    github.webhookSecretEnv.length > 0
      ? github.webhookSecretEnv
      : null;
  const watchRepos = github !== null ? readWatchRepos(github) : [];
  const linearWebhookSecretEnv =
    linear !== null &&
    typeof linear.webhookSecretEnv === "string" &&
    linear.webhookSecretEnv.length > 0
      ? linear.webhookSecretEnv
      : null;
  const linearSmeeChannel = linear !== null ? readLinearSmeeChannel(linear) : null;
  const linearBotUserId =
    linear !== null && typeof linear.botUserId === "string" && linear.botUserId.length > 0
      ? linear.botUserId
      : null;
  const linearTeams = linear !== null ? readLinearTeams(linear) : [];

  return {
    smeeChannel,
    webhookSecretEnv,
    watchRepos,
    linearWebhookSecretEnv,
    linearSmeeChannel,
    linearBotUserId,
    linearTeams,
  };
}

/**
 * Load the Linear app-actor (worker) credentials. Reads from two locations with
 * the NEW global path taking precedence over the OLD per-team path:
 *
 *   NEW (global):   `~/.config/catalyst/config.json`
 *                   catalyst.linear.bot.worker.{clientId,clientSecret,webhookSecret,botUserId}
 *   OLD (per-team): `~/.config/catalyst/config-{projectKey}.json`
 *                   catalyst.linear.agent.{clientId,clientSecret,webhookSecret,botUserId}
 *
 * Returns null when neither location has the required `clientId` / `clientSecret`.
 * The `accessToken` field is intentionally not surfaced — callers mint fresh tokens
 * via `client_credentials` grant. CTL-550.
 */
export function loadLinearAgentConfig(
  homeConfigDir: string,
  projectKey: string | null,
): LinearAgentConfig | null {
  // Helper: extract agent cred fields from a parsed config object under the given
  // path (either catalyst.linear.bot.worker or catalyst.linear.agent).
  function extractCreds(
    parsed: unknown,
    path: string[],
  ): LinearAgentConfig | null {
    let cur: unknown = parsed;
    for (const key of path) {
      if (!isRecord(cur)) return null;
      cur = cur[key];
    }
    if (!isRecord(cur)) return null;
    const clientId = typeof cur.clientId === "string" ? cur.clientId : "";
    const clientSecret = typeof cur.clientSecret === "string" ? cur.clientSecret : "";
    if (clientId.length === 0 || clientSecret.length === 0) return null;
    const webhookSecret = typeof cur.webhookSecret === "string" ? cur.webhookSecret : "";
    const botUserId =
      typeof cur.botUserId === "string" && cur.botUserId.length > 0
        ? cur.botUserId
        : undefined;
    return { clientId, clientSecret, webhookSecret, ...(botUserId !== undefined ? { botUserId } : {}) };
  }

  // 1. NEW: try global config.json → catalyst.linear.bot.worker
  const globalConfigPath = join(homeConfigDir, "config.json");
  try {
    const globalParsed: unknown = JSON.parse(readFileSync(globalConfigPath, "utf8"));
    const result = extractCreds(globalParsed, ["catalyst", "linear", "bot", "worker"]);
    if (result !== null) return result;
  } catch { /* absent / malformed — fall through */ }

  // 2. OLD: try per-team config-{projectKey}.json → catalyst.linear.agent
  if (projectKey === null || projectKey.length === 0) return null;
  const perTeamConfigPath = join(homeConfigDir, `config-${projectKey}.json`);
  try {
    const perTeamParsed: unknown = JSON.parse(readFileSync(perTeamConfigPath, "utf8"));
    return extractCreds(perTeamParsed, ["catalyst", "linear", "agent"]);
  } catch {
    return null;
  }
}

/**
 * Loads webhook delivery config from the two files where pieces of it live:
 *
 * - `<homeConfigDir>/config.json` (cross-project, per-machine, NOT committed) —
 *   holds `catalyst.monitor.github.smeeChannel`. The smee URL is per-laptop
 *   because one orch-monitor daemon tunnels webhooks for every project on the
 *   machine.
 * - `<projectConfigPath>` (per-repo, committed, team-wide) — holds
 *   `catalyst.monitor.github.webhookSecretEnv` (the env-var **name** the secret
 *   is read from, not the value).
 *
 * If `smeeChannel` is found in `<projectConfigPath>` (the deprecated location),
 * the value is still honored but a one-shot deprecation warning is emitted.
 *
 * Env-var overrides:
 *   - `CATALYST_SMEE_CHANNEL` overrides any file-derived channel.
 *   - The secret is read from `process.env[webhookSecretEnv]`, with a legacy
 *     fallback to `process.env.CATALYST_SMEE_SECRET`.
 *
 * Returns `null` if either the channel or secret cannot be resolved.
 */
export function loadWebhookConfig(
  homeConfigDir: string,
  projectConfigPath: string,
  projectKey: string | null = null,
): WebhookCliConfig | null {
  const projectExtract = readGithubSection(projectConfigPath);
  const homeExtract = readGithubSection(join(homeConfigDir, "config.json"));

  const homeChannel = homeExtract?.smeeChannel ?? null;
  const projectChannel = projectExtract?.smeeChannel ?? null;
  const webhookSecretEnv = projectExtract?.webhookSecretEnv ?? "CATALYST_WEBHOOK_SECRET";

  if (projectChannel !== null && !warnedDeprecatedSmeeChannel) {
    warnedDeprecatedSmeeChannel = true;
    console.warn(
      "[webhook-config] Deprecated: catalyst.monitor.github.smeeChannel found in " +
        ".catalyst/config.json. The smee URL is per-machine — move it to " +
        "~/.config/catalyst/config.json. Run `setup-webhooks.sh --force` to " +
        "migrate. Layer 1 reads will be removed in a future release."
    );
  }

  const fileChannel = homeChannel ?? projectChannel;
  const channelOverride = process.env.CATALYST_SMEE_CHANNEL;
  const finalChannel =
    channelOverride && channelOverride.length > 0 ? channelOverride : (fileChannel ?? "");

  const secret = process.env[webhookSecretEnv] ?? process.env.CATALYST_SMEE_SECRET ?? "";

  // watchRepos is Layer 1 only — a team-default field. Reading from Layer 2
  // would let one developer's machine override the team list, which is the
  // opposite of what we want. CTL-216.
  const watchRepos = projectExtract?.watchRepos ?? [];

  // Linear webhook secrets (CTL-273). Reads from Layer 2 keyed structure.
  // Layer 1 carries the env-var name; the value lives in the env var itself.
  // Optional — empty array disables the Linear route. CTL-210.
  const linearWebhookSecretEnv = projectExtract?.linearWebhookSecretEnv ?? null;
  let homeLinearConfig: unknown;
  try {
    const homeConfigRaw = readFileSync(join(homeConfigDir, "config.json"), "utf8");
    const homeConfigParsed = JSON.parse(homeConfigRaw) as unknown;
    if (isRecord(homeConfigParsed) && isRecord(homeConfigParsed.catalyst)) {
      const monitor = homeConfigParsed.catalyst.monitor;
      if (isRecord(monitor)) {
        homeLinearConfig = monitor.linear;
      }
    }
  } catch {
    homeLinearConfig = undefined;
  }
  const linearSecrets = readAllLinearSecrets(
    homeLinearConfig ?? undefined,
    linearWebhookSecretEnv,
    homeConfigDir,
  );

  // Linear smee channel. Layer 2 only (per-machine) — same split as GitHub
  // smeeChannel. Env override wins. CTL-242.
  const fileLinearSmeeChannel = homeExtract?.linearSmeeChannel ?? null;
  const linearSmeeChannelOverride = process.env.CATALYST_LINEAR_SMEE_CHANNEL;
  const linearSmeeChannel =
    linearSmeeChannelOverride && linearSmeeChannelOverride.length > 0
      ? linearSmeeChannelOverride
      : (fileLinearSmeeChannel ?? "");

  // Collect all known Linear bot user UUIDs for loop prevention. CTL-263.
  // NEW: Layer-2 global config.json carries worker + orchestrator botUserIds.
  // OLD: Layer-1 project config carries catalyst.monitor.linear.botUserId (back-compat).
  const linearBotUserIds = new Set<string>();
  try {
    const globalParsed: unknown = JSON.parse(readFileSync(join(homeConfigDir, "config.json"), "utf8"));
    if (isRecord(globalParsed) && isRecord(globalParsed.catalyst)) {
      const bot = globalParsed.catalyst.linear;
      if (isRecord(bot) && isRecord(bot.bot)) {
        const botSection = bot.bot;
        if (isRecord(botSection.worker) && typeof botSection.worker.botUserId === "string") {
          const id = botSection.worker.botUserId;
          if (id.length > 0) linearBotUserIds.add(id);
        }
        if (isRecord(botSection.orchestrator) && typeof botSection.orchestrator.botUserId === "string") {
          const id = botSection.orchestrator.botUserId;
          if (id.length > 0) linearBotUserIds.add(id);
        }
      }
    }
  } catch { /* absent / malformed — continue to Layer-1 fallback */ }
  // OLD Layer-1 back-compat: catalyst.monitor.linear.botUserId.
  const layer1BotUserId = projectExtract?.linearBotUserId ?? "";
  if (layer1BotUserId.length > 0) linearBotUserIds.add(layer1BotUserId);

  // Linear team→repo map. Layer 1 only — team-shared, committed. CTL-362.
  const linearTeams = projectExtract?.linearTeams ?? [];

  // Linear app-actor credentials. Project-specific Layer-2 only. CTL-550.
  const linearAgentConfig = loadLinearAgentConfig(homeConfigDir, projectKey);

  // Allow Linear-only configurations: if the GitHub channel/secret are missing
  // but Linear secrets are present, return a config that disables the GitHub
  // route but enables the Linear route. CTL-210.
  if (finalChannel.length === 0 || secret.length === 0) {
    if (linearSecrets.length === 0 && linearSmeeChannel.length === 0) return null;
    return {
      smeeChannel: "",
      secret: "",
      secretEnvName: webhookSecretEnv,
      watchRepos,
      linearSecrets,
      linearSmeeChannel,
      linearBotUserIds,
      linearTeams,
      linearAgentConfig,
    };
  }

  return {
    smeeChannel: finalChannel,
    secret,
    secretEnvName: webhookSecretEnv,
    watchRepos,
    linearSecrets,
    linearSmeeChannel,
    linearBotUserIds,
    linearTeams,
    linearAgentConfig,
  };
}
