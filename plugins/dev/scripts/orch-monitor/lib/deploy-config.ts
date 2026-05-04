import { readFileSync } from "fs";

export interface DeployConfig {
  /** Hard timeout for the deploy state-machine, in seconds. After this elapses
   *  with no `deployment_status` resolution, the orchestrator escalates and
   *  flips the worker to `status: "stalled"`. */
  timeoutSec: number;
  /** GitHub deployment environment that gates `status: "done"`. */
  productionEnvironment: string;
  /** Optional staging environment shown in the dashboard but not gating. */
  stagingEnvironment: string;
  /** When true, the orchestrator shortcuts MERGED → done immediately (today's
   *  behavior). When false, MERGED → merged → deploying → done | deploy-failed. */
  skipDeployVerification: boolean;
}

export const DEPLOY_DEFAULTS: DeployConfig = Object.freeze({
  timeoutSec: 1800,
  productionEnvironment: "production",
  stagingEnvironment: "staging",
  // Default-true: most repos don't emit GitHub Deployments, so the safe default
  // preserves today's (CTL-133) behavior. Repos that DO emit them (e.g.
  // Vercel/Heroku/Cloudflare-Pages-integrated repos) opt in by setting this
  // false in the per-repo config.
  skipDeployVerification: true,
});

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readPerRepoSection(
  configPath: string,
  repoSlug: string,
): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
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
  const deploy = parsed.catalyst.deploy;
  if (!isRecord(deploy)) return null;
  const repoEntry = deploy[repoSlug];
  return isRecord(repoEntry) ? repoEntry : null;
}

function pickPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

function pickNonEmptyString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Load deploy verification config for a given repo from `.catalyst/config.json`.
 * Returns `DEPLOY_DEFAULTS` when no per-repo entry exists or the file is missing /
 * malformed. Repo lookup is exact-match (`owner/repo` case-sensitive).
 *
 * Schema:
 *   {
 *     "catalyst": {
 *       "deploy": {
 *         "<owner>/<repo>": {
 *           "timeoutSec": 1800,
 *           "productionEnvironment": "production",
 *           "stagingEnvironment": "staging",
 *           "skipDeployVerification": false
 *         }
 *       }
 *     }
 *   }
 */
export function loadDeployConfig(
  repoSlug: string,
  configPath: string,
): DeployConfig {
  const section = readPerRepoSection(configPath, repoSlug);
  if (section === null) return { ...DEPLOY_DEFAULTS };

  return {
    timeoutSec: pickPositiveInt(section.timeoutSec, DEPLOY_DEFAULTS.timeoutSec),
    productionEnvironment: pickNonEmptyString(
      section.productionEnvironment,
      DEPLOY_DEFAULTS.productionEnvironment,
    ),
    stagingEnvironment: pickNonEmptyString(
      section.stagingEnvironment,
      DEPLOY_DEFAULTS.stagingEnvironment,
    ),
    skipDeployVerification: pickBool(
      section.skipDeployVerification,
      DEPLOY_DEFAULTS.skipDeployVerification,
    ),
  };
}
