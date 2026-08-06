// Types for secret-contract.mjs (CTL-1616) — the runtime stays .mjs so the
// broker/execution-core .mjs daemons (and doctor.mjs's bare-Node import) import it
// unchanged; this gives TS consumers (orch-monitor) proper types. Mirrors the
// deployment-mode.d.mts convention (hand-written companion, no build step).

export type SecretDelivery =
  | "bare-file"
  | "bare-file-family"
  | "env-file"
  | "env-alias"
  | "config-json"
  | "platform-env"
  | "local-only";

export type RotationClass = "boot-only" | "re-armable" | "n/a";
export type RotationTrigger = "timer" | "on-401";

export interface SecretRotation {
  class: RotationClass;
  /** present only when class === "re-armable" */
  trigger?: RotationTrigger;
}

/** CTL-1616 PR4: a single legacy config-json fallback tier (linear-worker-actor only). */
export interface LegacyConfigTier {
  scope: "per-team-legacy" | "global-legacy";
  configJsonPath: string;
}

export interface SecretRow {
  id: string;
  envNames: readonly string[];
  delivery: SecretDelivery;
  configJsonPath: string | null;
  rotation: SecretRotation;
  /** the deployment mode this row bootstraps ("cluster" | "cloud"), or null */
  bootstrapFor: "cluster" | "cloud" | null;
  /** present only on the linear-webhook-secret family row */
  familyPrefix?: string;
  /** present only on the age-key local-only row, relative to HOME */
  defaultLocalPath?: readonly string[];
  /**
   * CTL-1616 PR4 (linear-worker-actor only): an env-var pair checked BEFORE configJsonPath —
   * folds linear-comment-post.sh's CATALYST_LINEAR_AGENT_CLIENT_ID/_SECRET precedence tier.
   */
  credentialEnvPair?: { clientId: string; clientSecret: string };
  /**
   * CTL-1616 PR4 (linear-worker-actor only): additional config-json tiers tried, in order,
   * only once configJsonPath itself misses — folds linear-comment-post.sh's two legacy
   * catalyst.linear.agent tiers verbatim.
   */
  legacyConfigTiers?: readonly LegacyConfigTier[];
}

export const SECRET_DELIVERY: readonly SecretDelivery[];
export const ROTATION_CLASSES: readonly RotationClass[];
export const ROTATION_TRIGGERS: readonly RotationTrigger[];
export const SECRET_REGISTRY: readonly SecretRow[];

export function getSecretRow(id: string): SecretRow | undefined;
export function isSecretFamilyMember(filename: string): boolean;
export function resolveLayer2Path(env?: Record<string, string | undefined>): string;
export function explicitFileOverrideEnvName(id: string): string;
export function secretFileCandidates(id: string, env?: Record<string, string | undefined>): string[];
/** Canonical malformed-file validators (CTL-1623 Codex round 2): shared with
 *  execution-core's rearmGithubTokenFromFile so the resolver and the rearm hook can never
 *  drift on what counts as a representable credential file. */
export function containsNul(value: string): boolean;
export function isValidUtf8RoundTrip(buf: Uint8Array, decoded: string): boolean;
/** CTL-1616 PR4: linear-worker-actor's per-team-legacy tier path (mirrors
 *  linear-comment-post.sh's _find_layer2_config directory walk-up). */
export function resolveLegacyPerTeamConfigPath(
  env?: Record<string, string | undefined>,
  cwd?: string,
): string;

/** The subset of CTL-1617's resolveDeploymentMode() output this engine consumes. */
export interface DeploymentModeInput {
  mode: "single-host" | "cluster" | "cloud";
  inferred: boolean;
  source?: string;
  recognized?: boolean;
}

export interface ResolveSecretOptions {
  env?: Record<string, string | undefined>;
  deploymentMode?: DeploymentModeInput;
  /** CTL-1616 PR4: cwd the per-team-legacy tier's directory walk starts from (linear-worker-actor only). Defaults to process.cwd(). */
  cwd?: string;
}

export interface ResolvedSecret {
  value: string | null;
  source: string | null;
  provider: SecretDelivery | null;
  rotation: SecretRotation | null;
  [extra: string]: unknown;
}

export function resolveSecret(id: string, opts?: ResolveSecretOptions): ResolvedSecret;

/** CTL-1616 PR5: NAME-ONLY resolution of the cloud-token row's env-var NAME (env override →
 *  Layer-2 catalyst.cloud.tokenEnv → default). Never reads the secret VALUE — safe to log.
 *  execution-core/config.mjs's resolveNodeCloudTokenEnv delegates to this. */
export interface ResolvedCloudTokenName {
  envVar: string;
  source: "env" | "layer2" | "default";
}
export function resolveCloudTokenName(env?: Record<string, string | undefined>): ResolvedCloudTokenName;

export interface RearmHookResult {
  rearmed: boolean;
  reason?: string;
}
export type RearmHook = (opts: { env: Record<string, string | undefined> }) => RearmHookResult;

export function registerRearmHook(id: string, fn: RearmHook): boolean;
export function clearRearmHook(id: string): boolean;
export function resetArmState(id?: string): void;

export interface ArmSecretOptions {
  env?: Record<string, string | undefined>;
}

export interface ArmedSecret {
  armed: boolean;
  rotated: boolean;
  restartRequired: boolean;
}

export function armSecret(id: string, opts?: ArmSecretOptions): ArmedSecret;
