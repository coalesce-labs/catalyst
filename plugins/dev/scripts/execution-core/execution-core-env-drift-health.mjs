// execution-core-env-drift-health.mjs — CTL-2042, the `catalyst doctor` drift check.
//
// Reports on-disk-vs-repo drift for execution-core.env, naming differing VARIABLE
// NAMES only — NEVER values. `CATALYST_WORKFLOW_GITHUB_TOKEN` may appear in these
// files and must never reach any log line, doctor output, or event.
//
// ── ADVISORY — never FAIL ──
// doctor's FAIL count gates worker activation. A drift is a posture mismatch, not
// a reason to take a host out of service. Same rationale as checkLinearWriteBudget
// and checkRegistryTeamIdentity.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { STATUS, mkCheck } from "./doctor-status.mjs";
import { getClusterRepoDir, getHostName, getLayer2ConfigPath, log } from "./config.mjs";

function defaultConfigDir() {
  return dirname(getLayer2ConfigPath());
}

export const VERDICT = Object.freeze({
  ABSENT: "absent",
  MATCHES: "matches",
  DRIFTED: "drifted",
  INCONCLUSIVE: "inconclusive",
});

/**
 * parseEnvAssignments — pure. Parses `export VAR=value` and `VAR=value` lines.
 * Returns a Map<name, rawValue>. Lines that don't match are silently skipped.
 *
 * ⛔ NEVER expose the returned values in any user-facing string. The Map is
 * internal — only its keys (variable names) may appear in output.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvAssignments(text) {
  const map = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (!m) continue;
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * diffVarNames — pure. Returns which variable NAMES differ between two parsed maps.
 * ⛔ Result is three arrays of NAMES only — values are never surfaced.
 *
 * @param {Map<string, string>} diskMap
 * @param {Map<string, string>} repoMap
 * @returns {{ onlyOnDisk: string[], onlyInRepo: string[], valueDiffers: string[] }}
 */
export function diffVarNames(diskMap, repoMap) {
  const onlyOnDisk = [];
  const onlyInRepo = [];
  const valueDiffers = [];

  for (const [name, val] of diskMap) {
    if (!repoMap.has(name)) {
      onlyOnDisk.push(name);
    } else if (repoMap.get(name) !== val) {
      valueDiffers.push(name);
    }
  }
  for (const name of repoMap.keys()) {
    if (!diskMap.has(name)) onlyInRepo.push(name);
  }

  return { onlyOnDisk, onlyInRepo, valueDiffers };
}

/**
 * classifyExecutionCoreEnvDrift — pure classifier.
 * ⛔ Every unknown → INCONCLUSIVE, never a match. Same discipline as
 * classifyAgentToolCopy: "could not look" and "nothing there" must not share
 * an outcome.
 *
 * @param {object} o
 * @param {string|null} o.diskContent   file text when readable; null when ENOENT
 * @param {{ code: string }|null} o.diskError   non-null for non-ENOENT read errors
 * @param {string|null} o.repoContent   same for the cluster-repo copy
 * @param {{ code: string }|null} o.repoError
 * @param {boolean} [o.clusterAvailable=true]   POSITIVE CONTROL: did we actually
 *   inspect the cluster source? A missing/mis-mounted clone, or one lacking its
 *   `hosts/` tree, produces the SAME `repoContent === null` as a deliberately absent
 *   per-host posture. Without this flag both collapse to ABSENT ("nothing to drift
 *   from") — a false clean when the source could not be inspected (Codex P2). When
 *   false, a null repo is INCONCLUSIVE, never ABSENT.
 * @returns {{ verdict: string, onlyOnDisk?: string[], onlyInRepo?: string[], valueDiffers?: string[], reason?: string }}
 */
export function classifyExecutionCoreEnvDrift({
  diskContent,
  diskError,
  repoContent,
  repoError,
  clusterAvailable = true,
}) {
  // A non-ENOENT read failure on either side → INCONCLUSIVE.
  // "I could not look" is not evidence of no drift.
  if (diskError) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: `disk: ${diskError.code}` };
  }
  if (repoError) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: `repo: ${repoError.code}` };
  }

  // Repo absent, but the source was NEVER INSPECTABLE (no clone / wrong path / no
  // hosts/ tree) → INCONCLUSIVE, not ABSENT. A null repoContent here means "could
  // not look", which must not read as "nothing to drift from" (Codex P2).
  if (repoContent === null && clusterAvailable === false) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      reason: "cluster posture unavailable (clone missing, wrong path, or no hosts/ tree)",
    };
  }

  // Repo absent AND the source WAS inspectable → this host genuinely has no committed
  // posture; nothing to drift from.
  if (repoContent === null) {
    return { verdict: VERDICT.ABSENT, onlyOnDisk: [], onlyInRepo: [], valueDiffers: [] };
  }

  // Disk absent but repo present → materialization hasn't run yet.
  if (diskContent === null) {
    const repoMap = parseEnvAssignments(repoContent);
    return {
      verdict: VERDICT.DRIFTED,
      onlyOnDisk: [],
      onlyInRepo: [...repoMap.keys()],
      valueDiffers: [],
    };
  }

  // Both present — compare var names. Values stay internal.
  const diskMap = parseEnvAssignments(diskContent);
  const repoMap = parseEnvAssignments(repoContent);
  const diff = diffVarNames(diskMap, repoMap);

  const hasDrift =
    diff.onlyOnDisk.length > 0 || diff.onlyInRepo.length > 0 || diff.valueDiffers.length > 0;

  if (hasDrift) {
    return { verdict: VERDICT.DRIFTED, ...diff };
  }
  return { verdict: VERDICT.MATCHES, onlyOnDisk: [], onlyInRepo: [], valueDiffers: [] };
}

/**
 * checkExecutionCoreEnvDrift — the doctor row.
 *
 * Compares ~/.config/catalyst/execution-core.env (on-disk) against
 * <clusterDir>/hosts/<hostName>/execution-core.env (committed repo copy).
 * Reports drift as WARN, naming variable names only — NEVER values.
 */
export function checkExecutionCoreEnvDrift(deps = {}) {
  const {
    env = process.env,
    configDir = defaultConfigDir(),
    clusterDir = getClusterRepoDir(),
    hostName = getHostName(),
    readFile = readFileSync,
    exists = existsSync,
    // eslint-disable-next-line no-unused-vars
    logger = log,
  } = deps;

  // CTL-2042 (Codex P2): inspect the SAME on-disk file the daemon launcher sources —
  // the CATALYST_EXECUTION_CORE_ENV override when set, else <configDir>/execution-core.env.
  // Checking the Layer-2-adjacent default when the launcher sources elsewhere would
  // report drift against a file the daemon never reads.
  const diskPath =
    typeof env?.CATALYST_EXECUTION_CORE_ENV === "string" && env.CATALYST_EXECUTION_CORE_ENV.length > 0
      ? resolve(env.CATALYST_EXECUTION_CORE_ENV)
      : resolve(configDir, "execution-core.env");
  const repoPath = resolve(clusterDir, "hosts", String(hostName), "execution-core.env");

  // POSITIVE CONTROL (Codex P2): could we actually inspect the cluster source? A
  // missing/mis-mounted clone or one without a `hosts/` tree yields the same null
  // repoContent as a genuinely absent per-host posture; distinguish them so an
  // un-inspectable source reports INCONCLUSIVE, not a false-clean ABSENT.
  const clusterAvailable = exists(clusterDir) && exists(resolve(clusterDir, "hosts"));

  let diskContent = null;
  let diskError = null;
  try {
    diskContent = readFile(diskPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") diskError = { code: err?.code ?? "unknown" };
  }

  let repoContent = null;
  let repoError = null;
  try {
    repoContent = readFile(repoPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") repoError = { code: err?.code ?? "unknown" };
  }

  const r = classifyExecutionCoreEnvDrift({
    diskContent,
    diskError,
    repoContent,
    repoError,
    clusterAvailable,
  });

  if (r.verdict === VERDICT.ABSENT) {
    return mkCheck(
      "execution-core-env-drift",
      STATUS.PASS,
      `execution-core.env: no posture file committed for host ${String(hostName)} in the cluster repo — nothing to drift from`,
    );
  }

  if (r.verdict === VERDICT.INCONCLUSIVE) {
    return mkCheck(
      "execution-core-env-drift",
      STATUS.WARN,
      `execution-core.env: INCONCLUSIVE — could not read (${r.reason}); this is not the same as no drift`,
    );
  }

  if (r.verdict === VERDICT.MATCHES) {
    return mkCheck(
      "execution-core-env-drift",
      STATUS.PASS,
      `execution-core.env: on-disk at ${diskPath} matches the committed cluster repo posture`,
    );
  }

  // DRIFTED — name the variable categories; never name values.
  const parts = [];
  if (r.onlyOnDisk?.length) parts.push(`only on disk: ${r.onlyOnDisk.join(", ")}`);
  if (r.onlyInRepo?.length) parts.push(`only in repo: ${r.onlyInRepo.join(", ")}`);
  if (r.valueDiffers?.length) parts.push(`value differs: ${r.valueDiffers.join(", ")}`);
  const nameSummary = parts.length ? parts.join("; ") : "content differs";

  return mkCheck(
    "execution-core-env-drift",
    STATUS.WARN,
    `execution-core.env DRIFT detected for host ${String(hostName)}. Variable names: ${nameSummary}. ` +
      `Run \`catalyst cluster sync\` or wait for the refresh timer to materialize the committed posture. ` +
      `Disk: ${diskPath}. Repo: ${repoPath}. Values are never shown.`,
  );
}
