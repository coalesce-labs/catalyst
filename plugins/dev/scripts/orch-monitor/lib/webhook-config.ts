import { readFileSync } from "fs";
import { join } from "path";

export interface WebhookCliConfig {
  smeeChannel: string;
  secret: string;
  /**
   * Repos to subscribe to at startup, regardless of whether a worker has been
   * observed for them. Layer 1 only (team-wide). Empty array means
   * auto-discovery is the only subscription path. CTL-216.
   */
  watchRepos: string[];
}

interface FileExtract {
  smeeChannel: string | null;
  webhookSecretEnv: string | null;
  watchRepos: string[];
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
        `[webhook-config] Ignoring watchRepos entry "${trimmed}" — expected "owner/repo".`,
      );
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
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
  const github = monitor.github;
  if (!isRecord(github)) return null;

  const smeeChannel =
    typeof github.smeeChannel === "string" && github.smeeChannel.length > 0
      ? github.smeeChannel
      : null;
  const webhookSecretEnv =
    typeof github.webhookSecretEnv === "string" &&
    github.webhookSecretEnv.length > 0
      ? github.webhookSecretEnv
      : null;
  const watchRepos = readWatchRepos(github);

  return { smeeChannel, webhookSecretEnv, watchRepos };
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
): WebhookCliConfig | null {
  const projectExtract = readGithubSection(projectConfigPath);
  const homeExtract = readGithubSection(join(homeConfigDir, "config.json"));

  const homeChannel = homeExtract?.smeeChannel ?? null;
  const projectChannel = projectExtract?.smeeChannel ?? null;
  const webhookSecretEnv =
    projectExtract?.webhookSecretEnv ?? "CATALYST_WEBHOOK_SECRET";

  if (projectChannel !== null && !warnedDeprecatedSmeeChannel) {
    warnedDeprecatedSmeeChannel = true;
    console.warn(
      "[webhook-config] Deprecated: catalyst.monitor.github.smeeChannel found in " +
        ".catalyst/config.json. The smee URL is per-machine — move it to " +
        "~/.config/catalyst/config.json. Run `setup-webhooks.sh --force` to " +
        "migrate. Layer 1 reads will be removed in a future release.",
    );
  }

  const fileChannel = homeChannel ?? projectChannel;
  const channelOverride = process.env.CATALYST_SMEE_CHANNEL;
  const finalChannel =
    channelOverride && channelOverride.length > 0
      ? channelOverride
      : (fileChannel ?? "");

  const secret =
    process.env[webhookSecretEnv] ?? process.env.CATALYST_SMEE_SECRET ?? "";

  // watchRepos is Layer 1 only — a team-default field. Reading from Layer 2
  // would let one developer's machine override the team list, which is the
  // opposite of what we want. CTL-216.
  const watchRepos = projectExtract?.watchRepos ?? [];

  if (finalChannel.length === 0 || secret.length === 0) return null;
  return { smeeChannel: finalChannel, secret, watchRepos };
}
