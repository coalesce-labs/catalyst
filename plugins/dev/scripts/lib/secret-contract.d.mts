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
}

export interface ResolvedSecret {
  value: string | null;
  source: string | null;
  provider: SecretDelivery | null;
  rotation: SecretRotation | null;
  [extra: string]: unknown;
}

export function resolveSecret(id: string, opts?: ResolveSecretOptions): ResolvedSecret;

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
