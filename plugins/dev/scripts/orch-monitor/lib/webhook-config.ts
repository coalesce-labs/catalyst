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
   * Linear webhook signing secrets (CTL-273). Array of {key, secret} pairs,
   * where key is "workspace" or a team UUID, and secret is the HMAC signing secret.
   * Resolved from `catalyst.monitor.linear.webhookSecretEnv` env-var name in
   * Layer 1, with fallback to `CATALYST_LINEAR_WEBHOOK_SECRET`. Empty array
   * when no Linear config is present — the server then disables
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
   * Linear user UUID for the catalyst bot. Issue events where the actor matches
   * this ID are suppressed before reaching the event log (loop prevention). CTL-263.
   * Read from `catalyst.monitor.linear.botUserId` in Layer 1 (project config).
   * Empty string when not configured — no suppression.
   */
  linearBotUserId: string;
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
  linearBotUserId: string | null;
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
// Arguments:
//   linear: the catalyst.monitor.linear object/dict from Layer 2
//   linearWebhookSecretEnv: env-var name from Layer 1 (optional)
//
// Returns: array of {key, secret} pairs
function readAllLinearSecrets(
  linear: unknown,
  linearWebhookSecretEnv: string | null,
): Array<{ key: string; secret: string }> {
  if (!isRecord(linear)) return [];
  const out: Array<{ key: string; secret: string }> = [];

  // Check if this is the old single-object format
  const isSingleObject =
    typeof linear.webhookId === "string" &&
    linear.webhookId.length > 0;

  if (isSingleObject) {
    // Legacy single-object format — treat as "workspace" key
    const secret =
      (linearWebhookSecretEnv !== null
        ? process.env[linearWebhookSecretEnv]
        : undefined) ??
      process.env.CATALYST_LINEAR_WEBHOOK_SECRET ??
      "";
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

    // For now, all webhooks use the same secret env-var from Layer 1.
    // In the future, per-team secrets could be stored in Layer 1.
    const secret =
      (linearWebhookSecretEnv !== null
        ? process.env[linearWebhookSecretEnv]
        : undefined) ??
      process.env.CATALYST_LINEAR_WEBHOOK_SECRET ??
      "";
    if (secret.length > 0) {
      out.push({ key, secret });
    }
  }

  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
  const linearSmeeChannel =
    linear !== null && typeof linear.smeeChannel === "string" && linear.smeeChannel.length > 0
      ? linear.smeeChannel
      : null;
  const linearBotUserId =
    linear !== null && typeof linear.botUserId === "string" && linear.botUserId.length > 0
      ? linear.botUserId
      : null;

  return {
    smeeChannel,
    webhookSecretEnv,
    watchRepos,
    linearWebhookSecretEnv,
    linearSmeeChannel,
    linearBotUserId,
  };
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
  projectConfigPath: string
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const homeConfigParsed = JSON.parse(homeConfigRaw) as unknown;
    if (isRecord(homeConfigParsed) && isRecord(homeConfigParsed.catalyst)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const monitor = homeConfigParsed.catalyst.monitor;
      if (isRecord(monitor)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        homeLinearConfig = monitor.linear;
      }
    }
  } catch {
    homeLinearConfig = undefined;
  }
  const linearSecrets = readAllLinearSecrets(
    homeLinearConfig ?? undefined,
    linearWebhookSecretEnv,
  );

  // Linear smee channel. Layer 2 only (per-machine) — same split as GitHub
  // smeeChannel. Env override wins. CTL-242.
  const fileLinearSmeeChannel = homeExtract?.linearSmeeChannel ?? null;
  const linearSmeeChannelOverride = process.env.CATALYST_LINEAR_SMEE_CHANNEL;
  const linearSmeeChannel =
    linearSmeeChannelOverride && linearSmeeChannelOverride.length > 0
      ? linearSmeeChannelOverride
      : (fileLinearSmeeChannel ?? "");

  // Linear bot user UUID for loop prevention. Layer 1 only (project/team setting). CTL-263.
  const linearBotUserId = projectExtract?.linearBotUserId ?? "";

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
      linearBotUserId,
    };
  }

  return {
    smeeChannel: finalChannel,
    secret,
    secretEnvName: webhookSecretEnv,
    watchRepos,
    linearSecrets,
    linearSmeeChannel,
    linearBotUserId,
  };
}
