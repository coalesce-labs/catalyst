// doctor.mjs — catalyst doctor: fail-closed activation gate for new cluster nodes (CTL-1186).
//
// Runs a suite of read-only checks that a node MUST pass before its role is safe.
// Each check is injectable for unit testing; production defaults wire to the real
// system calls.
//
// CTL-1355: the suite is CLASS-AWARE. `runDoctor` resolves catalyst.node.class
// (resolveNodeClass) once and grades the node against its class-specific rubric:
//   • worker    — the full CTL-1186 activation gate (would-own-work + Linear/bot
//                 reachable + roster membership + daemon PATH + member provisioning).
//                 An UNSET class infers `worker` (today's behavior, zero change).
//   • developer — services healthy + plugins fresh + read-replica REACHABLE + the
//                 node will NOT pick up work (out of roster / boot-drained). Reuses
//                 the daemonless + plugins-fresh rows from `catalyst-stack
//                 verify-node --json`; computes would-not-own-work + read-replica
//                 reachability natively.
//   • monitor   — minimal/stub (no monitor host exists yet); reachability + must-not-
//                 own-work + a fail-closed profile-stub FAIL (doctor refuses to
//                 certify a monitor node until the monitor rubric lands).
// An EXPLICIT but unrecognized class (a typo'd "developr") is a single hard FAIL.
//
// Usage:
//   node doctor.mjs [--json] [--dry-run] [--expected-bot-user-id <id>]
//
// Exit code: number of FAIL-level checks (0 = all clear).

import { readFileSync, statSync, existsSync, lstatSync, realpathSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
// CTL-1918: install-completeness lives in its own module. doctor.mjs is NOT
// prettier-formatted on main (verified against a pristine checkout), so any edit here
// drags a ~1,100-line reformat into the diff — extracting keeps this change reviewable.
import { STATUS, mkCheck } from "./doctor-status.mjs";
import { checkInstallCompleteness } from "./install-completeness.mjs";
// CTL-1936 AC5: the standing answer to "is this host write-exhausted".
import { checkHostWriteCredentialClass } from "./host-credential-health.mjs";
import { checkLinearWriteBudget } from "./write-budget-health.mjs";
import { checkAgentToolsWritePath } from "./agent-tools-write-path-health.mjs";
import { checkExecutionCoreEnvDrift } from "./execution-core-env-drift-health.mjs";
import { checkIndexServingRoot } from "./index-serving-root-health.mjs";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

// CTL-1929: the GitHub-feed mode + the consumed/suppressible name lists, from two
// zero-import leaves. ⛔ `github-feed-gate.mjs` — where the name lists used to live
// — reaches `bun:sqlite` and this file runs under BARE NODE, so importing it here
// fails at load (measured: config.mjs LOADS under bare node, github-feed-gate.mjs
// REJECTS). The alternative was a hand-maintained copy here, which would keep
// reporting three uncovered names after CTC-691/CTC-667/CTC-704 close.
import { resolveGithubFeedMode } from "../lib/github-feed-mode.mjs";
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
  resolveGithubFeedAccount, // CTL-2030: hoisted here so bare-node doctor shares the producer's answer
} from "../lib/github-feed-names.mjs";
// CTL-2030: the producer's readiness heartbeat. `github-feed-ready.mjs` imports only
// node:fs + node:path, so it loads under bare node (unlike github-feed-gate.mjs).
import { defaultReadyPath, readReadyState } from "./github-feed-ready.mjs";
import {
  getHostName,
  // CTL-1785: doctor's roster reads are diagnostic/audit over the physical
  // EXISTENCE roster (all members need worker labels, the HRW-partition dry-run
  // shows the full topology). Entitlement is reported separately by
  // checkEntitlementConsistency. `off` mode: getExistenceHosts() === getClusterHosts().
  getExistenceHosts,
  resolveClusterHosts,
  hostMembershipWarning,
  getLivenessAnchorIssue,
  getExecutor, // CTL-1367 item 9: resolve the phase-worker executor for the sdk-auth gate
  // CTL-1355: class-aware grading — resolveNodeClass selects the rubric, isDraining
  // + getExecutionCoreDir drive the developer/monitor "will NOT pick up work" gate.
  resolveNodeClass,
  NODE_CLASSES,
  isDraining,
  resolveDrainState, // CTL-1678: three-state drain resolver for checkDrainDisabled
  readDaemonRuntimeEnv, // CTL-1678 (round-3 P1): live daemon's boot-time env snapshot
  getExecutionCoreDir,
  // CTL-1375: configured-repo discovery for the repo-icon token-scope advisory.
  getRegistryPath,
  readClusterConfig,
  // CTL-1396 item A: unified event-log path for the recent sdk→bg silent-degrade scan.
  getEventLogPath,
  // CTL-1394: the supervised cloud-sync health check. All node-safe (node:fs/os/path) —
  // do NOT import replica-read.mjs (it pulls bun:sqlite; doctor runs under bare node).
  getReplicaDbPath,
  readLinearReplica,
  // CTL-2074 (Codex #3738 P2): resolve the write-proxy mode through the SAME
  // env > Layer-2 > 'off' ladder the live write transport uses, so a host that enables
  // enforce via Layer-2 (catalyst.linearWriteProxy.mode) without exporting the env var is
  // not silently skipped by the self-echo cross-check. Node-safe (node:fs only).
  readLinearWriteProxyConfig,
  resolveNodeCloudTokenEnv,
  // CTL-1659: the cloud-sync loaded-dependency boot record — doctor grades it from
  // another process, so it needs the same path the writer writes.
  getCloudSyncDepsPath,
  // CTL-1393: cluster-secret freshness check — clone dir + the durable
  // change-detection marker the daemon's auto-refresh writes.
  getClusterRepoDir,
  getClusterSyncStatePath,
  // CTL-1617: the one declared deployment-mode answer (single-host/cluster/
  // cloud), re-exported from the zero-import lib leaf so doctor never grows
  // a second copy of the resolution ladder.
  DEPLOYMENT_MODES,
  resolveDeploymentMode,
  // CTL-1785: entitlement mode resolver, re-exported from the zero-import leaf
  // (same pattern as deployment-mode above) — doctor grades it advisory-only.
  resolveEntitlementMode,
} from "./config.mjs";
// CTL-1785: the TTL constants + enum, imported DIRECTLY from the zero-import leaf
// (node built-ins only — safe under doctor's bare-Node runtime), same pattern as
// secret-contract.mjs below, not re-exported through config.mjs.
import {
  ENTITLEMENT_MODES,
  ENTITLEMENT_TTL_MS,
  WORK_LEASE_TTL_MS,
  // CTL-1785 (code review, chatgpt-codex-connector P2): a malformed JSON config
  // can supply a non-string mode like {"toString": null} as m.raw — interpolating
  // that directly throws TypeError instead of producing the advisory WARN. Reuse
  // the same never-throws renderer getEntitlementMode() already uses for this.
  printableRaw,
} from "../lib/entitlement.mjs";
import { scanEventsSince } from "./event-tail.mjs"; // CTL-1529: bounded event-log scan
// CTL-1659: the loaded-dependency skew comparator. A zero-import leaf (node:crypto/fs/path
// only), like lib/secret-contract.mjs — safe under doctor's bare-Node runtime.
import { evaluateDepSkew, readDepsBreadcrumb } from "./cloud-sync-deps.mjs";
import { ownedBy } from "./hrw.mjs";
import { readPeerHeartbeats } from "./cluster-heartbeat.mjs";
// CTL-1616 PR2: the shared secret-contract engine, imported DIRECTLY from the
// zero-import lib leaf (node:fs/os/path only) — same pattern cluster-sync.mjs
// already uses (`../lib/secret-contract.mjs`), NOT re-exported through
// config.mjs, so doctor stays safe under bare Node. SHADOW ONLY in this PR: the
// contract is consulted and compared, never used to decide a grade (see
// checkSecretContract + buildContractShadowCheck below).
import { resolveSecret, resolveLayer2Path } from "../lib/secret-contract.mjs";
// CTL-1481: the canonical worker-ownership label names — imported (not
// re-hardcoded) so the doctor can never drift from what the stamper writes.
// From the zero-import names leaf, NOT worker-label.mjs: doctor runs under
// bare Node, and worker-label.mjs's graph reaches gateway-read.mjs →
// bun:sqlite, which fails Node's ESM loader at import time.
import { WORKER_LABEL_GROUP, WORKER_LABEL_PREFIX } from "./worker-label-names.mjs";
// CTL-1367 item 9: reuse the single-source-of-truth subscription-auth predicate
// (sdk-run-phase-agent.mjs imports only node:* + config.mjs — no bun: protocol —
// so it is safe to pull into this node-runnable doctor).
import { assertSdkAuth } from "./sdk-run-phase-agent.mjs";
// CTL-1214: reuse the single-source-of-truth Layer-1 scope-leak validator
// (pure, no-I/O) shared with the Phase-1 config-schema tests. Lives in
// plugins/dev/scripts/lib/ (sibling of execution-core/).
import { validateLayer1Config, RELOCATED_LAYER1_KEYS } from "../lib/validate-catalyst-config.mjs";
import { resolvePluginCheckoutRoots } from "../broker/plugin-refresh.mjs"; // CTL-1421: same resolver the workers use

// CTL-1931: doctor.mjs lives at <repo>/plugins/dev/scripts/execution-core/, so the repo's
// `.catalyst/config.json` is four levels up — the same module-relative derivation
// broker/router.mjs uses for its own `__REPO_CONFIG_PATH`. Exported so a test can assert
// the production default actually supplies this rung rather than passing null.
export const DOCTOR_REPO_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".catalyst",
  "config.json"
);
import { shipsLogs, LABELS as MANIFEST_LABELS } from "./service-manifest.mjs"; // CTL-1473: per-class service manifest
import { staleLockStatus, indexLockPath, STALE_LOCK_THRESHOLD_MS } from "../lib/stale-lock.mjs"; // CTL-1415
import { listProjects } from "./registry.mjs";
// CTL-1793: the per-key config-provenance view. Node-safe by construction — its
// only non-node: import is config.mjs, which doctor already imports above; there
// is no bun: protocol anywhere in its graph (asserted in config-dump.test.mjs).
// Read-only and advisory: nothing in this module can change a grade to FAIL.
import { collectConfigDump } from "./config-dump.mjs";

// readLinearBotUserIds — inlined from daemon.mjs to avoid pulling in the full
// daemon dependency chain (which includes bun: protocol imports incompatible
// with node). Logic is identical; deps are already imported above.
//
// Collects all known Linear bot user UUIDs from both config layers:
//   1. ~/.config/catalyst/config.json  catalyst.linear.bot.worker.botUserId
//   2. ~/.config/catalyst/config.json  catalyst.linear.bot.orchestrator.botUserId
//   3. ~/.config/catalyst/config.json  catalyst.linear.bot.cloud.botUserId (CTL-2074,
//        recognition-only — the cloud-proxy app-actor; kept in lockstep with the daemon)
//   4. .catalyst/config.json           catalyst.monitor.linear.botUserId (Layer-1, back-compat)
// Returns a Set<string>. Empty set = no filter (fail-open). Never throws.
// Exported so doctor.test.mjs exercises the inline twin directly and it cannot
// silently drift from the daemon resolver (CTL-2074).
export function readLinearBotUserIds(l1Path, l2Path) {
  const ids = new Set();
  function addFromPath(path, extractor) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      extractor(parsed, ids);
    } catch { /* ignore unreadable / malformed files */ }
  }
  addFromPath(l2Path, (p, s) => {
    const bot = p?.catalyst?.linear?.bot;
    if (typeof bot?.worker?.botUserId === "string" && bot.worker.botUserId.length > 0)
      s.add(bot.worker.botUserId);
    if (typeof bot?.orchestrator?.botUserId === "string" && bot.orchestrator.botUserId.length > 0)
      s.add(bot.orchestrator.botUserId);
    // CTL-2074: cloud-proxy app-actor — recognition-only (never a self-assign id).
    if (typeof bot?.cloud?.botUserId === "string" && bot.cloud.botUserId.length > 0)
      s.add(bot.cloud.botUserId);
  });
  addFromPath(l1Path, (p, s) => {
    const uid = p?.catalyst?.monitor?.linear?.botUserId;
    if (typeof uid === "string" && uid.length > 0) s.add(uid);
  });
  return ids;
}

// CTL-2074 (Codex #3738 P2): the CURRENT cloud-proxy app-actor id, read on its own
// from Layer-2 catalyst.linear.bot.cloud.botUserId. The self-echo cross-check ties its
// PASS to THIS specific actor rather than to any member of the full recognition set:
// under proxy=enforce every daemon state write carries the cloud tenant's app-actor id,
// so a legacy worker/orchestrator id that changed state before the cutover — and is still
// in the general set — must NOT mask an unrecognized current cloud writer with a clean
// PASS. Returns "" when unconfigured/unreadable (never throws) — that IS the CTL-2074
// silent condition, surfaced as WARN by the caller, not a clean pass.
export function readCloudBotUserId(l2Path) {
  if (!l2Path) return "";
  try {
    const id = JSON.parse(readFileSync(l2Path, "utf8"))?.catalyst?.linear?.bot?.cloud?.botUserId;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

// ─── Check model ─────────────────────────────────────────────────────────────

// CTL-1918: STATUS/mkCheck moved to the zero-import leaf doctor-status.mjs so a check
// can live in its own module without importing this one (which would be circular).
// Re-exported here, so every existing `import { STATUS, mkCheck } from "./doctor.mjs"`
// keeps working unchanged.
export { STATUS, mkCheck } from "./doctor-status.mjs";

export { checkInstallCompleteness };

export { checkHostWriteCredentialClass };
export { checkLinearWriteBudget };
export { checkAgentToolsWritePath };
export { checkExecutionCoreEnvDrift };
export { checkIndexServingRoot };

// ─── CTL-1616 PR2/PR3: secret-contract observability (zero grade change) ─────
//
// safeResolveSecretContract — B1: every remaining shadow call site below
// (checkWebhookIngestion's webhook-secret leg, checkCloudTokenEnv's cloud-token
// name comparisons, checkSecretContract's own observations) plus the 3 sites
// PR3 cut over to a LIVE answer (checkPeerUniqueness/checkBotCredentials/
// checkWorkerLabels via resolveLinearTokenLive) routes its call into the
// injected resolveSecretContract/resolveSecretFn dependency through here
// instead of calling it directly. runDoctor's
// `Promise.all(fns.map(...))` has no per-check isolation (out of scope to add
// one here — see doctor.test.mjs's B1 tests), so an uncaught throw from ANY
// check fn crashes the whole suite with zero report output. This wrapper
// itself never throws: `{ ok: true, value }` on success, `{ ok: false, error }`
// on throw.
// resolveDeploymentModeForShadow — the deployment-mode answer threaded into
// every shadow resolver call (#2916 Codex P2): without it, resolveSecret's
// cloud guard (deploymentMode.mode === "cloud" && inferred === false) can
// never activate, so a declared-cloud node's shadow would follow the
// non-cloud file/config ladder and mask exactly the provider divergence the
// shadow exists to detect. Throw-safe by the same B1 discipline: a throwing
// mode resolver degrades to undefined (= the engine's non-cloud path), never
// a crash.
function resolveDeploymentModeForShadow(env = process.env) {
  try {
    // #2916 round-3 (Codex P2): resolve from the SAME env the secrets resolve
    // from — a caller-injected env must drive both halves of the shadow, or a
    // fixture env declaring cloud would resolve secrets under the HOST's mode.
    return resolveDeploymentMode({ env });
  } catch {
    return undefined;
  }
}

function safeResolveSecretContract(resolveFn, secretId, opts) {
  try {
    return { ok: true, value: resolveFn(secretId, opts) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// shadowThrowCheck — the one throw-row shape every shadow call site shares
// (comparison-based and direct-read alike): LOUD STATUS.INFO, names the
// secret, quotes the resolver's error, and says explicitly the grade is
// unaffected — never silenced, never a grade change.
// shadowErrString — coercion-safe rendering of a caught throw (#2916 round-3
// Codex P3): a resolver may legally throw a Symbol or a null-prototype object,
// and interpolating those into a template literal itself throws — which would
// defeat the very throw-isolation this path exists for.
function shadowErrString(err) {
  try {
    const m = err?.message;
    if (typeof m === "string" && m) return m;
    return String(err);
  } catch {
    // Even the fallback can throw (a revoked Proxy throws on ANY operation,
    // including Object.prototype.toString.call) — end at a literal.
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "[unrenderable thrown value]";
    }
  }
}

function shadowThrowCheck(checkName, secretId, err) {
  return mkCheck(
    `${checkName}-secret-contract-shadow`,
    STATUS.INFO,
    `SHADOW RESOLVER THREW secret="${secretId}": ${shadowErrString(err)} — shadow disabled for this check, grade unaffected`,
  );
}

// buildContractShadowCheck — the ONE shared helper every injected-shadow call
// site below uses to build its (0 or 1) shadow-disagreement entry. Design §7/§9
// discipline: PR2 is a shadow pass — the contract is CONSULTED AND COMPARED but
// decides NOTHING. Every entry this returns is STATUS.INFO, and summarize()
// never counts INFO toward pass/warn/fail (doctor.mjs:1728-1736), so no call
// site that uses this helper can move doctor's exit code (the FAIL count) or
// its pass/warn/fail summary line.
//
// Returns null (no entry, no output) when the hand-rolled and contract answers
// AGREE — a clean cycle is silent. Returns a loud INFO check naming the secret
// id, the hand-rolled verdict, and the contract's {source, provider} answer
// when they DISAGREE — "escalated loudly, never silently reconciled" (house
// rule): disagreement is surfaced as its own visible check row, never merged
// into / swallowed by the primary check's own PASS/WARN/FAIL message. The
// resolver call itself is isolated via safeResolveSecretContract (B1) — a
// throwing resolver surfaces as a shadowThrowCheck INFO row instead of
// propagating up through the caller.
function buildContractShadowCheck({ checkName, secretId, handRolled, resolveSecretContract, env = process.env, deploymentMode = resolveDeploymentModeForShadow(env) }) {
  const resolution = safeResolveSecretContract(resolveSecretContract, secretId, { env, deploymentMode });
  if (!resolution.ok) return shadowThrowCheck(checkName, secretId, resolution.error);
  const contractResolved = resolution.value;
  const contractPresent = contractResolved?.value != null;
  if (Boolean(handRolled) === contractPresent) return null;
  return mkCheck(
    `${checkName}-secret-contract-shadow`,
    STATUS.INFO,
    `SHADOW DISAGREEMENT secret="${secretId}": hand-rolled=${handRolled ? "present" : "absent"} vs ` +
      `contract={value:${contractPresent ? "present" : "absent"}, source:${contractResolved?.source ?? "none"}, ` +
      `provider:${contractResolved?.provider ?? "none"}} — never changes this check's grade or exit code`,
  );
}

// resolveLinearTokenLive — CTL-1616 PR3 cutover (design §7/§9): the shared
// accessor checkPeerUniqueness/checkBotCredentials/checkWorkerLabels now use
// to get the LIVE linear-api-token answer from the contract engine — these 3
// sites no longer hand-roll their own `LINEAR_API_TOKEN ?? LINEAR_API_KEY`
// env ladder (that read is GONE), and the PR2 shadow-comparison each of them
// carried (buildContractShadowCheck against secretId "linear-api-token") is
// retired with it: there is no longer a second, independently-computed
// hand-rolled answer to compare the contract against, so the disagreement
// row these sites used to emit cannot exist anymore. resolveSecret's own
// contract promises "never throws", but this wraps via
// safeResolveSecretContract anyway — matching this file's existing
// defensive convention for every other secret-contract call site — so an
// injected test double (or a future registry bug) that DOES throw degrades
// to "no token" (the same WARN/INFO path a genuinely absent token already
// takes) rather than crashing the whole doctor run. Threads the shared
// resolveDeploymentModeForShadow() default so the cloud guard activates on a
// declared-cloud node exactly like every other secret-contract call site in
// this file (checkCloudTokenEnv, checkSecretContract).
function resolveLinearTokenLive(resolveSecretContract, deploymentMode = resolveDeploymentModeForShadow()) {
  const r = safeResolveSecretContract(resolveSecretContract, "linear-api-token", {
    env: process.env,
    deploymentMode,
  });
  return r.ok ? (r.value?.value ?? null) : null;
}

// ─── Internal path helpers ───────────────────────────────────────────────────

// The execution-core dir is plugins/dev/scripts/execution-core/
// Repo root is 5 levels up: doctor.mjs → execution-core → scripts → dev → plugins → repo root
function _repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
}

function layer1Path() {
  return resolve(_repoRoot(), ".catalyst", "config.json");
}

function layer2Path() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

function layer2HasKey(key) {
  try {
    let obj = JSON.parse(readFileSync(layer2Path(), "utf8"));
    for (const part of key.split(".")) {
      if (obj == null || typeof obj !== "object") return false;
      obj = obj[part];
    }
    return obj !== undefined && obj !== null;
  } catch {
    return false;
  }
}

// ─── Phase 1: Host-Identity checks ───────────────────────────────────────────

// checkHostIdentity — verifies host name is explicitly set and present in the
// RESOLVED cluster roster. Returns an array of Check records.
//
// CTL-1274: the roster's single durable home is the catalyst-cluster repo
// (resolveClusterHosts source=cluster-repo); the legacy per-repo
// .catalyst/hosts.json file is RETIRED. This check no longer probes that file —
// it validates via the resolver: report the source (cluster-repo/static/
// single-host), PASS when a non-empty roster resolves and this host is in it,
// and FAIL/WARN when the roster can't be resolved or omits self.
//
// Injected deps (all have real defaults):
//   getHostName           — () => string
//   resolveRoster         — () => { hosts: string[], source: string, multiHost: bool }
//   hostMembershipWarning — (roster, self) => string | null
//   layer2HasHostName     — () => bool
export function checkHostIdentity(deps = {}) {
  const {
    getHostName: _getHostName = getHostName,
    resolveRoster = resolveClusterHosts,
    hostMembershipWarning: _hostMembershipWarning = hostMembershipWarning,
    layer2HasHostName = () =>
      layer2HasKey("catalyst.host.name") ||
      (typeof process.env.CATALYST_HOST_NAME === "string" &&
        process.env.CATALYST_HOST_NAME.length > 0),
  } = deps;

  const checks = [];
  const self = _getHostName();

  // host-name: always INFO — show what name this node is using
  checks.push(mkCheck("host-name", STATUS.INFO, `this node identifies as "${self}"`));

  // host-name-source: WARN when using bare OS default (no explicit config)
  const hasExplicit = layer2HasHostName();
  if (!hasExplicit) {
    checks.push(
      mkCheck(
        "host-name-source",
        STATUS.WARN,
        `host name "${self}" is the OS default — set catalyst.host.name in ` +
          `~/.config/catalyst/config.json or CATALYST_HOST_NAME env for stable cluster identity`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "host-name-source",
        STATUS.PASS,
        `host name explicitly configured (catalyst.host.name or CATALYST_HOST_NAME)`,
      ),
    );
  }

  // roster-source: report where the resolved roster came from. resolveClusterHosts
  // is FAIL-OPEN (it always returns at least the single-host default), so an empty
  // roster here is an unexpected degenerate state worth FAILing on.
  const resolved = resolveRoster() ?? {};
  const roster = Array.isArray(resolved.hosts) ? resolved.hosts : [];
  const source = resolved.source ?? "unknown";

  if (roster.length === 0) {
    checks.push(
      mkCheck(
        "roster-source",
        STATUS.FAIL,
        `the cluster roster resolved empty (source=${source}) — the daemon would ` +
          `own zero tickets under HRW. Check the catalyst-cluster clone ` +
          `(~/catalyst/catalyst-cluster/cluster.json) or set catalyst.cluster.staticRoster.`,
      ),
    );
    return checks;
  }

  checks.push(
    mkCheck(
      "roster-source",
      STATUS.PASS,
      `roster resolved from ${source}: [${roster.join(", ")}]`,
    ),
  );

  // host-membership: FAIL when hostMembershipWarning returns a string (a multi-host
  // roster that omits self → this daemon owns zero tickets under HRW). Single-host
  // rosters pass trivially (the warning helper returns null for length <= 1).
  const warning = _hostMembershipWarning(roster, self);
  if (warning) {
    checks.push(mkCheck("host-membership", STATUS.FAIL, warning));
  } else {
    checks.push(
      mkCheck(
        "host-membership",
        STATUS.PASS,
        `"${self}" is a member of the cluster roster [${roster.join(", ")}]`,
      ),
    );
  }

  return checks;
}

// ─── Phase 2: HRW dry-run partition ──────────────────────────────────────────

// Default listTickets — spawns `linearis issues list` (outputs JSON by default) and extracts identifiers.
function defaultListTickets() {
  const result = spawnSync("linearis", ["issues", "list", "-l", "200"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        `linearis exited ${result.status}: ${result.stderr?.trim() ?? ""}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  // linearis may return an array of issue objects or a wrapper {issues:[...]}
  const items = Array.isArray(parsed) ? parsed : (parsed?.issues ?? parsed?.nodes ?? []);
  return items
    .map((t) => t?.identifier ?? t?.id ?? null)
    .filter((id) => typeof id === "string" && id.length > 0);
}

// checkHrwPartition — dry-run HRW ownership split across current roster.
export async function checkHrwPartition(deps = {}) {
  const {
    getHostName: _getHostName = getHostName,
    getClusterHosts: _getClusterHosts = getExistenceHosts,
    listTickets = defaultListTickets,
    ownedBy: _ownedBy = ownedBy,
  } = deps;

  const self = _getHostName();
  const roster = _getClusterHosts();

  let tickets;
  try {
    tickets = await listTickets();
  } catch (err) {
    return [
      mkCheck(
        "hrw-partition",
        STATUS.WARN,
        `could not list tickets for HRW dry-run (linearis unavailable?): ${err?.message ?? err}`,
      ),
    ];
  }

  const total = tickets.length;
  const owned = tickets.filter((id) => _ownedBy(id, roster, self)).length;

  if (roster.includes(self) && total > 0 && owned === 0) {
    return [
      mkCheck(
        "hrw-partition",
        STATUS.WARN,
        `"${self}" owns 0/${total} tickets under HRW — check host name matches roster entry exactly`,
      ),
    ];
  }

  return [
    mkCheck(
      "hrw-partition",
      STATUS.PASS,
      `"${self}" would own ${owned}/${total} tickets under current HRW partition`,
    ),
  ];
}

// ─── Phase 3: Live peer-identity uniqueness ───────────────────────────────────

// checkPeerUniqueness — reads live heartbeats and verifies no peer shares our
// host name (which would cause split-brain HRW routing).
export async function checkPeerUniqueness(deps = {}) {
  const {
    getHostName: _getHostName = getHostName,
    getLivenessAnchorIssue: _getLivenessAnchorIssue = getLivenessAnchorIssue,
    // CTL-1616 PR3 cutover (design §9): resolveSecretContract is the LIVE
    // answer now — see resolveLinearTokenLive's docstring for why the PR2
    // shadow comparison this call site carried is retired, not merely muted.
    resolveSecretContract = resolveSecret,
    hasLinearToken = () => resolveLinearTokenLive(resolveSecretContract) != null,
    readPeerHeartbeats: _readPeerHeartbeats = readPeerHeartbeats,
  } = deps;

  const anchorIssue = _getLivenessAnchorIssue();
  if (!anchorIssue) {
    return [
      mkCheck(
        "peer-uniqueness",
        STATUS.INFO,
        `no liveness anchor issue configured — skipping peer-uniqueness check ` +
          `(set CATALYST_LIVENESS_ANCHOR_ISSUE or catalyst.cluster.livenessAnchorIssue)`,
      ),
    ];
  }

  if (!hasLinearToken()) {
    return [
      mkCheck(
        "peer-uniqueness",
        STATUS.WARN,
        `no LINEAR_API_TOKEN / LINEAR_API_KEY — cannot read live peer heartbeats`,
      ),
    ];
  }

  const self = _getHostName();
  let peers;
  try {
    peers = await _readPeerHeartbeats({ anchorIssue });
  } catch (err) {
    return [
      mkCheck(
        "peer-uniqueness",
        STATUS.WARN,
        `failed to read peer heartbeats: ${err?.message ?? err}`,
      ),
    ];
  }

  // Remove self from the map before checking
  const peerKeys = Object.keys(peers).filter((k) => k !== self);

  if (peerKeys.length === 0 && Object.keys(peers).length === 0) {
    return [
      mkCheck(
        "peer-uniqueness",
        STATUS.WARN,
        `peer heartbeats returned empty — cluster may be freshly initialized or anchor is stale`,
      ),
    ];
  }

  if (peerKeys.includes(self)) {
    return [
      mkCheck(
        "peer-uniqueness",
        STATUS.FAIL,
        `a live peer is already using host name "${self}" — two nodes with the same ` +
          `identity will cause HRW split-brain; set a unique catalyst.host.name`,
      ),
    ];
  }

  return [
    mkCheck(
      "peer-uniqueness",
      STATUS.PASS,
      `no live peer is using host name "${self}" (${peerKeys.length} peer(s) seen)`,
    ),
  ];
}

// ─── Phase 4: Bot-credential identity + Linear connectivity ──────────────────

const LINEAR_GQL = "https://api.linear.app/graphql";

// checkBotCredentials — verifies Linear API reachability and that the token
// actor matches the locally-configured bot user ID.
export async function checkBotCredentials(deps = {}) {
  const {
    readLinearBotUserIds: _readLinearBotUserIds = readLinearBotUserIds,
    // CTL-1616 PR3 cutover (design §9): resolveSecretContract is the LIVE
    // answer now — see resolveLinearTokenLive's docstring for why the PR2
    // shadow comparison this call site carried is retired, not merely muted.
    resolveSecretContract = resolveSecret,
    linearToken = () => resolveLinearTokenLive(resolveSecretContract) ?? "",
    fetch: _fetch = globalThis.fetch,
    expectedBotUserId = null,
  } = deps;

  const token = linearToken();
  const checks = [];

  // linear-connectivity
  if (!token) {
    checks.push(
      mkCheck(
        "linear-connectivity",
        STATUS.WARN,
        `no LINEAR_API_TOKEN / LINEAR_API_KEY — skipping Linear connectivity check`,
      ),
    );
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.WARN,
        `no token — cannot verify bot identity`,
      ),
    );
    if (expectedBotUserId) {
      checks.push(
        mkCheck(
          "bot-parity",
          STATUS.FAIL,
          `--expected-bot-user-id provided but no token to verify against`,
        ),
      );
    } else {
      checks.push(
        mkCheck("bot-parity", STATUS.INFO, `no --expected-bot-user-id provided`),
      );
    }
    return checks;
  }

  // Probe Linear with a viewer query
  // NOTE: use raw token in Authorization header — matches check-project-setup.sh convention
  const VIEWER_QUERY = `query { viewer { id name email } }`;
  let viewerData = null;
  let connectivityErr = null;

  try {
    const res = await _fetch(LINEAR_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      connectivityErr = `HTTP ${res.status}`;
    } else {
      const json = await res.json();
      if (json?.errors?.length) {
        connectivityErr = `GraphQL errors: ${JSON.stringify(json.errors)}`;
      } else {
        viewerData = json?.data?.viewer ?? null;
      }
    }
  } catch (err) {
    connectivityErr = err?.message ?? String(err);
  }

  if (connectivityErr) {
    checks.push(
      mkCheck(
        "linear-connectivity",
        STATUS.FAIL,
        `Linear API unreachable: ${connectivityErr}`,
      ),
    );
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.WARN,
        `cannot verify bot identity — Linear unreachable`,
      ),
    );
    checks.push(
      mkCheck(
        "bot-parity",
        STATUS.WARN,
        `cannot verify bot parity — Linear unreachable`,
      ),
    );
    return checks;
  }

  checks.push(
    mkCheck(
      "linear-connectivity",
      STATUS.PASS,
      `Linear API reachable (viewer: ${viewerData?.email ?? viewerData?.id ?? "unknown"})`,
    ),
  );

  // bot-identity: token actor must be in local bot-id set
  const botIds = _readLinearBotUserIds(layer1Path(), layer2Path());
  const actorId = viewerData?.id ?? null;

  if (!actorId) {
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.WARN,
        `could not read actor ID from Linear viewer query`,
      ),
    );
  } else if (botIds.size === 0) {
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.WARN,
        `no bot user IDs configured locally — cannot verify token actor identity ` +
          `(set catalyst.linear.bot.worker.botUserId in ~/.config/catalyst/config.json)`,
      ),
    );
  } else if (!botIds.has(actorId)) {
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.FAIL,
        `token actor "${actorId}" is NOT in the local bot-id set ` +
          `[${[...botIds].join(", ")}] — wrong token?`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "bot-identity",
        STATUS.PASS,
        `token actor "${actorId}" matches a configured bot user ID`,
      ),
    );
  }

  // bot-parity: optional --expected-bot-user-id cross-check
  if (!expectedBotUserId) {
    checks.push(
      mkCheck("bot-parity", STATUS.INFO, `no --expected-bot-user-id provided`),
    );
  } else if (!botIds.has(expectedBotUserId)) {
    checks.push(
      mkCheck(
        "bot-parity",
        STATUS.FAIL,
        `expected bot user ID "${expectedBotUserId}" is not present in the local ` +
          `bot-id config [${[...botIds].join(", ")}]`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "bot-parity",
        STATUS.PASS,
        `expected bot user ID "${expectedBotUserId}" is present in local config`,
      ),
    );
  }

  return checks;
}

// ─── CTL-2074: self-echo identity ↔ real issue_history cross-check ────────────
//
// `botUserIds` is the fleet's answer to "was this Linear change made by us?". Since
// CTL-1889 both minis write THROUGH the cloud proxy (CATALYST_LINEAR_WRITE_PROXY=
// enforce), so their writes carry the cloud tenant's app-actor id — and if that id is
// absent from the recognition set, a proxied write mirrored back reads as "a human
// replied on the daemon's own output". That is a SILENT failure: nothing errors, and
// the set is resolved from config + a durable ledger, NEVER from history. This check
// turns it loud — it verifies the recognition set against who ACTUALLY writes state,
// from real issue_history rows (the AC's "verified by a query against real
// issue_history rows, not by reading config"), with a positive control.
//
// Advisory (WARN, never FAIL): doctor's exit code is the FAIL count and gates
// activation; this is "make it loud", not "block a node whose cloud id isn't
// provisioned yet". Every negative carries a positive control — an undefined read or
// an empty result is INCONCLUSIVE (WARN), never a clean PASS.
//
// defaultRecentStateChangeActors — read the replica via the sqlite3 CLI (an OPTIONAL
// dependency), the SAME discipline as defaultReadDbTables (CAT-35): doctor runs under
// bare node and must not import replica-read.mjs (bun:sqlite). This SQL is a twin of
// replica-read.mjs's RECENT_STATE_CHANGE_ACTORS_SELECT — kept a copy precisely because
// doctor cannot share the bun: reader. undefined = could-not-look (sqlite3 absent /
// query failed / db missing); [] = looked-and-found-nothing. The two must stay
// distinct — an empty read reported as clean is the silent false-clean this ends.
function defaultRecentStateChangeActors({ dbPath, limit = 50, run = spawnSync } = {}) {
  if (!dbPath) return undefined;
  const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const sql =
    "SELECT h.actor_id AS actorId, u.name AS name, COUNT(*) AS count " +
    "FROM issue_history h LEFT JOIN users u ON u.id = h.actor_id " +
    "WHERE h.to_state IS NOT NULL AND h.actor_id IS NOT NULL " +
    `GROUP BY h.actor_id ORDER BY count DESC LIMIT ${n}`; // n is a validated integer — no injection
  let r;
  try {
    r = run("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return undefined;
  }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const out = r.stdout.trim();
  if (out === "") return []; // looked, found nothing (positive control failed downstream)
  try {
    const rows = JSON.parse(out);
    if (!Array.isArray(rows)) return undefined;
    return rows.map((x) => ({ actorId: x.actorId ?? null, name: x.name ?? null, count: Number(x.count) || 0 }));
  } catch {
    return undefined;
  }
}

export function checkSelfEchoIdentityHistory(deps = {}) {
  const name = "self-echo-identity-history";
  const {
    // Codex #3738 P2: resolve the mode through the write transport's env > Layer-2 >
    // 'off' ladder, NOT the env var alone — a Layer-2-only enforce host was silently
    // skipped by the old `process.env.CATALYST_LINEAR_WRITE_PROXY || "off"` default.
    proxyMode = readLinearWriteProxyConfig().mode,
    botIds = readLinearBotUserIds(layer1Path(), layer2Path()),
    // Codex #3738 P2: the current cloud-proxy actor — the PASS is tied to THIS id, not
    // to any historical member of botIds (see readCloudBotUserId).
    cloudBotId = readCloudBotUserId(layer2Path()),
    recentActors = () => defaultRecentStateChangeActors({ dbPath: getReplicaDbPath() }),
  } = deps;

  const mode = String(proxyMode || "off").toLowerCase();
  // The guard only bites under enforce — off/shadow proxied writes carry the direct
  // app-actor id already in the set, so history recognition is N/A.
  if (mode !== "enforce") {
    return mkCheck(
      name,
      STATUS.INFO,
      `write proxy not enforcing (CATALYST_LINEAR_WRITE_PROXY=${mode}) — proxied-identity self-echo N/A`,
    );
  }

  const actors = typeof recentActors === "function" ? recentActors() : recentActors;
  // could-not-look — NEVER a clean pass.
  if (actors === undefined) {
    return mkCheck(
      name,
      STATUS.WARN,
      "replica unavailable — cannot verify the self-echo identity against issue_history " +
        "(inconclusive, not a clean pass)",
    );
  }
  // looked, found nothing — the positive control failed, so a "recognized" verdict
  // would be unfounded. Inconclusive, never PASS.
  if (!Array.isArray(actors) || actors.length === 0) {
    return mkCheck(
      name,
      STATUS.WARN,
      "no state changes in the recent window — positive control failed; cannot confirm the " +
        "self-echo identity against history (inconclusive, not a clean pass)",
    );
  }

  // Codex #3738 P2: under enforce every daemon state write carries the CLOUD proxy
  // app-actor id, so the PASS is tied to THAT specific id — not to any member of the
  // full recognition set. A legacy worker/orchestrator id that changed state before the
  // cutover is still in `botIds`, and the old "any recognized member ⇒ PASS" would let it
  // mask an unrecognized current cloud writer with a clean pass — the exact silent
  // condition this check exists to expose. (`ids` is retained only for the diagnostic
  // note below, distinguishing a set the cloud id is genuinely part of.)
  const candidates = actors
    .slice(0, 5)
    .map((a) => `${a.actorId}${a.name ? ` "${a.name}"` : ""} (${a.count})`)
    .join(", ");
  const ids = botIds instanceof Set ? botIds : new Set(Array.isArray(botIds) ? botIds : []);
  const cloudId = typeof cloudBotId === "string" && cloudBotId.length > 0 ? cloudBotId : null;

  // The cloud-proxy identity isn't configured at all — nothing pins the fleet's own
  // proxied writes, so every one of them reads as a human reply. The CTL-2074 condition.
  if (!cloudId) {
    return mkCheck(
      name,
      STATUS.WARN,
      "write proxy=enforce but the cloud-proxy identity is not configured " +
        "(catalyst.linear.bot.cloud.botUserId) — the fleet's own proxied writes read as human " +
        "replies. Confirm the cloud-proxy identity AT THE PROXY (users.type is unreliable — never " +
        "auto-classify) and set it. Recent state-writers: " +
        candidates,
    );
  }

  const cloudWrites = actors.filter((a) => a.actorId === cloudId);
  if (cloudWrites.length > 0) {
    const who = cloudWrites.map((a) => a.name || a.actorId).join(", ");
    const inSet = ids.has(cloudId) ? "" : " (⚠ present in history but ABSENT from the recognition set)";
    return mkCheck(
      name,
      // The cloud id writing state but missing from the recognition set is itself a
      // misconfiguration — the daemon would treat these writes as human. WARN, not PASS.
      ids.has(cloudId) ? STATUS.PASS : STATUS.WARN,
      `write proxy=enforce and the configured cloud-proxy identity writes state: ${who}${inSet} ` +
        `(${cloudWrites.length} of ${actors.length} recent state-writers)`,
    );
  }

  // The cloud id is configured but never appears among the actors who ACTUALLY write
  // state — either it is the wrong id or a legacy actor is still writing. Either way the
  // fleet's proxied writes are not recognized. Name the candidates so the operator can
  // confirm the right one AT THE PROXY (users.type is unreliable — never auto-classify).
  return mkCheck(
    name,
    STATUS.WARN,
    "write proxy=enforce but the configured cloud-proxy identity " +
      `(${cloudId}) is NOT among the recent state-writers — the fleet's own proxied writes read ` +
      "as human replies. Confirm the cloud-proxy identity AT THE PROXY and correct " +
      "catalyst.linear.bot.cloud.botUserId. Recent state-writers: " +
      candidates,
  );
}

// ─── Phase 5: Connectivity + Secrets hygiene ─────────────────────────────────

// checkConnectivity — probes seed node, OTEL endpoint, and GitHub API.
export async function checkConnectivity(deps = {}) {
  const {
    seed = process.env.CATALYST_SEED_HOST ?? null,
    otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    fetch: _fetch = globalThis.fetch,
  } = deps;

  const probe = async (name, url) => {
    try {
      const res = await _fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return mkCheck(name, STATUS.PASS, `${url} → HTTP ${res.status}`);
    } catch (err) {
      return mkCheck(name, STATUS.FAIL, `${url} unreachable: ${err?.message ?? err}`);
    }
  };

  const checks = [];

  // seed-reachable
  if (!seed) {
    checks.push(
      mkCheck(
        "seed-reachable",
        STATUS.WARN,
        `CATALYST_SEED_HOST not set — skipping seed-node connectivity check`,
      ),
    );
  } else {
    const url = seed.startsWith("http") ? `${seed}/api/health` : `http://${seed}/api/health`;
    checks.push(await probe("seed-reachable", url));
  }

  // otel-reachable
  if (!otel) {
    checks.push(
      mkCheck(
        "otel-reachable",
        STATUS.WARN,
        `OTEL_EXPORTER_OTLP_ENDPOINT not set — skipping OTEL connectivity check`,
      ),
    );
  } else {
    checks.push(await probe("otel-reachable", otel));
  }

  // github-reachable — always check
  checks.push(await probe("github-reachable", "https://api.github.com"));

  return checks;
}

// checkSecretsHygiene — verifies Layer-2 config is not world-readable, not
// tracked by git, and that Layer-1 contains no embedded secrets.
export function checkSecretsHygiene(deps = {}) {
  const {
    layer2Mode = () => {
      try {
        const mode = statSync(layer2Path()).mode & 0o777;
        return mode.toString(8).padStart(3, "0");
      } catch {
        return null;
      }
    },
    layer2InGitTree = () => {
      const l2 = layer2Path();
      const dir = dirname(l2);
      try {
        execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        // If we get here, we're inside a git tree — now check if the file is tracked
        execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", l2], {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "ignore"],
        });
        return true; // file is tracked
      } catch {
        return false; // not in git tree OR not tracked → safe
      }
    },
    layer1Body = () => {
      try {
        return readFileSync(layer1Path(), "utf8");
      } catch {
        return "";
      }
    },
    layer2Exists = () => existsSync(layer2Path()),
  } = deps;

  const checks = [];

  // Only run perms/git checks if the file exists
  if (layer2Exists()) {
    // layer2-perms: FAIL if group or other bits are set (not "600")
    const mode = layer2Mode();
    if (mode === null) {
      checks.push(
        mkCheck(
          "layer2-perms",
          STATUS.WARN,
          `could not stat Layer-2 config — permissions unknown`,
        ),
      );
    } else {
      const modeNum = parseInt(mode, 8);
      const groupOther = modeNum & 0o077; // bits for group + other
      if (groupOther !== 0) {
        checks.push(
          mkCheck(
            "layer2-perms",
            STATUS.FAIL,
            `Layer-2 config has mode ${mode} — must be 600 (run: chmod 600 ${layer2Path()})`,
          ),
        );
      } else {
        checks.push(
          mkCheck(
            "layer2-perms",
            STATUS.PASS,
            `Layer-2 config permissions are ${mode} (safe)`,
          ),
        );
      }
    }

    // config-not-in-git: FAIL if Layer-2 is tracked by git
    if (layer2InGitTree()) {
      checks.push(
        mkCheck(
          "config-not-in-git",
          STATUS.FAIL,
          `Layer-2 config (${layer2Path()}) is tracked by git — it contains secrets ` +
            `and must be in .gitignore`,
        ),
      );
    } else {
      checks.push(
        mkCheck(
          "config-not-in-git",
          STATUS.PASS,
          `Layer-2 config is not tracked by git`,
        ),
      );
    }
  } else {
    checks.push(
      mkCheck(
        "layer2-perms",
        STATUS.INFO,
        `Layer-2 config does not exist yet — no permissions to check`,
      ),
    );
    checks.push(
      mkCheck(
        "config-not-in-git",
        STATUS.INFO,
        `Layer-2 config does not exist yet — nothing to check`,
      ),
    );
  }

  // no-secrets-in-layer1: FAIL if Layer-1 body contains token strings
  const body = layer1Body();
  if (/lin_oauth_|lin_api_/.test(body)) {
    checks.push(
      mkCheck(
        "no-secrets-in-layer1",
        STATUS.FAIL,
        `Layer-1 config (.catalyst/config.json) appears to contain a Linear API ` +
          `token (lin_oauth_* or lin_api_*) — secrets belong in the Layer-2 config ` +
          `(~/.config/catalyst/config.json) which is machine-local and never committed`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "no-secrets-in-layer1",
        STATUS.PASS,
        `Layer-1 config contains no embedded Linear tokens`,
      ),
    );
  }

  return checks;
}

// ─── Phase 5: Daemon-runtime tool PATH (CTL-1289) ────────────────────────────

// The execution-core daemon is NOT pure OAuth — it shells out to `linearis`
// (reconcile), `claude` (liveness snapshot) and `node` (linearis's
// `#!/usr/bin/env node` runtime) every tick. On a `catalyst-join`-joined member
// those CLIs live under ~/.local/{bin,node/bin}; if the launchd daemon's PATH
// omits them, every spawn exit-127s and the node strands SILENTLY — it boots
// clean, emits heartbeats, shows `owns N`, but reconcile freezes, the liveness
// snapshot never warms (freeSlots=0 → new-work held) and the GC/reaper sweeps
// fail-closed. This check is the load-bearing daemon-context assertion: it
// resolves the three CLIs against the DAEMON's PATH — the installed launchd
// plist's <key>PATH</key>, NOT process.env.PATH, which the join shell enriches
// (catalyst-join.sh:719) and would FALSE-PASS — and FAILs (not WARNs) so the
// activation gate fail-closes instead of stranding.

// defaultDaemonPath — extract the PATH the launchd daemon actually runs with,
// from the installed catalyst-stack plist. Tests the persisted state, so a
// stale plist (installed before the CTL-1289 fix) is caught. null = not installed.
function defaultDaemonPath() {
  const plist = resolve(
    homedir(), "Library", "LaunchAgents", "ai.coalesce.catalyst-stack.plist",
  );
  try {
    const xml = readFileSync(plist, "utf8");
    const m = xml.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// CAT-29: prefer facts published by the live daemon. A correct installed plist
// cannot certify a daemon that was started earlier from a broken interactive
// environment. Stale facts are ignored by verifying that their PID is alive.
function defaultRunningDaemonFacts() {
  try {
    const facts = JSON.parse(readFileSync(join(getExecutionCoreDir(), "boot-facts.json"), "utf8"));
    if (!Number.isInteger(facts?.pid) || typeof facts?.path !== "string") return null;
    process.kill(facts.pid, 0);
    return facts;
  } catch {
    return null;
  }
}

// defaultResolveInPath — does `cmd` resolve to an executable under `pathStr`?
// Uses `command -v` with positional args (no shell injection).
function defaultResolveInPath(cmd, pathStr) {
  const r = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd], {
    timeout: 5_000,
    env: { ...process.env, PATH: pathStr },
  });
  return r.status === 0;
}

// defaultSmokeProbe — run `cmd args` under `pathStr` and return the exit code.
// ENOENT (cmd itself absent) maps to 127; the caller only cares whether the
// result is the 127 strand signature (a shelled-out dependency unresolved).
// Auth/network failures surface as a NON-127 exit, so they never false-FAIL.
function defaultSmokeProbe(cmd, args, pathStr) {
  const r = spawnSync(cmd, args, {
    timeout: 12_000,
    env: { ...process.env, PATH: pathStr },
  });
  if (r.error) return r.error.code === "ENOENT" ? 127 : -1;
  return r.status;
}

// checkDaemonToolPath — assert the daemon's launchd PATH can resolve and run the
// CLIs it shells out to. Injectable deps for unit testing.
export function checkDaemonToolPath(deps = {}) {
  const plistPath = deps.daemonPath !== undefined ? deps.daemonPath : defaultDaemonPath();
  const runningFacts = deps.runningFacts !== undefined ? deps.runningFacts : defaultRunningDaemonFacts();
  const {
    resolveInPath = defaultResolveInPath,
    smokeProbe = defaultSmokeProbe,
    tools = ["linearis", "node", "claude"],
  } = deps;
  const daemonPath = runningFacts?.path ?? plistPath;

  if (!daemonPath) {
    return [
      mkCheck(
        "daemon-tool-path",
        STATUS.WARN,
        "no running daemon boot facts or installed catalyst-stack launchd plist found — cannot assert the daemon's PATH; run `catalyst-stack install-services`",
      ),
    ];
  }

  const missing = tools.filter((t) => !resolveInPath(t, daemonPath));
  if (missing.length > 0) {
    const source = runningFacts ? "running daemon" : "daemon launchd";
    const disagreement =
      runningFacts && plistPath && missing.every((tool) => resolveInPath(tool, plistPath));
    return [
      mkCheck(
        "daemon-tool-path",
        STATUS.FAIL,
        `${source} PATH cannot resolve: ${missing.join(", ")} — the daemon shells out to these every tick; missing → exit-127 silent strand (frozen eligible set, freeSlots=0).${disagreement ? " Running daemon PATH disagrees with the installed plist." : ""} PATH=${daemonPath}`,
      ),
    ];
  }

  // All resolve — smoke-probe that they don't exit-127 under the daemon PATH
  // (catches e.g. linearis resolving but its node runtime not, or a broken wrapper).
  const probes = [
    ["linearis", ["issues", "list", "-l", "1"]],
    ["claude", ["agents", "--json"]],
  ].filter(([cmd]) => tools.includes(cmd));
  const exit127 = probes
    .filter(([cmd, args]) => smokeProbe(cmd, args, daemonPath) === 127)
    .map(([cmd]) => cmd);

  if (exit127.length > 0) {
    return [
      mkCheck(
        "daemon-tool-path",
        STATUS.FAIL,
        `${exit127.join(", ")} exit-127 under the daemon PATH (a shelled-out dependency is unresolved) — the precise strand signature`,
      ),
    ];
  }

  return [
    mkCheck(
      "daemon-tool-path",
      STATUS.PASS,
      `${runningFacts ? "running daemon" : "daemon launchd"} PATH resolves linearis/node/claude and they run (no exit-127)`,
    ),
  ];
}

// ─── Phase 5c: Webhook ingestion (CTL-1284) ──────────────────────────────────

// A `catalyst-join`-joined MEMBER must ingest inbound GitHub/Linear webhooks —
// without them monitor-merge CI-waits and comment-wakes degrade to polling. But
// a SINGLE-host node must NOT ingest: at roster length 1 HRW is an identity
// no-op and claimDispatch is skipped, so a lone node would actuate every inbound
// event → double-dispatch. This check asserts: single-host → PASS (ingestion
// legitimately off); multiHost → at least one webhook route is FULLY wired (smee
// channel + matching HMAC secret on disk), with no half-wired webhookId (id
// configured but secret file missing). FAILs so the activation gate fail-closes.

function defaultWebhookConfigDir() {
  return resolve(homedir(), ".config", "catalyst");
}

function defaultReadMonitor() {
  try {
    const obj = JSON.parse(readFileSync(layer2Path(), "utf8"));
    return obj?.catalyst?.monitor ?? null;
  } catch {
    return null;
  }
}

function defaultSecretFileNonEmpty(dir, name) {
  try {
    return readFileSync(resolve(dir, name), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

// Reads the configurable GitHub webhook-secret env-var NAME from Layer-1
// (.catalyst/config.json → catalyst.monitor.github.webhookSecretEnv), matching
// webhook-config.ts:412. Defaults to CATALYST_WEBHOOK_SECRET. CTL-1618.
// Resolve the Layer-1 path via resolveDoctorLayer1Path() (not layer1Path()) so
// this reader honors the CATALYST_CONFIG_FILE / CATALYST_CONFIG_PATH pointers the
// daemon/deploy sets and falls back to ${cwd}/.catalyst/config.json — the SAME
// Layer-1 the running monitor resolves, so the env name matches at runtime
// (Codex P1: a plugin-repo read diverges from the active project config).
function defaultGithubSecretEnvName() {
  try {
    const obj = JSON.parse(readFileSync(resolveDoctorLayer1Path(), "utf8"));
    const name = obj?.catalyst?.monitor?.github?.webhookSecretEnv;
    return typeof name === "string" && name.length > 0 ? name : "CATALYST_WEBHOOK_SECRET";
  } catch {
    return "CATALYST_WEBHOOK_SECRET";
  }
}

// Reads the configurable Linear webhook-secret env-var NAME from Layer-1
// (.catalyst/config.json → catalyst.monitor.linear.webhookSecretEnv), matching
// webhook-config.ts:264-269. Null when unset (no per-key env override). CTL-1618.
// Uses resolveDoctorLayer1Path() (not layer1Path()) for the same monitor-parity
// reason as defaultGithubSecretEnvName above (Codex P1).
function defaultLinearSecretEnvName() {
  try {
    const obj = JSON.parse(readFileSync(resolveDoctorLayer1Path(), "utf8"));
    const name = obj?.catalyst?.monitor?.linear?.webhookSecretEnv;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// defaultReadGithubFeedReady — read the GitHub-feed producer's readiness heartbeat.
//
// ⛔ THE PATH IS RESOLVED THE PRODUCER'S WAY, NOT THE READER'S. CTL-1976 already paid
// for this once: the broker derived the readiness path from ITS orchDir
// (`~/catalyst/shadow/...`) while the daemon wrote `~/catalyst/execution-core/shadow/...`,
// and the miss is silent because `readReadyState` answers `ready:false` for an absent
// file — indistinguishable from "the producer is down". Same rule for the ACCOUNT: it
// comes from the hoisted `resolveGithubFeedAccount`, the one the producer itself calls.
//
// Returns the verdict object unchanged (`{ ready, reason, state }`) plus the path it
// looked at, because "I could not look" and "it is not there" must be separable in the
// message — a check that cannot tell those apart is the class this ticket is about.
function defaultReadGithubFeedReady() {
  const path = defaultReadyPath(getExecutionCoreDir(), resolveGithubFeedAccount());
  try {
    return { ...readReadyState(path), path };
  } catch (err) {
    return { ready: false, reason: `ready-read-threw:${err?.message ?? "unknown"}`, state: null, path };
  }
}

// githubFeedCoverageFromReady — the RUNTIME coverage, read off the producer's own
// heartbeat (CTL-2030). Returns null when the record predates this field or the tick
// threw; callers must treat null as UNKNOWN and must NOT fall back to
// GITHUB_SUPPRESSIBLE_NAMES, which is the frozen constant whose staleness is half of
// what this ticket fixes.
function githubFeedCoverageFromReady(state) {
  const c = state?.coverage;
  if (!c || typeof c !== "object") return null;
  const suppressible = Number(c.suppressible);
  const consumed = Number(c.consumed);
  if (!Number.isFinite(suppressible) || !Number.isFinite(consumed)) return null;
  return {
    suppressible,
    consumed,
    uncovered: Array.isArray(c.uncovered) ? c.uncovered : [],
  };
}

export function checkWebhookIngestion(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    monitor = defaultReadMonitor(),
    configDir = defaultWebhookConfigDir(),
    secretFileNonEmpty = defaultSecretFileNonEmpty,
    githubSecretEnvName = defaultGithubSecretEnvName(), // CTL-1618
    linearSecretEnvName = defaultLinearSecretEnvName(), // CTL-1618
    // CTL-1616 PR2: shadow-only contract resolver for the github "webhook-secret"
    // row — consulted and COMPARED against `ghSecret` below (see the comment at
    // its use site), never used to decide this check's grade. Surfaces exactly
    // the divergence design §7 names: defaultWebhookConfigDir() hardcodes
    // ~/.config/catalyst, ignoring CATALYST_CONFIG_DIR / CATALYST_LAYER2_CONFIG_FILE
    // / XDG overrides that secretFileCandidates (and so resolveSecret) honors.
    resolveSecretContract = resolveSecret,
    // CTL-1617 mode-alignment (#2913 Codex P1): the join's webhook-wiring gate
    // now skips wiring when a RECOGNIZED non-cluster mode is declared — so a
    // multiHost-roster node with no route is CONSISTENT config on such a node,
    // not a failure. Injectable for tests; a throwing resolver degrades to
    // undefined = the pre-alignment FAIL behavior (grading must fail closed,
    // unlike the INFO-only shadow's throw handling).
    resolveDeploymentModeFn = resolveDeploymentMode,
    // CTL-1929: the GitHub-feed mode, injectable for the same reason
    // resolveDeploymentModeFn is — the declared-cloud branch's grade now depends on
    // it, and driving it through the real env would make these tests mutate a
    // process-wide flag that four readers in three processes consult.
    resolveGithubFeedModeFn = resolveGithubFeedMode,
    // CTL-2030: the producer's readiness heartbeat, and the ONLY evidence this check
    // has about whether the live GitHub route is actually delivering. Injectable for
    // the same reason the two resolvers above are.
    readGithubFeedReadyFn = defaultReadGithubFeedReady,
  } = deps;

  const roster = resolveRoster();
  if (!roster?.multiHost) {
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.PASS,
        "single-host roster — webhook ingestion legitimately disabled (double-dispatch guard)",
      ),
    ];
  }

  const m = monitor ?? {};

  // GitHub route: smee channel + a github HMAC secret resolved the way the
  // running monitor reads it (webhook-config.ts:412,429). The env-var NAME is
  // configurable (Layer-1 webhookSecretEnv, default CATALYST_WEBHOOK_SECRET);
  // the CTL-1612 projection lifts the on-disk `webhook-secret` file into the
  // DEFAULT name only, so the file is a valid proxy solely for the default. CTL-1618.
  const ghSmee = typeof m.github?.smeeChannel === "string" ? m.github.smeeChannel : "";
  // Resolve the env secret with the SAME `??` chain as the runtime
  // (webhook-config.ts:429): `process.env[name] ?? CATALYST_SMEE_SECRET ?? ""`.
  // `??` (not `||`) matters — an env var explicitly set to "" is NOT nullish, so
  // it short-circuits and the legacy CATALYST_SMEE_SECRET fallback is NOT reached,
  // exactly as the monitor computes it. A prior `||`-of-length chain would let an
  // empty primary fall through to a set SMEE secret and falsely report the route
  // wired when the runtime disables it (secret.length === 0). CTL-1618.
  const ghEnvSecret =
    (process.env[githubSecretEnvName] ?? process.env.CATALYST_SMEE_SECRET ?? "").length > 0;
  const ghFileSecret =
    githubSecretEnvName === "CATALYST_WEBHOOK_SECRET" &&
    secretFileNonEmpty(configDir, "webhook-secret");
  const ghSecret = ghEnvSecret || ghFileSecret;
  const smeeWired = ghSmee.length > 0 && ghSecret;

  // ─── CTL-2030: grade the route this host ACTUALLY USES ─────────────────────
  //
  // ⛔ THE FEED MODE IS NOW RESOLVED UNCONDITIONALLY. It used to be read only inside
  // the declared-`cloud` branch, so on the two production minis — which declare
  // `cluster`, not `cloud` — this check never looked at the feed at all and reported
  //
  //     [PASS] webhook-ingestion: webhook ingestion wired (github=true, ...)
  //
  // while BOTH hosts received zero GitHub webhooks: the tunnel is suppressed at
  // `enforce` and all eight webhooks are `active:false` (CTL-1929, 17:36 CT
  // 2026-08-18). `githubWired` is CONFIGURATION PRESENCE — smeeChannel + an HMAC
  // secret — and both are deliberately retained because they are the rollback lever.
  // So the check answered "is the smee route configured?" (yes, on purpose) and
  // printed it as "ingestion wired".
  //
  // ⛔ That is not merely cosmetic, and the second failure is the one that matters:
  // if the FEED breaks on an enforce host, this check still PASSes, because it never
  // looks at the feed. The one condition under which GitHub ingestion is actually
  // dead is the one condition it could not detect.
  //
  // A throwing resolver grades as `off` — the pre-cutover reading — for the same
  // fail-closed reason the declared-cloud branch already used: an unreadable config
  // must never be why doctor tells an operator the route is whole.
  let ghFeed;
  try {
    ghFeed = resolveGithubFeedModeFn();
  } catch {
    ghFeed = { mode: "off", source: "resolver-threw" };
  }
  // At `enforce` the smee wiring is INERT: the tunnel is suppressed and the webhooks
  // are disabled, so its configuration says nothing about whether events arrive.
  const feedIsLiveRoute = ghFeed.mode === "enforce";
  const githubWired = feedIsLiveRoute ? false : smeeWired;
  // Read once. Consulted by the enforce branch below AND by the declared-cloud
  // branch's runtime-coverage read, so a single read keeps the two from disagreeing
  // about the same file within one run.
  // Resolved once, here, because BOTH the enforce branch below and the
  // no-route branch after it need it. Same fail-closed handling as before:
  // an unresolvable mode keeps the original FAIL guarantee.
  let declaredMode;
  try {
    declaredMode = resolveDeploymentModeFn();
  } catch {
    declaredMode = undefined;
  }
  const declaredTail = declaredMode?.recognized
    ? ` [declared deployment mode "${declaredMode.mode}", source=${declaredMode.source}]`
    : "";
  let feedReady;
  try {
    feedReady = readGithubFeedReadyFn();
  } catch (err) {
    feedReady = { ready: false, reason: `ready-read-threw:${err?.message ?? "unknown"}`, state: null, path: null };
  }

  // CTL-1616 PR2: shadow comparison for the github webhook-secret leg only —
  // the linear-webhook-secret family has no single scalar contract value (it's
  // a PREDICATE, design §2/§3), so it is not shadow-compared here. Computed
  // once; appended to every multiHost return below (the single-host early
  // return above never reaches here — this check doesn't grade secrets in
  // that mode, so there's nothing to shadow).
  const webhookShadowCheck = buildContractShadowCheck({
    checkName: "webhook-ingestion",
    secretId: "webhook-secret",
    handRolled: ghSecret,
    resolveSecretContract,
  });
  const webhookShadow = webhookShadowCheck ? [webhookShadowCheck] : [];

  // Linear route: smee channel + ≥1 keyed webhookId whose HMAC secret resolves.
  const linear =
    m.linear && typeof m.linear === "object" && !Array.isArray(m.linear) ? m.linear : {};
  const linSmee = typeof linear.smeeChannel === "string" ? linear.smeeChannel : "";
  const webhookKeys = Object.keys(linear).filter((k) => {
    const e = linear[k];
    return (
      e && typeof e === "object" && !Array.isArray(e) &&
      typeof e.webhookId === "string" && e.webhookId.length > 0
    );
  });
  // Linear per-key secret resolved as webhook-config.ts:157-171 does: file →
  // per-key env (linearWebhookSecretEnv) → global CATALYST_LINEAR_WEBHOOK_SECRET.
  // The env leg uses the runtime's exact `??` chain, so an empty-string per-key
  // env var short-circuits (does NOT fall through to the global) — matching
  // resolveSecret, which returns "" and drops the key. CTL-1618.
  const keySecretWired = (k) =>
    secretFileNonEmpty(
      configDir,
      k === "workspace" ? "linear-webhook-secret" : `linear-webhook-secret-${k}`,
    ) ||
    (
      (linearSecretEnvName !== null ? process.env[linearSecretEnvName] : undefined) ??
      process.env.CATALYST_LINEAR_WEBHOOK_SECRET ??
      ""
    ).length > 0;
  const wiredKeys = webhookKeys.filter(keySecretWired);
  const danglingKeys = webhookKeys.filter((k) => !keySecretWired(k));
  const linearWired = linSmee.length > 0 && wiredKeys.length > 0;

  // ─── CTL-2030: the GitHub feed is the live route — grade IT ────────────────
  //
  // Placed before every smee-shaped branch below, because at `enforce` those
  // branches are reasoning about a route that is deliberately dead: they would
  // either PASS on retained rollback config (the live defect) or FAIL with
  // "NO webhook route enabled", which is equally wrong in the other direction.
  //
  // ⚠️ THE THREE OUTCOMES ARE KEPT APART ON PURPOSE. "the feed is delivering",
  // "the feed is NOT delivering", and "I could not observe the feed" are different
  // answers, and collapsing the third into either of the others is the failure this
  // whole ticket is about. An absent/unparseable/unstamped record means the producer
  // never wrote one OR doctor is looking in the wrong directory (CTL-1976 shipped
  // exactly that bug once) — that is INCONCLUSIVE, so it WARNs and names the path.
  // A record we CAN read that says stale/unready/wrong-mode is a real negative and
  // FAILs.
  if (feedIsLiveRoute) {
    // Config residue still fails, matching the declared-cloud branch's (a) rule: a
    // dangling Linear webhookId without its secret is residue no mode excuses.
    if (danglingKeys.length > 0) {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.FAIL,
          `multiHost member with half-wired Linear webhook(s): ${danglingKeys.join(", ")} configured (webhookId) but missing HMAC secret file (linear-webhook-secret-<key>) — GitHub feed at enforce does not excuse config residue`,
        ),
        ...webhookShadow,
      ];
    }
    const linTail = `linear(smee=${linSmee ? "set" : "unset"},wiredKeys=${wiredKeys.length})`;
    // INCONCLUSIVE: we could not observe the producer at all.
    if (feedReady.state === null) {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.WARN,
          `GitHub feed is the live route (CATALYST_GITHUB_FEED=enforce, source=${ghFeed.source}) and smee is inert${declaredTail}, but the producer's readiness could NOT be observed: ${feedReady.reason} at ${feedReady.path ?? "(unresolved path)"} — this is "could not look", not "ingestion is fine"; ${linTail}`,
        ),
        ...webhookShadow,
      ];
    }
    // ⛔ A FRESH RECORD WITH THE WRONG MODE READS HEALTHY UNLESS THIS IS CHECKED.
    // The producer stamps the mode it RESOLVED (`mode.effective`), which degrades to
    // shadow when enforce is not honourable. A host whose flag says enforce while its
    // producer runs as shadow emits markers, not events — and its heartbeat is
    // perfectly fresh the whole time.
    const producerMode = feedReady.state?.mode ?? null;
    if (feedReady.ready === true && producerMode !== "enforce") {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.FAIL,
          `GitHub feed readers DISAGREE${declaredTail}: this host's flag resolves "enforce" (source=${ghFeed.source}) but the producer's readiness record says mode="${producerMode ?? "absent"}" — smee is suppressed while the producer is not emitting real github.* names; ${linTail}`,
        ),
        ...webhookShadow,
      ];
    }
    if (feedReady.ready !== true) {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.FAIL,
          `GitHub ingestion is DOWN${declaredTail}: the feed is the live route (enforce, source=${ghFeed.source}), smee is suppressed, and the producer is not ready — ${feedReady.reason} (${feedReady.path ?? "path unresolved"}); monitor-merge, CI waits and PR-lifecycle routing have no github.* source; ${linTail}`,
        ),
        ...webhookShadow,
      ];
    }
    const rtCoverage = githubFeedCoverageFromReady(feedReady.state);
    if (rtCoverage === null) {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.WARN,
          `GitHub feed is live and the producer is ready (enforce, source=${ghFeed.source}), but its readiness record carries no runtime coverage — cannot confirm which consumed github.* names have a source; ${linTail}`,
        ),
        ...webhookShadow,
      ];
    }
    if (rtCoverage.uncovered.length > 0) {
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.WARN,
          `GitHub feed is live and ready (enforce, source=${ghFeed.source}) but covers ${rtCoverage.suppressible}/${rtCoverage.consumed} consumed github.* names — ${rtCoverage.uncovered.length} have NO source on this node: ${rtCoverage.uncovered.join(", ")}; ${linTail}`,
        ),
        ...webhookShadow,
      ];
    }
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.PASS,
        `GitHub ingestion via the cloud feed at enforce (source=${ghFeed.source})${declaredTail}, producer ready, covering all ${rtCoverage.consumed} consumed github.* names; smee is intentionally inert (rollback lever retained: smee=${ghSmee ? "set" : "unset"}, secret=${ghSecret ? "set" : "unset"}); ${linTail}`,
      ),
      ...webhookShadow,
    ];
  }

  if (!githubWired && !linearWired) {
    // Mode-alignment: a DECLARED (recognized, not inferred) non-cluster mode
    // means the join gate intentionally skipped wiring — no-route is the
    // correct state, and the mode/roster mismatch itself is graded by the
    // deployment-mode checks, not here. Everything else — declared cluster,
    // inferred/absent mode, or an unresolvable mode — keeps the FAIL: on a
    // declared-cluster node this FAIL is the intentional loud signal for a
    // missed activation step 2b (docs/cluster-onboarding.md), and a
    // pre-migration node must keep its original guarantee.
    if (
      declaredMode &&
      declaredMode.inferred === false &&
      declaredMode.recognized === true &&
      declaredMode.mode !== "cluster"
    ) {
      // #2918 follow-up (Codex P2 x2):
      // (a) The aligned grant applies only to a FULLY-ABSENT route — a
      //     dangling Linear webhookId without its HMAC secret is config
      //     residue and must keep the half-wired FAIL even here (this
      //     branch previously returned before the dangling check below).
      if (danglingKeys.length > 0) {
        return [
          mkCheck(
            "webhook-ingestion",
            STATUS.FAIL,
            `multiHost member with half-wired Linear webhook(s): ${danglingKeys.join(", ")} configured (webhookId) but missing HMAC secret file (linear-webhook-secret-<key>) — declared mode "${declaredMode.mode}" does not excuse config residue`,
          ),
          ...webhookShadow,
        ];
      }
      // (b) Declared CLOUD is a WARN, not a PASS: cloud suppresses the smee
      //     tunnels, and only ONE of the two routes has a replacement.
      //     CTL-1928: Linear ingestion IS replaced — the cloud feed
      //     (cloud-feed-timer.mjs, CATALYST_CLOUD_FEED) drives dispatch, and
      //     the workspace's Linear webhook subscriptions were retired
      //     fleet-wide. GitHub has NO cloud replacement: the cloud receives no
      //     GitHub webhooks at all, so a declared-cloud node cannot see the
      //     `github.*` events monitor-merge, CI waits, and the broker's
      //     PR-lifecycle routing consume. That gap is what keeps this a WARN;
      //     it flips to PASS when a real cloud GitHub-ingestion check exists.
      //     (Saying "no event ingestion at all" here would now be wrong, and
      //     wrong in the direction that sends an operator hunting a Linear
      //     outage that isn't there.)
      if (declaredMode.mode === "cloud") {
        // CTL-1929: the GitHub half of this WARN is no longer unconditional.
        //
        // ⛔ AND IT IS STILL NOT AN UNCONDITIONAL PASS. The GitHub feed at
        // `enforce` replaces smee for the names it COVERS — 9 of the 12 the broker
        // router consumes. `github.pr.merged` (CTC-691),
        // `github.check_suite.completed` (CTC-667 item 4) and `github.push`
        // (CTC-704) have no faithful replacement, so on a declared-cloud node —
        // which has no tunnel at all — those three are genuinely unseen. Reporting
        // PASS here would tell an operator the route is whole at exactly the moment
        // the merge→deploy join, the CI wait, and rebase detection are the parts
        // that are missing.
        //
        // ⚠️ The residual is read from the gate rather than restated, so this line
        // stops warning by itself when the gaps close instead of needing an edit
        // that nobody will remember to make.
        // ⛔ A THROWING RESOLVER GRADES AS "no cloud replacement", not as a pass.
        // Same fail-closed direction the deployment-mode resolver above takes: an
        // unreadable config must never be the reason doctor tells an operator the
        // GitHub route is whole.
        // ⛔ CTL-2030: THE `enforce` SUB-BRANCH THAT USED TO LIVE HERE IS GONE, NOT
        // MOVED-AND-DUPLICATED. The unified enforce branch near the top of this
        // function now answers for EVERY host whose feed is at enforce — cluster or
        // cloud — so anything written here for that case would be unreachable, and
        // unreachable grading code is how the static-vs-runtime comparison it
        // contained went unnoticed in the first place (its PASS could not be reached
        // by any input). Reaching this point means the feed is off or shadow.
        return [
          mkCheck(
            "webhook-ingestion",
            STATUS.WARN,
            `declared deployment mode "cloud" (source=${declaredMode.source}) — smee ingestion intentionally not wired; Linear ingestion is replaced by the cloud feed (CTL-1928), but GitHub ingestion has NO cloud replacement active (CATALYST_GITHUB_FEED=${ghFeed.mode}, source=${ghFeed.source}): this node cannot see github.* events (monitor-merge, CI waits, PR-lifecycle routing)`,
          ),
          ...webhookShadow,
        ];
      }
      return [
        mkCheck(
          "webhook-ingestion",
          STATUS.PASS,
          `declared deployment mode "${declaredMode.mode}" (source=${declaredMode.source}) — webhook ingestion intentionally not wired despite multiHost roster; the mode/roster mismatch is graded by the deployment-mode checks`,
        ),
        ...webhookShadow,
      ];
    }
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.FAIL,
        `multiHost member but NO webhook route enabled — github(smee=${ghSmee ? "set" : "unset"},secret=${ghSecret ? "set" : "unset"}) linear(smee=${linSmee ? "set" : "unset"},wiredKeys=${wiredKeys.length}); monitor-merge/comment-wakes will degrade to polling`,
      ),
      ...webhookShadow,
    ];
  }
  if (danglingKeys.length > 0) {
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.FAIL,
        `multiHost member with half-wired Linear webhook(s): ${danglingKeys.join(", ")} configured (webhookId) but missing HMAC secret file (linear-webhook-secret-<key>)`,
      ),
      ...webhookShadow,
    ];
  }
  return [
    mkCheck(
      "webhook-ingestion",
      STATUS.PASS,
      `webhook ingestion wired (github=${githubWired}, linear=${linearWired}, linear keys=${wiredKeys.length})`,
    ),
    ...webhookShadow,
  ];
}

// ─── Phase 5d: Thoughts provisioning (CTL-1293) ──────────────────────────────

// A cluster MEMBER is a full worker: research/learnings/handoffs must sync to
// peers via the HumanLayer thoughts repo. A half-provisioned thoughts layer
// strands silently — worse, a missing/legacy humanlayer.json falls back to a
// FOREIGN repo (groundworkapp / rightsite-cloud), polluting it with catalyst
// thoughts. This check gates severity on multiHost (a single-host node has no
// peers to sync to, so thoughts-push is not activation-gating — matches the
// webhook gate). On a multiHost member it FAILs loudly when humanlayer.json is
// absent, resolves to a foreign primary, has empty repoMappings (bg agents then
// fall back to a global/phantom repo), or the primary clone is missing.

function defaultReadHumanlayer() {
  try {
    const p = resolve(homedir(), ".config", "humanlayer", "humanlayer.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function defaultThoughtsCloneOk(dir) {
  try {
    if (!existsSync(resolve(dir, ".git"))) return false;
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "-q", "HEAD"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// A configured org is untrusted text going into a RegExp — escape it, or an org
// containing regex metacharacters would either throw or match too broadly. Matching is
// anchored to path-segment boundaries so "coalesce-labs" never matches the distinct org
// "coalesce-labs-fork".
function escapeThoughtsOrg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// defaultConfiguredThoughtsOrg — the GitHub owner THIS node's Layer-1 declares as its
// thoughts host: `catalyst.thoughts.org`, falling back to `catalyst.thoughts.profile`
// (a HumanLayer alias that only coincidentally equals the owner — the same loud
// fallback join-bundle.mjs and provision-thoughts.sh make). Returns "" when nothing is
// declared, which the gate treats as "cannot judge" rather than "wrong".
function defaultConfiguredThoughtsOrg() {
  try {
    const l1 = JSON.parse(readFileSync(resolveDoctorLayer1Path(), "utf8"));
    const t = l1?.catalyst?.thoughts;
    const v = t?.org ?? t?.profile ?? "";
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export function checkThoughts(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    readHumanlayer = defaultReadHumanlayer,
    cloneOk = defaultThoughtsCloneOk,
    configuredThoughtsOrg = defaultConfiguredThoughtsOrg,
  } = deps;

  const roster = resolveRoster();
  if (!roster?.multiHost) {
    return [
      mkCheck(
        "thoughts",
        STATUS.PASS,
        "single-host node — thoughts peer-sync not activation-gating",
      ),
    ];
  }

  const hl = readHumanlayer();
  const t = hl?.thoughts;
  if (!t || typeof t !== "object") {
    return [
      mkCheck(
        "thoughts",
        STATUS.FAIL,
        "~/.config/humanlayer/humanlayer.json absent or has no .thoughts — a member's research/learnings/handoffs won't sync",
      ),
    ];
  }

  const checks = [];
  const thoughtsRepo = typeof t.thoughtsRepo === "string" ? t.thoughtsRepo : "";
  const defaultProfile = typeof t.defaultProfile === "string" ? t.defaultProfile : "";

  // Pollution guard: the humanlayer primary must be the org THIS node configured, never
  // a foreign one. The bug this locks out (provision-thoughts-invariant.test.sh) is the
  // global thoughtsRepo fallback silently settling on somebody else's org.
  //
  // Codex #3080 P1: the org names were previously HARDCODED here — coalesce-labs PASS,
  // groundworkapp/rightsite-cloud FAIL — which is the very hardcoding this PR removes
  // from the provisioning path. A node that legitimately hosts its thoughts under
  // rightsite-cloud (the documented rightsite-cloud/adva layout) provisioned correctly
  // and was then FAILed here, so `catalyst-join.sh` aborted activation right after a
  // successful join. Judge against the CONFIGURED primary instead: same guard, no catalog.
  const wantOrg = configuredThoughtsOrg();
  const matchesWant =
    wantOrg !== "" &&
    (new RegExp(`(^|[/@:])${escapeThoughtsOrg(wantOrg)}(/|$)`, "i").test(thoughtsRepo) ||
      defaultProfile.toLowerCase() === wantOrg.toLowerCase());
  if (wantOrg === "") {
    // Nothing declared — we cannot say which org is "foreign", so do not guess.
    checks.push(
      mkCheck(
        "thoughts-primary",
        STATUS.WARN,
        `cannot verify humanlayer.json primary — no catalyst.thoughts.org/.profile in Layer-1 (thoughtsRepo="${thoughtsRepo}", defaultProfile="${defaultProfile}")`,
      ),
    );
  } else if (matchesWant) {
    checks.push(
      mkCheck("thoughts-primary", STATUS.PASS, `humanlayer.json primary = ${wantOrg} (as configured)`),
    );
  } else if (thoughtsRepo !== "" || defaultProfile !== "") {
    checks.push(
      mkCheck(
        "thoughts-primary",
        STATUS.FAIL,
        `humanlayer.json primary resolves to a FOREIGN org (thoughtsRepo="${thoughtsRepo}", defaultProfile="${defaultProfile}") — this node configures catalyst.thoughts.org="${wantOrg}"; pollutes the wrong repo`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "thoughts-primary",
        STATUS.WARN,
        `humanlayer.json primary unrecognized (thoughtsRepo="${thoughtsRepo}", defaultProfile="${defaultProfile}")`,
      ),
    );
  }

  // repoMappings non-empty — headless bg agents resolve their thoughts repo from
  // this map (no direnv); empty → global/phantom-repo fallback.
  const mappings = t.repoMappings;
  const mappingCount =
    mappings && typeof mappings === "object" && !Array.isArray(mappings)
      ? Object.keys(mappings).length
      : 0;
  checks.push(
    mappingCount > 0
      ? mkCheck("thoughts-repo-mappings", STATUS.PASS, `repoMappings present (${mappingCount})`)
      : mkCheck(
          "thoughts-repo-mappings",
          STATUS.FAIL,
          "humanlayer.json repoMappings empty — headless bg agents fall back to a global/phantom repo",
        ),
  );

  // Primary clone present (members keep it under ~/catalyst/hlt/<org>/thoughts;
  // the seed's embedded-clone layout doesn't, so scope this to the hlt/ layout).
  if (thoughtsRepo.includes("/hlt/")) {
    checks.push(
      cloneOk(thoughtsRepo)
        ? mkCheck("thoughts-clone", STATUS.PASS, "primary thoughts clone present with a valid HEAD")
        : mkCheck(
            "thoughts-clone",
            STATUS.FAIL,
            `primary thoughts clone missing or corrupt at ${thoughtsRepo} — read-only/partial strand`,
          ),
    );
  }

  return checks;
}

// ─── Phase 5e: Claude settings.json (CTL-1231) ───────────────────────────────

// catalyst-join never wrote ~/.claude/settings.json, so a member's interactive
// `claude` sessions lacked the OTLP endpoint + telemetry toggles, and — worse —
// the per-host OTEL_RESOURCE_ATTRIBUTES host.name pin was unset, so telemetry
// mis-attributed the host. This check (multiHost-gated, like the others) FAILs a
// member whose settings.json is absent, doesn't pin host.name=<self>, or has no
// OTLP endpoint in EITHER settings.json or the daemon env file (the latter is
// what the launchd daemon + bg-workers actually read).

function defaultReadClaudeSettings() {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), ".claude", "settings.json"), "utf8"));
  } catch {
    return null;
  }
}

function defaultDaemonEnvHasOtlp() {
  try {
    const txt = readFileSync(resolve(homedir(), ".config", "catalyst", "execution-core.env"), "utf8");
    return /^OTEL_EXPORTER_OTLP_ENDPOINT=.+/m.test(txt);
  } catch {
    return false;
  }
}

export function checkClaudeSettings(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    readSettings = defaultReadClaudeSettings,
    getHost = getHostName,
    daemonEnvHasOtlp = defaultDaemonEnvHasOtlp,
  } = deps;

  const roster = resolveRoster();
  if (!roster?.multiHost) {
    return [
      mkCheck(
        "claude-settings",
        STATUS.PASS,
        "single-host node — settings.json provisioning not activation-gating",
      ),
    ];
  }

  const s = readSettings();
  if (!s || typeof s !== "object") {
    return [
      mkCheck(
        "claude-settings",
        STATUS.FAIL,
        "~/.claude/settings.json absent or unparseable — telemetry + host identity unset for interactive sessions",
      ),
    ];
  }

  const checks = [];
  const self = getHost();
  const ra = s?.env?.OTEL_RESOURCE_ATTRIBUTES ?? "";
  checks.push(
    typeof ra === "string" && ra.includes(`host.name=${self}`)
      ? mkCheck("claude-settings-host", STATUS.PASS, `settings.json pins host.name=${self}`)
      : mkCheck(
          "claude-settings-host",
          STATUS.FAIL,
          `settings.json OTEL_RESOURCE_ATTRIBUTES does not pin host.name=${self} (got "${ra}") — telemetry mis-attributes this host`,
        ),
  );

  const settingsOtlp = s?.env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
  const hasOtlp = (typeof settingsOtlp === "string" && settingsOtlp.length > 0) || daemonEnvHasOtlp();
  checks.push(
    hasOtlp
      ? mkCheck("claude-settings-otlp", STATUS.PASS, "OTLP endpoint set (settings.json or daemon env file)")
      : mkCheck(
          "claude-settings-otlp",
          STATUS.FAIL,
          "OTLP endpoint unset in BOTH settings.json and execution-core.env — daemon + worker telemetry exports nowhere",
        ),
  );

  return checks;
}

// ─── Phase 5f: SDK-executor subscription auth (CTL-1367 item 9) ──────────────

// checkSdkExecutorAuth — when the phase-worker executor resolves to "sdk", the
// in-process Agent SDK worker MUST authenticate via the subscription OAuth token
// ONLY. A set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) would silently METER in
// headless mode; a missing CLAUDE_CODE_OAUTH_TOKEN leaves nothing to authenticate
// the subscription. This FAILs (the daemon also boot-asserts + dispatch-asserts,
// but doctor surfaces it before activation). For executor=bg/oneshot-legacy the
// check is an INFO no-op (the api-key path is fine for bg). Injectable for tests.
export function checkSdkExecutorAuth(deps = {}) {
  const {
    // CTL-1367 P2-I: resolve the executor from the repo Layer-1 config path the SAME
    // way the daemon does (getExecutor(configPath) at boot). Without the path, a
    // committed executor=sdk with CATALYST_EXECUTOR unset resolved to the node-class
    // default "bg" here, so the doctor gate reported N/A while the daemon ran sdk —
    // masking a missing/conflicting subscription token. configPath is injectable for
    // tests; a test passing an explicit `executor` overrides resolution entirely.
    configPath = layer1Path(),
    executor = getExecutor(configPath),
    env = process.env,
    assertAuth = assertSdkAuth,
  } = deps;

  if (executor !== "sdk") {
    return [
      mkCheck(
        "sdk-executor-auth",
        STATUS.INFO,
        `executor="${executor}" — subscription-auth gate not applicable (only enforced under executor=sdk)`,
      ),
    ];
  }

  const auth = assertAuth({ env, oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN });
  if (!auth.ok) {
    return [
      mkCheck(
        "sdk-executor-auth",
        STATUS.FAIL,
        `executor=sdk but the subscription-auth precondition fails: ${auth.reason}`,
      ),
    ];
  }
  return [
    mkCheck(
      "sdk-executor-auth",
      STATUS.PASS,
      "executor=sdk and subscription auth is correct (CLAUDE_CODE_OAUTH_TOKEN set, no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN)",
    ),
  ];
}

// defaultReadDaemonProcEnv — read the RUNNING exec-core daemon's process env via
// `ps eww <pid>` (the BSD/macOS spelling that appends the process environment
// after the command). Returns the raw `ps` stdout (which DOES contain secret
// values) or null when the pid is dead / not ours / ps fails. The CALLER must
// only ever extract booleans from this — never surface the raw text or any token
// VALUE (see checkSdkDaemonEnv). Injectable in tests so nothing shells out.
function defaultReadDaemonProcEnv(pid) {
  try {
    const r = spawnSync("ps", ["eww", String(pid)], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

// defaultExecCoreEnvPath / parseEnvFileExecutor — CTL-1396 Codex P2 (detect SDK when
// only the daemon env enables it). The launcher (`catalyst-execution-core`) sources
// the machine-local execution-core.env — which carries the `CATALYST_EXECUTOR` lever —
// BEFORE the daemon resolves its executor, so that FILE is the daemon's effective
// lever even when the operator's doctor shell never exported CATALYST_EXECUTOR. We
// resolve the daemon's executor from it so the gate is not falsely skipped as
// "not applicable" on a node flipped to sdk purely via the env file.
function defaultExecCoreEnvPath() {
  return (
    process.env.CATALYST_EXECUTION_CORE_ENV ||
    resolve(homedir(), ".config", "catalyst", "execution-core.env")
  );
}
function parseEnvFileExecutor(text) {
  if (typeof text !== "string" || !text) return null;
  const m = text.match(/^\s*(?:export\s+)?CATALYST_EXECUTOR=["']?([^"'\s]+)/m);
  return m ? m[1] : null;
}

// procIsDaemon — CTL-1396 Codex P2 (verify the pid belongs to the daemon). A stale
// pid-file whose pid was reused by ANY other live process would otherwise have its
// `ps eww` output parsed as the exec-core daemon's env (false PASS if it happens to
// carry CLAUDE_CODE_OAUTH_TOKEN, false FAIL against a healthy daemon at a different
// pid). The daemon is launched as `node …/daemon.mjs --pid-file <pidFilePath>`, so a
// reused pid won't carry BOTH markers. (ps output is argv only; never env on macOS.)
function procIsDaemon(psText, pidFilePath) {
  return /(?:^|\s|\/)daemon\.mjs(?:\s|$)/.test(psText) && psText.includes(`--pid-file ${pidFilePath}`);
}

// monthlyLogPath — the `.../events/YYYY-MM.jsonl` sibling for a given Date's UTC
// month. Used to also scan the PREVIOUS month's log when the 24h recent-window
// cutoff crosses a UTC month boundary (Codex P2: a fallback written just before the
// boundary is still inside 24h but lives in last month's file).
function monthlyLogPath(eventsDir, date) {
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return resolve(eventsDir, `${ym}.jsonl`);
}

// scanRecentBgFallback — CTL-1396 item A (3): the daemon-boot auth gate
// (resolveSdkBootExecutor) emits `execution-core.executor.bg-fallback` to the
// unified event log when executor=sdk but the daemon's own env fails the
// subscription-auth precondition (token missing OR ANTHROPIC_API_KEY set) — it
// then silently degrades the WHOLE boot to bg. This is the AUTHORITATIVE,
// platform-portable SDK-auth health signal: it is the daemon's own self-report, so
// it works on macOS where the process-env probe cannot read another process's env.
// Scans every supplied monthly log path (current + prior month near a boundary).
// All reads are injectable + fail-open (a missing/unreadable log → no degrade
// observed, never throws). Returns a single Check.
// CTL-1529: `scan` replaces the old whole-file `readEventLog(p) -> string` seam.
// The default is a bounded, TIME-covering tail — a natural fit here because this
// check already has a window (`recentWindowMs`, 24h) and a `cutoff`. The old
// default read the current AND prior monthly log in full (up to ~1.7 GB of string
// near a month boundary on mini) and, on a node runtime, threw ERR_STRING_TOO_LONG
// straight into the `catch` below — which reports "no degrades observed" and
// returns PASS. That made a fail-CLOSED node-activation gate fail OPEN on the very
// signal it calls authoritative. Bounding the read removes that failure mode.
// checkSdkDaemonEnv still accepts the legacy string seam for existing tests.
//
// CTL-1529 (Codex P1): the `scan` seam RETURNS ITS COVERAGE VERDICT and this
// function honors it. Bounding the read fixed the ERR_STRING_TOO_LONG fail-open
// but introduced a quieter one in its place: when more than the byte cap of
// events falls inside the 24h lookback, scanEventsSince reports `covered:false`
// and every bg-fallback event beyond the truncated tail is invisible — so the
// AUTHORITATIVE self-report check would answer PASS from data it never read. On
// macOS the process-env probe deliberately defers to this signal (`ps eww` cannot
// read another process's env), so an unhealthy node would read healthy end to end.
//
// A health check that reports PASS on incomplete data is worse than one that
// errors, so an uncovered window can never produce PASS. It resolves to WARN —
// the severity this file already uses for every "can't verify" state (no pid-file,
// stale pid, reused pid) — with the truncation named explicitly in the detail.
// PASS now means what it says: the whole window was read and it was clean.
function scanRecentBgFallback({ paths, scan, now, recentWindowMs }) {
  const cutoff = now() - recentWindowMs;
  const hours = Math.round(recentWindowMs / 3_600_000);
  let recent = 0;
  let latestTs = null;
  const truncated = [];
  for (const p of paths) {
    const events = [];
    let res;
    try {
      res = scan({ path: p, sinceMs: cutoff, onEvent: (e) => events.push(e) });
    } catch {
      // absent/unreadable → treat as "no degrades observed" (fail-open)
    }
    // ONLY an explicit `covered:false` means "the window was truncated". A seam
    // that returns nothing (a bespoke test scanner) is treated as covered, which
    // is what it was before this verdict existed; the production default and the
    // legacy string wrapper both return a real verdict.
    if (res && res.covered === false) {
      truncated.push(
        `${p} (scanned ${res.windowBytes ?? "?"}B of ${res.size ?? "?"}B; oldest record ${res.oldestTs ?? "none"})`,
      );
    }
    for (const evt of events) {
      if (evt?.attributes?.["event.name"] !== "execution-core.executor.bg-fallback") continue;
      const t = Date.parse(evt?.ts ?? evt?.observedTs ?? "");
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) {
        recent++;
        if (latestTs === null || t > latestTs) latestTs = t;
      }
    }
  }
  // A degrade that IS visible is reported even from a truncated window — the
  // truncation can only have hidden more of them, never invented this one.
  if (recent > 0) {
    return mkCheck(
      "sdk-bg-fallback",
      STATUS.WARN,
      `executor=sdk but ${recent} execution-core.executor.bg-fallback event(s) in the last ${hours}h — ` +
        `the daemon silently degraded sdk→bg at boot (most recent ${new Date(latestTs).toISOString()}); ` +
        `fix the daemon's auth env (CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY) and restart` +
        (truncated.length
          ? ` [count is a LOWER BOUND — the bounded event-log tail did not span the full ${hours}h: ${truncated.join("; ")}]`
          : ""),
    );
  }
  if (truncated.length) {
    return mkCheck(
      "sdk-bg-fallback",
      STATUS.WARN,
      `UNKNOWN, not clean: the bounded event-log tail could not span the full ${hours}h lookback, so ` +
        `execution-core.executor.bg-fallback events older than the truncation point were never read — ` +
        `${truncated.join("; ")}. This check is the authoritative sdk→bg self-report (the process-env ` +
        `probe defers to it on macOS), so it reports UNKNOWN rather than PASS on incomplete data. ` +
        `Rotate/shrink the monthly event log, or confirm sdk auth directly on the daemon ` +
        `(CLAUDE_CODE_OAUTH_TOKEN set, no ANTHROPIC_API_KEY)`,
    );
  }
  return mkCheck(
    "sdk-bg-fallback",
    STATUS.PASS,
    `no recent execution-core.executor.bg-fallback events (sdk did not silently degrade to bg in the last ${hours}h)`,
  );
}

// checkSdkDaemonEnv — CTL-1396 item A. checkSdkExecutorAuth verifies the OPERATOR
// SHELL env, but the RUNNING daemon arms CLAUDE_CODE_OAUTH_TOKEN only on a restart
// that inherited the token — so doctor can PASS while the live daemon has
// token-in-env=0 and silently degraded sdk→bg. A reinstalled/flipped node then
// looks healthy but isn't. This check closes that gap.
//
// SIGNAL HIERARCHY (Codex P2 re-review): the AUTHORITATIVE, platform-portable health
// signal is the daemon's own `execution-core.executor.bg-fallback` self-report
// (section 2) — because `ps eww` CANNOT read another process's env on macOS
// (proc-reaper.mjs: "macOS env-read is DEAD"), and the fleet is launchd/macOS-heavy.
// The process-env probe (section 1) is therefore a best-effort SECONDARY check that
// runs only where it works and NEVER hard-FAILs a healthy node on a platform where
// the env is unreadable.
//
// Only bites under executor=sdk (INFO no-op otherwise). The daemon's executor is
// resolved from the daemon's OWN levers: execution-core.env's CATALYST_EXECUTOR
// (which the launcher sources) → Layer-1 → class default — not just the operator's
// doctor shell (Codex P2).
//
// Severities (the running-daemon env probe, section 1):
//   • executor != sdk                              → INFO  (not applicable)
//   • no pid-file / unparseable pid                → WARN  (daemon not running; can't verify)
//   • macOS (env unreadable)                        → INFO  (defer to the self-report)
//   • pid present but process not found             → WARN  (stale pid; can't verify)
//   • pid alive but not the daemon (reused pid)     → WARN  (can't verify; defer to self-report)
//   • daemon alive, NO CLAUDE_CODE_OAUTH_TOKEN       → FAIL  (sdk degrades to bg)
//   • daemon alive, token + conflicting ANTHROPIC_*  → FAIL  (sdk refuses sub auth → bg)
//   • daemon alive, token, no ANTHROPIC_*, EXEC=sdk  → PASS
//   • daemon alive, token, CATALYST_EXECUTOR != sdk  → WARN  (can't confirm sdk)
// Plus the authoritative `sdk-bg-fallback` self-report check (section 2).
//
// SECURITY: the token VALUE is NEVER printed or returned — only a boolean "present".
//
// All external access is an INJECTABLE SEAM with a real default so tests never shell
// out or touch the real daemon.
export function checkSdkDaemonEnv(deps = {}) {
  const {
    configPath = layer1Path(),
    // Explicit override (test seam); undefined → resolve from the daemon's levers below.
    executor,
    // The machine-local daemon env file the launcher sources (CATALYST_EXECUTOR lever).
    execCoreEnvPath = defaultExecCoreEnvPath(),
    readEnvFile = (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
    // The daemon is launched with `--pid-file <orchDir>/daemon.pid`.
    pidFilePath = resolve(getExecutionCoreDir(), "daemon.pid"),
    readPidFile = (p) => readFileSync(p, "utf8"),
    // (pid) => raw `ps eww` argv+env text | null. Default reads the real process; tests
    // inject a synthetic string and never shell out. On macOS this carries argv only.
    readProcEnv = defaultReadDaemonProcEnv,
    // `ps eww` cannot read another process's env on macOS — so on darwin the proc-env
    // probe is unverifiable and we defer to the self-report. Injectable for tests.
    platform = process.platform,
    // Recent sdk→bg silent-degrade scan over the unified event log (current + prior month).
    eventsDir = dirname(getEventLogPath()),
    // CTL-1529: legacy whole-string seam, kept ONLY for existing tests that inject
    // a synthetic log body. Undefined in production, where the bounded `scanEventLog`
    // default below is used instead.
    readEventLog = undefined,
    // CTL-1529: the bounded event-log scan seam (see scanRecentBgFallback).
    scanEventLog = undefined,
    // CTL-1529: tuning passed through to the PRODUCTION bounded scan
    // (maxBytes/chunkSize/initialWindow). Exists so a test can drive the real
    // default seam into cap exhaustion against a small fixture and assert the
    // coverage verdict survives the trip back out — the discard this Codex P1
    // fix is about. Empty in production.
    eventLogScanOpts = {},
    now = () => Date.now(),
    recentWindowMs = 24 * 60 * 60 * 1000, // 24h
  } = deps;

  // Resolve the executor the daemon actually runs under (env file → Layer-1 → default),
  // NOT just the operator's doctor shell.
  const resolvedExecutor =
    executor ?? parseEnvFileExecutor(readEnvFile(execCoreEnvPath)) ?? getExecutor(configPath);

  if (resolvedExecutor !== "sdk") {
    return [
      mkCheck(
        "sdk-daemon-env",
        STATUS.INFO,
        `executor="${resolvedExecutor}" — running-daemon SDK-env gate not applicable (only enforced under executor=sdk)`,
      ),
    ];
  }

  const checks = [];

  // ── (1) RUNNING-daemon process env (best-effort SECONDARY; never the macOS verdict) ──
  let pid = null;
  try {
    pid = parseInt(String(readPidFile(pidFilePath)).trim(), 10);
  } catch {
    pid = null; // pid-file absent/unreadable
  }

  if (!pid || Number.isNaN(pid)) {
    checks.push(
      mkCheck(
        "sdk-daemon-env",
        STATUS.WARN,
        `executor=sdk but no live exec-core daemon pid-file at ${pidFilePath} — cannot verify the ` +
          `RUNNING daemon's SDK auth env (start the daemon, then re-run doctor)`,
      ),
    );
  } else if (platform === "darwin") {
    // macOS env-read is DEAD: `ps eww` strips env, so a token-absence here is a false
    // negative. Do NOT FAIL a healthy SDK node — defer to the bg-fallback self-report.
    checks.push(
      mkCheck(
        "sdk-daemon-env",
        STATUS.INFO,
        `executor=sdk; the RUNNING daemon's process env cannot be read on macOS (ps eww strips env) — ` +
          `SDK auth health is determined by the execution-core.executor.bg-fallback self-report below (pid ${pid})`,
      ),
    );
  } else {
    let envText = null;
    try {
      envText = readProcEnv(pid);
    } catch {
      envText = null;
    }
    if (!envText) {
      checks.push(
        mkCheck(
          "sdk-daemon-env",
          STATUS.WARN,
          `executor=sdk but the exec-core daemon process (pid ${pid}) was not found — the pid-file is ` +
            `stale; cannot verify its SDK auth env (restart the daemon)`,
        ),
      );
    } else if (!procIsDaemon(envText, pidFilePath)) {
      checks.push(
        mkCheck(
          "sdk-daemon-env",
          STATUS.WARN,
          `executor=sdk but pid ${pid} does not look like the exec-core daemon (its command line does not ` +
            `reference daemon.mjs --pid-file ${pidFilePath}) — likely a stale pid reused by another process; ` +
            `cannot verify the SDK auth env (restart the daemon), relying on the bg-fallback self-report below`,
        ),
      );
    } else {
      // Presence-only parse — NEVER capture/return the token VALUE. `\S` after the
      // `=` confirms a non-empty value without binding it.
      const hasToken = /(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN=\S/.test(envText);
      const hasApiKey =
        /(?:^|\s)ANTHROPIC_API_KEY=\S/.test(envText) || /(?:^|\s)ANTHROPIC_AUTH_TOKEN=\S/.test(envText);
      const execMatch = envText.match(/(?:^|\s)CATALYST_EXECUTOR=(\S+)/);
      const execEnv = execMatch ? execMatch[1] : null;
      if (!hasToken) {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.FAIL,
            `executor=sdk but the RUNNING exec-core daemon (pid ${pid}) has NO CLAUDE_CODE_OAUTH_TOKEN ` +
              `in its process env — SDK auth will silently degrade to bg (the daemon did not inherit ` +
              `the subscription token; restart it from a shell that exports it)`,
          ),
        );
      } else if (hasApiKey) {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.FAIL,
            `executor=sdk and the RUNNING exec-core daemon (pid ${pid}) carries CLAUDE_CODE_OAUTH_TOKEN but ` +
              `ALSO has ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN set — assertSdkAuth refuses subscription auth ` +
              `and the boot gate degrades sdk→bg; unset the ANTHROPIC_* vars and restart`,
          ),
        );
      } else if (execEnv === "sdk") {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.PASS,
            `the RUNNING exec-core daemon (pid ${pid}) carries CLAUDE_CODE_OAUTH_TOKEN and CATALYST_EXECUTOR=sdk ` +
              `with no conflicting ANTHROPIC_* vars`,
          ),
        );
      } else {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.WARN,
            `the RUNNING exec-core daemon (pid ${pid}) carries CLAUDE_CODE_OAUTH_TOKEN but its env does ` +
              `not advertise CATALYST_EXECUTOR=sdk (CATALYST_EXECUTOR=${execEnv ?? "<unset>"}) — it may ` +
              `have resolved sdk from Layer-1, or may be running bg; restart with CATALYST_EXECUTOR=sdk to confirm`,
          ),
        );
      }
    }
  }

  // ── (2) recent silent sdk→bg degrades from the unified event log (AUTHORITATIVE) ──
  // Scan the current month AND the previous month when the 24h cutoff crosses a UTC
  // month boundary, so a degrade written just before the boundary is not missed.
  const paths = [monthlyLogPath(eventsDir, new Date(now()))];
  const prev = monthlyLogPath(eventsDir, new Date(now() - recentWindowMs));
  if (prev !== paths[0]) paths.push(prev);
  // CTL-1529: resolve the scan seam. Explicit scanEventLog > legacy string seam
  // (tests) > the bounded time-covering tail (production).
  //
  // EVERY seam returns a COVERAGE VERDICT `{ covered, windowBytes, size, oldestTs }`
  // (Codex P1). scanRecentBgFallback refuses to answer PASS when `covered` is false,
  // so the verdict must not be dropped on the way out of the seam — that discard is
  // exactly the defect: `covered` was computed correctly and then thrown away, and
  // the check reported PASS over events it had never read.
  const scan =
    scanEventLog ??
    (readEventLog
      ? ({ path, onEvent }) => {
          for (const line of String(readEventLog(path) ?? "").split("\n")) {
            const s = line.trim();
            if (!s) continue;
            try {
              onEvent(JSON.parse(s));
            } catch {
              /* tolerate partial/corrupt lines */
            }
          }
          // The legacy seam hands back the WHOLE file body, so its window is the
          // whole file by construction — always covered.
          return { covered: true, reachedBof: true, oldestTs: null, windowBytes: 0, size: 0 };
        }
      : ({ path, sinceMs, onEvent }) =>
          // maxBytes is the DEFAULT_TAIL_MAX_BYTES 64 MiB cap: ~34 MB/day on the
          // fleet's busiest host, so a 24h lookback normally fits with ~2x headroom
          // and `covered` comes back true. When a burst blows past it the verdict
          // says so and the check degrades to WARN/UNKNOWN instead of PASS.
          scanEventsSince({
            path,
            targetSinceMs: sinceMs,
            lineFilter: (line) => line.includes("execution-core.executor.bg-fallback"),
            onEvent,
            ...eventLogScanOpts,
          }));
  checks.push(scanRecentBgFallback({ paths, scan, now, recentWindowMs }));

  return checks;
}

// ─── Phase 6: Renderer, exit code, runDoctor ─────────────────────────────────

// summarize — aggregate check results into counts.
export function summarize(checks) {
  let pass = 0, warn = 0, fail = 0;
  for (const c of checks) {
    if (c.status === STATUS.PASS) pass++;
    else if (c.status === STATUS.WARN) warn++;
    else if (c.status === STATUS.FAIL) fail++;
  }
  return { pass, warn, fail, ok: fail === 0 };
}

// renderJson — serialize checks + meta to JSON.
export function renderJson(checks, meta = {}) {
  const { pass, warn, fail, ok } = summarize(checks);
  return JSON.stringify({ ok, counts: { pass, warn, fail }, checks, ...meta }, null, 2);
}

// renderHuman — human-readable report with status prefix per line.
export function renderHuman(checks, meta = {}) {
  const PREFIX = {
    [STATUS.PASS]: "PASS",
    [STATUS.WARN]: "WARN",
    [STATUS.FAIL]: "FAIL",
    [STATUS.INFO]: "INFO",
  };
  const lines = checks.map((c) => `  [${PREFIX[c.status] ?? c.status}] ${c.name}: ${c.detail}`);
  const { pass, warn, fail, ok } = summarize(checks);
  const summary = ok
    ? `catalyst doctor: all checks passed (${pass} pass, ${warn} warn, 0 fail)`
    : `catalyst doctor: ${fail} check(s) FAILED (${pass} pass, ${warn} warn, ${fail} fail)`;
  return [summary, ...lines].join("\n");
}

const USAGE = `Usage: catalyst doctor [options]

Run a suite of read-only checks before activating a new cluster node.
Exit code equals the number of FAIL-level checks (0 = safe to activate).

Options:
  --json                      Emit machine-readable JSON ({ok, counts, checks[]})
  --profile <activation|install>  activation (default — the full class rubric) | install
                              (the focused post-install verification: node-class + agent-set +
                              pull-owner, fail-closed). 'catalyst install' runs --profile install.
  --install                   Shorthand for --profile install
  --dry-run                   No-op flag (all checks are already read-only)
  --expected-bot-user-id <id> Assert that the configured token belongs to <id>
  --help, -h                  Print this help and exit 0
`;

// parseArgs — parse CLI arguments for the doctor command.
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let json = false;
  let expectedBotUserId = null;
  let help = false;
  // CTL-1369 PR4: "activation" (default) | "install" (the post-install verification subset).
  let profile = "activation";
  // --dry-run is the default behavior (no separate code path); accept it silently
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--dry-run") { /* default behavior; no-op */ }
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--install") profile = "install";
    else if (a === "--profile") {
      const v = args[++i];
      // Only the two recognized profiles take effect; an unknown/missing value leaves the default
      // "activation" (a typo must never silently weaken the gate to a smaller suite).
      if (v === "install" || v === "activation") profile = v;
    } else if (a === "--expected-bot-user-id") {
      expectedBotUserId = args[++i] ?? null;
    }
  }
  return { json, expectedBotUserId, help, profile };
}

// defaultReaperState — load state + last exit of the orphan-sweep LaunchAgent.
// `launchctl list <label>` exits 0 and prints a dict containing
// `"LastExitStatus" = N;` only when launchd has the job loaded; a non-zero exit
// means launchd never loaded it (plist on disk but not bootstrapped).
// Returns { loaded, lastExit }:
//   • launchctl status 0 → loaded:true; lastExit = N (null if never run yet)
//   • launchctl status !=0 → loaded:false, lastExit:null
function defaultReaperState() {
  try {
    const r = spawnSync("launchctl", ["list", "ai.coalesce.catalyst-orphan-sweep"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return { loaded: false, lastExit: null };
    const m = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    return { loaded: true, lastExit: m ? parseInt(m[1], 10) : null };
  } catch {
    return { loaded: false, lastExit: null };
  }
}

// checkReaper (CTL-1306) — the orphan-sweep worktree/cache reaper (CTL-1030) must
// be installed, LOADED by launchd, and its baked program path must still exist.
// The original regression baked an ephemeral worktree path that was later
// deleted, so the LaunchAgent exit-127'd silently every interval for days while
// debris piled up. This check surfaces that — but every non-healthy condition is
// a WARN, never a FAIL: catalyst-doctor's exit code is the count of FAILs and
// gates the catalyst-join activation gate (do_doctor_gate runs BEFORE
// install-services, which is exactly what would reinstall a stale plist). A
// FAILing reaper check would therefore BLOCK a node from self-healing via join.
// Severities:
//   • plist absent            → WARN  (reaper not installed; debris won't be reaped)
//   • no baked path in plist   → WARN  (malformed plist)
//   • baked path missing       → WARN  (the silent-death signature; reinstall)
//   • plist present, not loaded → WARN  (launchd never bootstrapped it)
//   • last exit 127            → WARN  (program path unresolved; reinstall)
//   • other non-zero exit      → WARN  (check the log)
//   • loaded + exit 0 or null  → PASS  (null = never run yet)
export function checkReaper(deps = {}) {
  const {
    plistPath = resolve(
      homedir(), "Library", "LaunchAgents", "ai.coalesce.catalyst-orphan-sweep.plist",
    ),
    readFile = (p) => readFileSync(p, "utf8"),
    fileExists = (p) => existsSync(p),
    reaperState = defaultReaperState,
  } = deps;
  const checks = [];

  let xml;
  try {
    xml = readFile(plistPath);
  } catch {
    checks.push(mkCheck(
      "reaper-installed", STATUS.WARN,
      "orphan-sweep reaper not installed — worktree/cache debris won't be reclaimed; run 'catalyst-stack install-services'",
    ));
    return checks;
  }

  const m = xml.match(/<string>([^<]*orphan-sweep\.sh)<\/string>/);
  const baked = m ? decodePlistString(m[1]) : null;
  if (!baked) {
    checks.push(mkCheck(
      "reaper-installed", STATUS.WARN,
      `reaper plist present but no orphan-sweep.sh program path found in ${plistPath}`,
    ));
    return checks;
  }

  if (!fileExists(baked)) {
    checks.push(mkCheck(
      "reaper-path", STATUS.WARN,
      `reaper points at a path that no longer exists (CTL-1306 silent-death signature): ${baked} — reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  const { loaded, lastExit } = reaperState();
  if (!loaded) {
    checks.push(mkCheck(
      "reaper-loaded", STATUS.WARN,
      "reaper plist present but not loaded by launchd — run 'catalyst-stack install-services'",
    ));
    return checks;
  }

  if (lastExit === 127) {
    checks.push(mkCheck(
      "reaper-health", STATUS.WARN,
      "reaper last exited 127 (program path unresolved) — reinstall from the pristine clone",
    ));
  } else if (typeof lastExit === "number" && lastExit !== 0) {
    checks.push(mkCheck(
      "reaper-health", STATUS.WARN,
      `reaper last exited ${lastExit} — check ~/catalyst/orphan-sweep.log`,
    ));
  } else {
    // lastExit === 0 (clean) or null (loaded but never run yet)
    checks.push(mkCheck("reaper-health", STATUS.PASS, `reaper installed and healthy (${baked})`));
  }
  return checks;
}

// defaultResponderState — load state + last exit of the health-responder
// LaunchAgent. Same launchctl contract as defaultReaperState: `launchctl list
// <label>` exits 0 and prints a dict containing `"LastExitStatus" = N;` only
// when launchd has the job loaded; non-zero means never bootstrapped.
function defaultResponderState() {
  try {
    const r = spawnSync("launchctl", ["list", "ai.coalesce.catalyst-health-responder"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return { loaded: false, lastExit: null };
    const m = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    return { loaded: true, lastExit: m ? parseInt(m[1], 10) : null };
  } catch {
    return { loaded: false, lastExit: null };
  }
}

// defaultResponderLogMtimeMs — mtime (ms) of the responder heartbeat log, or
// null when missing/unreadable/EMPTY. catalystDir, when given, is the value
// baked into the installed plist (Codex P2 round 2: the caller's own
// process.env.CATALYST_DIR is a transient invocation detail — a doctor run
// without that env set would check the wrong path on a nondefault-CATALYST_DIR
// node even though the plist correctly persists it, CTL-1510 item 1). A
// zero-byte log is treated the SAME as missing (Codex P2 round 2): the
// log-shipper pre-create fix (item 7) touches a placeholder file with a fresh
// mtime for any tailed log that doesn't yet exist, and that placeholder must
// not read as "a sweep just dispatched" when no sweep ever has.
// Generous upper bound on how long a SINGLE sweep can legitimately run before
// its heartbeat — used only to distinguish "a sweep is currently in
// progress" from "a sweep died leaving stale diagnostics forever" (Codex P2
// round 5). Doctor has no visibility into the responder's own bounded-
// subprocess timeout env overrides (RESPONDER_LIST_TIMEOUT_SECS,
// RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS, RESPONDER_KICKSTART_TIMEOUT_SECS,
// RESPONDER_KICKSTART_WAIT_SECS) — unlike StartInterval, they aren't baked
// into the plist, so this can't be truly DERIVED from the installed config
// without a larger design change (persisting them there too). Widened to 5
// minutes (round 6, Codex P2: 120s was tight enough that a legitimately
// configured — if unusual — combination of those overrides could exceed it
// and false-WARN on a still-running sweep) — comfortably covers any
// realistic override combination while staying far below the staleAfterMs
// dispatch-warning threshold (>=900s), so it can never mask a truly wedged
// responder.
const RESPONDER_IN_PROGRESS_GRACE_MS = 300_000;

// Tolerance for the future-timestamp rejection below — see its call sites.
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

function defaultResponderLogMtimeMs(catalystDir, nowMsFn = () => Date.now()) {
  try {
    const dir = catalystDir || process.env.CATALYST_DIR || resolve(homedir(), "catalyst");
    const p = resolve(dir, "health-responder.log");
    const st = statSync(p);
    if (st.size === 0) return null;
    // Require the log's LAST line to be a completed `heartbeat status=`
    // record (Codex P2 round 4, tightening round 3's content-only check): an
    // append-only log can already hold an OLD heartbeat when a LATER sweep
    // writes a diagnostic and dies before reaching heartbeat() — a bare
    // substring match anywhere in the file still finds that old heartbeat,
    // so mtime (bumped by the diagnostic write) would report "fresh" even
    // though no sweep has completed since.
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last && /\bheartbeat status=/.test(last)) return st.mtimeMs;
    // The trailing line isn't a completed heartbeat — EITHER a sweep is
    // currently mid-run (wrote a diagnostic, heartbeat still pending — the
    // NORMAL shape while it's inside the launchctl-timeout/kickstart/settle
    // path) OR a sweep died leaving that diagnostic as a permanent tail
    // (Codex P2 round 5: requiring the last line to ALWAYS be a heartbeat
    // false-WARNs on every in-progress sweep). Distinguish by the RECENCY of
    // that write: within the generous in-progress grace window, trust it as
    // "still running, not stale" — outside it, nothing has completed since,
    // genuinely stale.
    if (nowMsFn() - st.mtimeMs <= RESPONDER_IN_PROGRESS_GRACE_MS) return st.mtimeMs;
    return null;
  } catch {
    return null;
  }
}

// decodePlistString — undo the XML entity encoding a plist <string> carries
// (CTL-1510 item 3 writes `&amp;` for `&` in baked paths; Codex P2: passing
// the still-encoded string to existsSync makes doctor report a working agent's
// path as missing forever). &amp; is decoded LAST so `&amp;lt;` round-trips.
function decodePlistString(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// checkHealthResponder (CTL-1509) — the periodic cloud-sync health responder
// (health-responder.sh, the bounded-kickstart sweep) must be installed, LOADED
// by launchd, its baked program path must still exist, and the installed script
// must carry the RESPONDER_ENABLED kill-switch (a pre-CTL-1509 stale install
// would silently do nothing). Mirrors checkReaper EXACTLY — every non-healthy
// condition is a WARN, never a FAIL: catalyst-doctor's exit code is the count
// of FAILs and gates the catalyst-join activation gate (do_doctor_gate runs
// BEFORE install-services, which is exactly what would reinstall a stale
// plist). A FAILing responder check would therefore BLOCK a node from
// self-healing via join.
// Severities:
//   • plist absent             → WARN  (responder not installed; a dead writer stays dead)
//   • no baked path in plist    → WARN  (malformed plist)
//   • baked path missing        → WARN  (the CTL-1306 silent-death signature; reinstall)
//   • kill-switch marker absent → WARN  (stale installed script; reinstall)
//   • plist present, not loaded  → WARN  (launchd never bootstrapped it)
//   • last exit 127             → WARN  (program path unresolved; reinstall)
//   • other non-zero exit       → WARN  (check the log)
//   • loaded + exit 0 or null   → PASS  (null = never run yet)
export function checkHealthResponder(deps = {}) {
  const {
    plistPath = resolve(
      homedir(), "Library", "LaunchAgents", "ai.coalesce.catalyst-health-responder.plist",
    ),
    readFile = (p) => readFileSync(p, "utf8"),
    fileExists = (p) => existsSync(p),
    responderState = defaultResponderState,
    // CTL-1510 item 6: mtime of the responder heartbeat log (every sweep —
    // healthy or not — appends exactly one line, so a fresh mtime IS proof of
    // dispatch). null = missing/unreadable.
    logMtimeMs = defaultResponderLogMtimeMs,
    // Install timestamp proxy for the never-ran-at-all case (Codex P2): the
    // plist's own mtime. null = unreadable (stay quiet).
    plistMtimeMs = () => { try { return statSync(plistPath).mtimeMs; } catch { return null; } },
    nowMs = () => Date.now(),
  } = deps;
  const checks = [];

  let xml;
  try {
    xml = readFile(plistPath);
  } catch {
    checks.push(mkCheck(
      "responder-installed", STATUS.WARN,
      "cloud-sync health responder not installed — a dead/wedged replica writer won't be auto-kickstarted; run 'catalyst-stack adopt-cloud-sync' (class-independent; workers also get it via install-services)",
    ));
    return checks;
  }

  const m = xml.match(/<string>([^<]*health-responder\.sh)<\/string>/);
  const baked = m ? decodePlistString(m[1]) : null;
  if (!baked) {
    checks.push(mkCheck(
      "responder-installed", STATUS.WARN,
      `responder plist present but no health-responder.sh program path found in ${plistPath}`,
    ));
    return checks;
  }

  if (!fileExists(baked)) {
    checks.push(mkCheck(
      "responder-path", STATUS.WARN,
      `responder points at a path that no longer exists (CTL-1306 silent-death signature): ${baked} — reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  // The kill-switch marker doubles as a stale-install detector: the installed
  // (baked) script — the one launchd actually runs — must be the CTL-1509
  // shape. Same pattern as defaultReaperHasAbVector's CTL-1500 cross-check.
  let script = null;
  try {
    script = readFile(baked);
  } catch {
    script = null;
  }
  if (script === null || !/RESPONDER_ENABLED/.test(script)) {
    checks.push(mkCheck(
      "responder-killswitch", STATUS.WARN,
      `installed health-responder.sh (${baked}) is unreadable or lacks the RESPONDER_ENABLED kill-switch marker — stale install; reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  const { loaded, lastExit } = responderState();
  if (!loaded) {
    checks.push(mkCheck(
      "responder-loaded", STATUS.WARN,
      "responder plist present but not loaded by launchd — run 'catalyst-stack install-services'",
    ));
    return checks;
  }

  if (lastExit === 127) {
    checks.push(mkCheck(
      "responder-health", STATUS.WARN,
      "responder last exited 127 (program path unresolved) — reinstall from the pristine clone",
    ));
    return checks;
  }
  if (typeof lastExit === "number" && lastExit !== 0) {
    checks.push(mkCheck(
      "responder-health", STATUS.WARN,
      `responder last exited ${lastExit} — check ~/catalyst/health-responder.log`,
    ));
    return checks;
  }

  // Dispatch staleness (CTL-1510 item 6): "loaded + clean exit" is NOT proof
  // the schedule is alive — a fleet host was observed with launchd holding the
  // job loaded, LastExitStatus 0, and NO automatic spawns for hours
  // (StartInterval pended; even RunAtLoad stopped firing after a reload).
  // Every sweep appends a heartbeat line, so a log mtime older than 3×
  // StartInterval means NEITHER launchd NOR the cron backstop is dispatching.
  // A MISSING log gets the same treatment against the plist's install mtime
  // (Codex P2): on a host where nothing pre-creates the log (dev/monitor
  // classes have no Alloy), a never-dispatched job would otherwise read as
  // never-run-yet and PASS forever. Within the window, missing = legitimately
  // fresh install (RunAtLoad normally writes within seconds).
  const im = xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  const intervalSecs = im ? parseInt(im[1], 10) : 180;
  // Resolve CATALYST_DIR from the INSTALLED plist, not the caller's own
  // process.env (Codex P2 round 2): a doctor invocation without that env set
  // would otherwise check the default ~/catalyst path even on a node whose
  // plist correctly persists a nondefault CATALYST_DIR (item 1), and either
  // false-WARN on an actively-dispatching responder or false-PASS by reading
  // an unrelated default-dir log.
  const cdirMatch = xml.match(/<key>CATALYST_DIR<\/key>\s*<string>([^<]*)<\/string>/);
  const plistCatalystDir = cdirMatch ? decodePlistString(cdirMatch[1]) : null;
  const mtime = logMtimeMs(plistCatalystDir, nowMs);
  const staleAfterMs = Math.max(3 * intervalSecs, 900) * 1000;
  if (typeof mtime === "number") {
    const age = nowMs() - mtime;
    // A SUBSTANTIALLY negative age (the log's mtime is in the future — a
    // backward clock step, or a log/state dir restored from a newer
    // snapshot, Codex P2 round 6) must never read as freshness evidence:
    // mirrors the bash-side sweep lock's own future-timestamp clamp (round
    // 5) — favor a WARN over silently trusting a clock read that can't be
    // verified. CLOCK_SKEW_TOLERANCE_MS absorbs ordinary write-then-stat
    // jitter (filesystem mtime can round UP to whole-second granularity on
    // some CI/container filesystems, putting a just-written file's mtime a
    // few ms ahead of the very next Date.now() read — caught live on a
    // Linux CI runner) without opening the door to a genuine clock-skew
    // scenario, which in practice is minutes to years, not milliseconds.
    if (age < -CLOCK_SKEW_TOLERANCE_MS) {
      checks.push(mkCheck(
        "responder-dispatch", STATUS.WARN,
        "responder heartbeat log has a timestamp in the future — cannot trust it as freshness evidence (clock skew or a restored snapshot); investigate the host clock and this log's mtime",
      ));
      return checks;
    }
    if (age > staleAfterMs) {
      const ageMin = Math.round(age / 60_000);
      checks.push(mkCheck(
        "responder-dispatch", STATUS.WARN,
        `responder heartbeat log is ${ageMin} min old (interval ${intervalSecs}s) — no scheduler is dispatching the sweep (launchd StartInterval wedge, CTL-1510); check 'crontab -l' for the backstop and kickstart once to confirm the job still runs`,
      ));
      return checks;
    }
  }
  if (mtime === null) {
    const pMtime = plistMtimeMs();
    if (typeof pMtime === "number") {
      const page = nowMs() - pMtime;
      if (page < -CLOCK_SKEW_TOLERANCE_MS) {
        checks.push(mkCheck(
          "responder-dispatch", STATUS.WARN,
          "responder plist install timestamp is in the future — cannot trust it as freshness evidence (clock skew or a restored snapshot); investigate the host clock and this plist's mtime",
        ));
        return checks;
      }
      if (page > staleAfterMs) {
        const ageMin = Math.round(page / 60_000);
        checks.push(mkCheck(
          "responder-dispatch", STATUS.WARN,
          `responder has never emitted a heartbeat (no log) ${ageMin} min after install — no scheduler ever dispatched the sweep (launchd StartInterval wedge, CTL-1510); check 'crontab -l' for the backstop and kickstart once to confirm the job still runs`,
        ));
        return checks;
      }
    }
  }

  // lastExit === 0 (clean) or null (loaded but never run yet), heartbeat fresh
  checks.push(mkCheck("responder-health", STATUS.PASS, `health responder installed and healthy (${baked})`));
  return checks;
}

// ─── Phase 5f: agent-browser worker browser tool (CTL-1500) ──────────────────
// Phase workers run browser tests (screenshots, live-UI verification) via the
// `agent-browser` CLI (catalyst-dev:agent-browser skill). Hosts drifted badly:
// mini ran 0.9.1 (IGNORES the idle-timeout knob), laptop 0.27.2, mini-2 had it
// NOT INSTALLED. AGENT_BROWSER_IDLE_TIMEOUT_MS auto-shuts-down the per-session
// daemon (the fix for the headed-Chrome core leak); honored only by >= 0.27.0.
// Every non-healthy condition is WARN/INFO, never FAIL — same rationale as
// checkReaper: doctor's exit code is the catalyst-join activation gate, and a
// missing browser tool must not block owning/dispatching or self-healing.

// Floor at which AGENT_BROWSER_IDLE_TIMEOUT_MS is honored (older builds ignore
// it). Keep in sync with the bash floor in install-cli.sh / check-setup.sh.
export const AGENT_BROWSER_MIN_VERSION = "0.27.0";

// parseSemver — "agent-browser 0.32.4" | "0.32.4" → [0,32,4] (or null).
export function parseSemver(s) {
  const m = String(s ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// versionGte — dotted `a` >= `b`? Unparseable a → false.
export function versionGte(a, b) {
  const va = parseSemver(a), vb = parseSemver(b);
  if (!va || !vb) return false;
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return true;
    if (va[i] < vb[i]) return false;
  }
  return true;
}

function defaultAbVersion() {
  const r = spawnSync("agent-browser", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0 || !r.stdout) return null; // ENOENT → error set / status null
  return r.stdout.trim(); // "agent-browser 0.32.4"
}

// Fast + network-free: --quick skips the live launch, --offline skips CDN probes.
function defaultAbDoctor() {
  const r = spawnSync("agent-browser", ["doctor", "--quick", "--offline", "--json"],
    { encoding: "utf8", timeout: 20_000 });
  if (r.error || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// phase-agent-dispatch (one dir up from execution-core/) bakes
// AGENT_BROWSER_IDLE_TIMEOUT_MS into the dispatched worker env block (CTL-1500).
function defaultDispatchWiresIdleTimeout() {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "phase-agent-dispatch");
    return /AGENT_BROWSER_IDLE_TIMEOUT_MS/.test(readFileSync(p, "utf8"));
  } catch { return false; }
}

// Does the INSTALLED orphan-sweep.sh (the one launchd runs) carry the CTL-1500
// vector-5 agent-browser reaper? Resolve its baked path from the same plist
// checkReaper reads, grep for the SWEEP_AB_ENABLED / _ab_browser_roots marker.
// null = reaper LaunchAgent not installed at all (checkReaper covers that).
function defaultReaperHasAbVector() {
  try {
    const plist = resolve(homedir(), "Library", "LaunchAgents", "ai.coalesce.catalyst-orphan-sweep.plist");
    const m = readFileSync(plist, "utf8").match(/<string>([^<]*orphan-sweep\.sh)<\/string>/);
    if (!m) return null;
    return /SWEEP_AB_ENABLED|_ab_browser_roots/.test(readFileSync(decodePlistString(m[1]), "utf8"));
  } catch { return null; }
}

// checkAgentBrowser — CTL-1500. present + >= min + idle-timeout wired + doctor
// green + CTL-1500 reaper present. All advisory (WARN/INFO/PASS) — never FAILs.
export function checkAgentBrowser(deps = {}) {
  const {
    abVersion = defaultAbVersion,
    abDoctor = defaultAbDoctor,
    dispatchWiresIdleTimeout = defaultDispatchWiresIdleTimeout,
    reaperHasAbVector = defaultReaperHasAbVector,
    minVersion = AGENT_BROWSER_MIN_VERSION,
  } = deps;
  const checks = [];

  // (a) present on PATH
  const raw = abVersion();
  if (!raw) {
    checks.push(mkCheck("agent-browser-installed", STATUS.WARN,
      "agent-browser not found on PATH — worker browser tests (screenshots / live-UI " +
        "verification) unavailable; `brew install agent-browser` then `agent-browser install`"));
    return checks;
  }
  const version = (parseSemver(raw) ?? []).join(".") || raw;
  checks.push(mkCheck("agent-browser-installed", STATUS.PASS, `agent-browser present (${raw})`));

  // (b) version >= min (older builds silently IGNORE AGENT_BROWSER_IDLE_TIMEOUT_MS)
  checks.push(versionGte(raw, minVersion)
    ? mkCheck("agent-browser-version", STATUS.PASS,
        `agent-browser ${version} >= ${minVersion} (honors AGENT_BROWSER_IDLE_TIMEOUT_MS)`)
    : mkCheck("agent-browser-version", STATUS.WARN,
        `agent-browser ${version} is below the ${minVersion} floor — it IGNORES ` +
          `AGENT_BROWSER_IDLE_TIMEOUT_MS (the daemon idle-shutdown that stops the ` +
          `headed-Chrome core leak); \`brew upgrade agent-browser\``));

  // (c) idle-timeout wired into dispatched workers
  checks.push(dispatchWiresIdleTimeout()
    ? mkCheck("agent-browser-idle-timeout", STATUS.PASS,
        "AGENT_BROWSER_IDLE_TIMEOUT_MS is wired into dispatched workers (phase-agent-dispatch)")
    : mkCheck("agent-browser-idle-timeout", STATUS.WARN,
        "phase-agent-dispatch does not inject AGENT_BROWSER_IDLE_TIMEOUT_MS — a leaked " +
          "agent-browser daemon will not self-shutdown (CTL-1500 wiring missing)"));

  // (d) optional: agent-browser's own doctor (fast, offline)
  const d = abDoctor();
  if (d && typeof d === "object") {
    const s = d.summary ?? {};
    checks.push(d.success
      ? mkCheck("agent-browser-doctor", STATUS.PASS,
          `agent-browser doctor: pass (${s.pass ?? "?"} pass, ${s.warn ?? 0} warn, ${s.fail ?? 0} fail)`)
      : mkCheck("agent-browser-doctor", STATUS.WARN,
          `agent-browser doctor reports ${s.fail ?? "?"} failing check(s) — run \`agent-browser doctor\``));
  } else {
    checks.push(mkCheck("agent-browser-doctor", STATUS.INFO,
      "agent-browser doctor probe unavailable (older build without `doctor`, or probe failed)"));
  }

  // (e) CTL-1500 reaper present in the INSTALLED orphan-sweep.sh (checkReaper covers the LaunchAgent)
  const hasVector = reaperHasAbVector();
  checks.push(hasVector === true
    ? mkCheck("agent-browser-reaper", STATUS.PASS,
        "orphan-sweep.sh carries the CTL-1500 agent-browser leaked-browser reaper (vector 5)")
    : hasVector === false
      ? mkCheck("agent-browser-reaper", STATUS.WARN,
          "installed orphan-sweep.sh predates CTL-1500 (no agent-browser vector-5 reaper) — " +
            "reinstall from the pristine clone (`catalyst-stack install-services`)")
      : mkCheck("agent-browser-reaper", STATUS.INFO,
          "orphan-sweep reaper not installed — see the reaper-* checks"));

  return checks;
}

// defaultShipperState — load state + last exit of the log-shipper LaunchAgent.
// Mirrors defaultReaperState but for ai.coalesce.catalyst-log-shipper.
function defaultShipperState() {
  try {
    const r = spawnSync("launchctl", ["list", MANIFEST_LABELS.shipper], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return { loaded: false, lastExit: null };
    const m = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    return { loaded: true, lastExit: m ? parseInt(m[1], 10) : null };
  } catch {
    return { loaded: false, lastExit: null };
  }
}

// defaultCanonicalShipperConfig — resolve the canonical config path from the
// registered pristine plugin-source checkout (catalyst.orchestration.pluginDirs[0]).
// Returns the absolute path or null if the config is absent/unreadable.
function defaultCanonicalShipperConfig() {
  try {
    const cfg = JSON.parse(readFileSync(layer2Path(), "utf8"));
    const pluginDirs = cfg?.catalyst?.orchestration?.pluginDirs;
    const pd = Array.isArray(pluginDirs) ? pluginDirs[0] : (typeof pluginDirs === "string" ? pluginDirs : null);
    if (!pd) return null;
    return resolve(pd, "scripts", "log-shipper", "config.alloy");
  } catch {
    return null;
  }
}

// checkLogShipper — CTL-1473: for classes whose manifest declares shipsLogs:true,
// (a) FAILs when the shipper LaunchAgent is missing/unloaded, and (b) FAILs when
// the plist's --config path does not resolve to the canonical config under the
// registered pristine plugin-source checkout. A preinstall flag (from
// CATALYST_DOCTOR_PREINSTALL=1) downgrades FAILs to WARNs so the join pre-install
// gate can run before install-services creates the shipper. The post-install strict
// verify runs without the flag and fails hard on a missing/misconfigured shipper.
export function checkLogShipper(deps = {}) {
  const {
    shipsLogs: shipperRequired = false,
    preinstall = false,
    plistPath = resolve(homedir(), "Library", "LaunchAgents", `${MANIFEST_LABELS.shipper}.plist`),
    readFile = (p) => readFileSync(p, "utf8"),
    fileExists = (p) => existsSync(p),
    realpath = (p) => {
      // Runtime-agnostic: realpathSync is imported at module top (line 27), so
      // symlink normalization runs under both node and bun. The prior
      // require("node:fs") threw under node ESM (require is undefined), silently
      // returning the un-normalized path (CTL-1473 verify silent-failure finding).
      try { return realpathSync(p); } catch { return p; }
    },
    canonicalConfig = defaultCanonicalShipperConfig,
    shipperState = defaultShipperState,
  } = deps;

  if (!shipperRequired) return [];

  const sev = (s) => (preinstall && s === STATUS.FAIL ? STATUS.WARN : s);
  const checks = [];

  let xml;
  try {
    xml = readFile(plistPath);
  } catch {
    checks.push(mkCheck(
      "shipper-installed",
      sev(STATUS.FAIL),
      `log-shipper agent (${MANIFEST_LABELS.shipper}) not installed — daemon logs won't reach Loki; run 'catalyst-stack install-services'`,
    ));
    return checks;
  }

  const { loaded, lastExit } = shipperState();
  if (!loaded) {
    checks.push(mkCheck(
      "shipper-installed",
      sev(STATUS.FAIL),
      `log-shipper plist present but not loaded by launchd — run 'catalyst-stack install-services'`,
    ));
    return checks;
  }

  // CTL-1473 remediate (round-3): inspect lastExit exactly like checkReaper
  // (line ~1728). The prior code destructured only `loaded` and dropped
  // lastExit, so a loaded-but-crash-looping shipper (LastExitStatus 127/78,
  // shipping nothing) with a canonical --config path reported shipper-config:
  // PASS — the exact "green while shipping nothing" failure this ticket exists
  // to prevent. FAIL (sev-wrapped so the preinstall gate downgrades to WARN)
  // given shipsLogs criticality; PASS on 0 (clean) or null (loaded but never
  // run yet) falls through to the canonical --config check below.
  if (lastExit === 127) {
    checks.push(mkCheck(
      "shipper-health",
      sev(STATUS.FAIL),
      `log-shipper last exited 127 (program path unresolved) — shipping nothing; reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }
  if (typeof lastExit === "number" && lastExit !== 0) {
    checks.push(mkCheck(
      "shipper-health",
      sev(STATUS.FAIL),
      `log-shipper last exited ${lastExit} — crash-looping and shipping nothing; check the shipper log and reinstall ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  // Extract the --config argument from the plist ProgramArguments
  const cfgMatch = xml.match(/<string>([^<]*config\.alloy)<\/string>/);
  const bakedConfig = cfgMatch ? cfgMatch[1] : null;
  if (!bakedConfig) {
    checks.push(mkCheck(
      "shipper-config",
      sev(STATUS.FAIL),
      `log-shipper plist present and loaded but no --config alloy path found in ${plistPath} (malformed plist)`,
    ));
    return checks;
  }

  const canonical = typeof canonicalConfig === "function" ? canonicalConfig() : canonicalConfig;
  if (!canonical) {
    checks.push(mkCheck(
      "shipper-config",
      STATUS.WARN,
      `log-shipper config path unverifiable (no pluginDirs in Layer-2 config) — baked path: ${bakedConfig}`,
    ));
    return checks;
  }

  const bakedExists = fileExists(bakedConfig);
  if (!bakedExists) {
    checks.push(mkCheck(
      "shipper-config",
      sev(STATUS.FAIL),
      `log-shipper --config path does not exist on disk (ephemeral/deleted worktree?): ${bakedConfig} — reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  let resolvedBaked = bakedConfig;
  let resolvedCanon = canonical;
  try { resolvedBaked = realpath(bakedConfig); } catch { /* use raw */ }
  try { resolvedCanon = realpath(canonical); } catch { /* use raw */ }

  if (resolvedBaked !== resolvedCanon) {
    checks.push(mkCheck(
      "shipper-config",
      sev(STATUS.FAIL),
      `log-shipper --config points at a non-canonical path (likely a deleted worktree): ${bakedConfig} (expected: ${canonical}) — reinstall from the pristine clone ('catalyst-stack install-services')`,
    ));
    return checks;
  }

  checks.push(mkCheck("shipper-config", STATUS.PASS, `log-shipper config path is canonical (${bakedConfig})`));
  return checks;
}


// checkCloudTokenEnv — CTL-1307. ADVISORY for the cluster-shared-token distribution
// checks below (the `cloud-token` row's original CTL-1307 scope): CATALYST_CLOUD_TOKEN
// is an OPTIONAL extension for a cluster node — a node stays fully local-only without
// it, so its absence must NEVER block activation there. WARN only on DRIFT: the token
// has been decrypted from the catalyst-cluster repo (cluster-cloud.json) but is not yet
// projected into the machine-level env (cluster.env + ~/.zshenv guard).
//
// CTL-1616 PR6 (design §5/§7) ADDS ONE FAIL: when the ACTIVE deployment mode is
// DECLARED cloud (not cluster's optional extension — the actual managed-platform mode),
// a missing/unresolvable bootstrap credential IS the one FAIL doctor cannot route
// around — see the `cloud-token-bootstrap` check below. That escalation is gated
// entirely on deployment mode and contributes ZERO checks for every other mode, so this
// function's original ADVISORY/never-FAIL contract is UNCHANGED for single-host,
// cluster, and inferred nodes — i.e. every live host today. All reads are injectable +
// fail-open.
// _isDeclaredCloud — the one gate PR6's escalation and the local-only wording
// share: a genuinely DECLARED cloud mode (recognized, not inferred).
function _isDeclaredCloud(dm) {
  return Boolean(dm && dm.mode === "cloud" && dm.inferred === false && dm.recognized !== false);
}

export function checkCloudTokenEnv(deps = {}) {
  const {
    configDir = process.env.CATALYST_CONFIG_DIR || resolve(homedir(), ".config", "catalyst"),
    zshenvPath = process.env.CATALYST_ZSHENV_FILE || resolve(homedir(), ".zshenv"),
    readFile = (p) => readFileSync(p, "utf8"),
    // CTL-1616 PR2: shadow-only contract resolver — this check's hand-rolled
    // logic hardcodes the env-var NAME "CATALYST_CLOUD_TOKEN" everywhere above
    // (the `export CATALYST_CLOUD_TOKEN=` string match, the ~/.zshenv guard);
    // the contract resolves a possibly-CUSTOM name via the same 3-tier ladder
    // as resolveNodeCloudTokenEnv (env override → Layer-2 catalyst.cloud.tokenEnv
    // → default). Consulted and COMPARED below, never used to decide this
    // check's grade — stays INFO-only (design §7).
    resolveSecretContract = resolveSecret,
    // #2916 round-3 (Codex P2): the OTHER hand-rolled cloud-token name path —
    // checkCloudSync's replica-token presence check resolves its env-var name
    // via resolveNodeCloudTokenEnv(), which can diverge from the contract
    // (e.g. a CATALYST_MACHINE_CONFIG pointer vs the home Layer-2). Shadowed
    // here alongside the literal-name comparison so a clean shadow cycle
    // cannot mask that divergence.
    resolveReplicaTokenEnv = resolveNodeCloudTokenEnv,
    // CTL-1616 PR6 (design §5/§7): the §7 FAIL escalation's deployment-mode
    // input — injectable, same convention as every other secret-contract call
    // site in this file. Default is throw-safe (resolveDeploymentModeForShadow
    // catches internally and degrades to undefined), so an unset/throwing
    // resolver fails OPEN to today's INFO-only behavior (the escalation below
    // is gated on this being genuinely {mode:"cloud", inferred:false, ...} —
    // undefined never satisfies that gate).
    // NOTE (#2929 post-merge Codex P2): the default must apply only when the
    // caller OMITTED the key — a destructure default also fires on an
    // explicitly-supplied `deploymentMode: undefined`, silently re-resolving
    // the HOST's mode and making injected-state tests host-dependent. Hence
    // the `in`-guarded assignment below instead of a destructure default.
    deploymentMode: _deploymentModeDep,
  } = deps;
  const deploymentMode =
    "deploymentMode" in deps ? _deploymentModeDep : resolveDeploymentModeForShadow();
  const checks = [];

  // CTL-1616 PR6 §7 FAIL ESCALATION (design §5): "the one FAIL doctor cannot
  // route around." Computed ONCE here (same convention as cloudShadowChecks
  // just below) and appended at EVERY return point so it fires regardless of
  // which cluster-cloud.json/cluster.env/zshenv branch this check's existing
  // hand-rolled logic lands in — those branches answer "is CATALYST_CLOUD_TOKEN
  // projected from the cluster-sync distribution path", an ORTHOGONAL question
  // to "is this node's deployment mode declared cloud and did the bootstrap
  // credential resolve" (design §4's bootstrapFor:"cloud" row IS this same
  // secret, just consulted through the shared engine rather than the
  // cluster-sync file trio).
  //
  // GATE: fires ONLY when the ACTIVE deployment mode is DECLARED cloud —
  // recognized (not a typo'd/degraded value) AND not inferred (an operator
  // explicitly set it, matching checkDeploymentModeConsistency's tunnel-
  // consistency gate at ~line 3445 and the engine's own cloud guard in
  // lib/secret-contract.mjs's resolveSecret). Structurally inert (contributes
  // ZERO checks, hence zero grade change) for every other deployment mode —
  // single-host, cluster, inferred, or an unrecognized explicit value — so
  // this is provably a no-op on both live minis (cluster) and the laptop
  // (single-host). `recognized !== false` mirrors the engine's own
  // belt-and-suspenders extension (design §12 Q3) rather than requiring
  // recognized===true, so a deploymentMode object that omits the field
  // (legacy callers, most fixtures elsewhere in this file) still gates
  // correctly on inferred alone.
  const cloudBootstrapEscalationChecks = [];
  const dm = deploymentMode;
  if (_isDeclaredCloud(dm)) {
    const bootstrapResolution = safeResolveSecretContract(resolveSecretContract, "cloud-token", {
      env: process.env,
      deploymentMode: dm,
    });
    if (!bootstrapResolution.ok) {
      cloudBootstrapEscalationChecks.push(
        shadowThrowCheck("cloud-token-bootstrap", "cloud-token", bootstrapResolution.error),
      );
    } else {
      const bootstrapResolved = bootstrapResolution.value;
      const envVar = typeof bootstrapResolved?.envVar === "string" ? bootstrapResolved.envVar : "CATALYST_CLOUD_TOKEN";
      if (bootstrapResolved?.value == null) {
        cloudBootstrapEscalationChecks.push(
          mkCheck(
            "cloud-token-bootstrap",
            STATUS.FAIL,
            `deployment mode is declared "cloud" but the bootstrap credential (env var ` +
              `"${envVar}") did not resolve — per the §4 cloud guard's bootstrap short-circuit, ` +
              `EVERY other cloud-mode secret resolution returns null until this is set (a ` +
              `half-provisioned managed container); set ${envVar} in the platform environment`,
          ),
        );
      } else {
        cloudBootstrapEscalationChecks.push(
          mkCheck(
            "cloud-token-bootstrap",
            STATUS.PASS,
            `deployment mode is declared "cloud" and the bootstrap credential resolved ` +
              `(env var "${envVar}", source=${bootstrapResolved.envVarSource ?? bootstrapResolved.source})`,
          ),
        );
      }
    }
  }

  // CTL-1616 PR2 (B1): computed ONCE here, but pushed at each return point
  // below so the shadow row is always APPENDED AFTER the primary rows (the
  // same convention as checkBotCredentials — checks[0] must stay the primary
  // graded row). This is the one bespoke shadow site (a name-comparison, not
  // a presence-comparison), so it does its own safeResolveSecretContract
  // wrap rather than going through buildContractShadowCheck — a throwing
  // resolver surfaces as a shadowThrowCheck INFO row instead of crashing
  // this check.
  const cloudShadowChecks = [];
  const contractResolution = safeResolveSecretContract(resolveSecretContract, "cloud-token", {
    env: process.env,
    // #2930 round-2 (Codex P2): reuse the SAME resolved deploymentMode the
    // bootstrap gate and the local-only wording use — an independent
    // re-resolve here made an explicitly-injected mode (incl. undefined)
    // evaluate the shadow under the HOST's mode.
    deploymentMode,
  });
  if (!contractResolution.ok) {
    cloudShadowChecks.push(shadowThrowCheck("cloud-token", "cloud-token", contractResolution.error));
  } else {
    const contractResolved = contractResolution.value;
    if (typeof contractResolved?.envVar === "string" && contractResolved.envVar !== "CATALYST_CLOUD_TOKEN") {
      cloudShadowChecks.push(
        mkCheck(
          "cloud-token-secret-contract-shadow",
          STATUS.INFO,
          `SHADOW DISAGREEMENT secret="cloud-token": hand-rolled hardcodes env-var name ` +
            `"CATALYST_CLOUD_TOKEN" but the contract resolves "${contractResolved.envVar}" ` +
            `(source=${contractResolved.envVarSource ?? "unknown"}) — never changes this check's grade or exit code`,
        ),
      );
    }
    // Second comparison (#2916 round-3): contract name vs checkCloudSync's
    // replica-token name path. Throw-safe like every shadow call.
    // resolveNodeCloudTokenEnv returns { envVar, source } (config.mjs) — read
    // .envVar, never treat the result as a bare string (#2916 round-4: the
    // string-typed guard made this comparison unreachable in production).
    let replicaName = null;
    try {
      const replicaResolved = resolveReplicaTokenEnv();
      replicaName = typeof replicaResolved?.envVar === "string" ? replicaResolved.envVar : null;
    } catch (err) {
      cloudShadowChecks.push(shadowThrowCheck("cloud-token-replica-name", "cloud-token", err));
    }
    if (
      typeof contractResolved?.envVar === "string" &&
      typeof replicaName === "string" &&
      replicaName !== contractResolved.envVar
    ) {
      cloudShadowChecks.push(
        mkCheck(
          "cloud-token-secret-contract-shadow",
          STATUS.INFO,
          `SHADOW DISAGREEMENT secret="cloud-token": replica-token resolver (resolveNodeCloudTokenEnv) ` +
            `resolves env-var name "${replicaName}" but the contract resolves "${contractResolved.envVar}" ` +
            `(source=${contractResolved.envVarSource ?? "unknown"}) — never changes this check's grade or exit code`,
        ),
      );
    }
  }

  let token = "";
  try {
    const obj = JSON.parse(readFile(resolve(configDir, "cluster-cloud.json")));
    const t = obj?.catalyst?.cloud?.token;
    token = typeof t === "string" ? t : "";
  } catch {
    /* absent / malformed → no token decrypted */
  }

  if (!token) {
    checks.push(
      mkCheck(
        "cloud-token",
        STATUS.INFO,
        _isDeclaredCloud(deploymentMode)
          ? "no cluster-sync cloud token file — expected on a declared-cloud node (the platform environment is the token source; see cloud-token-bootstrap)"
          : "no cluster cloud token decrypted — node is local-only (expected unless opted into catalyst-cloud)",
      ),
    );
    checks.push(...cloudShadowChecks, ...cloudBootstrapEscalationChecks);
    return checks;
  }

  let clusterEnv = "";
  try {
    clusterEnv = readFile(resolve(configDir, "cluster.env"));
  } catch {
    /* missing → not projected */
  }
  // Expected single-quoted export line (mirrors cloud-token-env.mjs escaping).
  const expected = `export CATALYST_CLOUD_TOKEN='${token.replace(/'/g, "'\\''")}'`;
  if (!clusterEnv.includes("export CATALYST_CLOUD_TOKEN=")) {
    checks.push(
      mkCheck(
        "cloud-token",
        STATUS.WARN,
        "cloud token decrypted but NOT projected to ~/.config/catalyst/cluster.env — run 'catalyst-stack sync-cloud-env'",
      ),
    );
    checks.push(...cloudShadowChecks, ...cloudBootstrapEscalationChecks);
    return checks;
  }
  if (!clusterEnv.includes(expected)) {
    checks.push(
      mkCheck(
        "cloud-token",
        STATUS.WARN,
        "cluster.env CATALYST_CLOUD_TOKEN is STALE vs cluster-cloud.json — run 'catalyst-stack sync-cloud-env' and restart cloud daemons",
      ),
    );
    checks.push(...cloudShadowChecks, ...cloudBootstrapEscalationChecks);
    return checks;
  }

  let zshenv = "";
  try {
    zshenv = readFile(zshenvPath);
  } catch {
    /* missing → no guard */
  }
  if (!zshenv.includes("catalyst cloud-token env")) {
    checks.push(
      mkCheck(
        "cloud-token",
        STATUS.WARN,
        "cluster.env present but ~/.zshenv lacks the source-guard — shells (and shell-launched cloud daemons) won't inherit CATALYST_CLOUD_TOKEN",
      ),
    );
    checks.push(...cloudShadowChecks, ...cloudBootstrapEscalationChecks);
    return checks;
  }

  checks.push(
    mkCheck(
      "cloud-token",
      STATUS.PASS,
      "cluster cloud token projected to machine-level env (cluster.env + ~/.zshenv guard)",
    ),
  );
  checks.push(...cloudShadowChecks, ...cloudBootstrapEscalationChecks);
  return checks;
}

// CAT-35 replica-schema verification helpers. The production reader (replica-read.mjs)
// prepares queries against `issues` and `sync_meta`; a file that lacks either is unusable
// no matter how large it is, so `replica-schema` must not PASS on size alone.
export const REQUIRED_REPLICA_TABLES = ["issues", "sync_meta"];
const SQLITE_MAGIC = "SQLite format 3\0";

// defaultIsSqliteFile — read ONLY the 16-byte magic header (never the whole file, which
// can be hundreds of MiB). Returns false on any read error: unreadable is not verified.
function defaultIsSqliteFile(path) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return read === buf.length && buf.toString("latin1") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

// defaultReadDbTables — table names via the sqlite3 CLI (an OPTIONAL dependency; doctor
// runs under bare node and must not import bun:sqlite). Returns null — meaning "could not
// verify", distinct from [] meaning "verified, no tables" — when sqlite3 is absent or the
// query fails, so the caller reports unverified instead of inventing a WARN.
function defaultReadDbTables(path) {
  const r = spawnSync("sqlite3", ["-readonly", path, "SELECT name FROM sqlite_master WHERE type='table'"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

// checkCloudSync — CTL-1394. Advisory health of the per-node supervised Linear-replica
// writer + its read tier. EVERY condition is WARN/INFO/PASS, NEVER FAIL: doctor's exit code
// is the FAIL count and gates catalyst-join activation — a FAIL here would block a node that
// simply hasn't opted into the replica yet. All deps injectable so tests touch no
// fs/pgrep/launchctl. NODE-SAFE: file-mtime freshness only (no bun:sqlite); rowcount /
// MAX(updated_at) freshness is check-setup.sh's richer job.
export function checkCloudSync(deps = {}) {
  const {
    label = CLOUD_SYNC_AGENT_LABEL,
    laDir = defaultLaunchAgentsDir(),
    agentInstalled = defaultAgentInstalled,
    processAlive = defaultCloudSyncProcessAlive,
    // CTL-1963: which plist the live label is actually bound to. Injectable so tests touch no launchctl.
    labelPath = defaultLaunchdLabelPath,
    dbPath = getReplicaDbPath(),
    fileExists = (p) => existsSync(p),
    statFile = (p) => statSync(p),
    mode = readLinearReplica().mode,
    tokenEnv = resolveNodeCloudTokenEnv(),
    env = process.env,
    now = Date.now(),
    staleMs = Number(process.env.CATALYST_REPLICA_STALE_MS) || 120_000,
    // The writer-lock heartbeat is the FEED-INDEPENDENT liveness signal: the live writer
    // rewrites <db>.writer.lock every ~5s (SDK heartbeatMs) regardless of Linear activity,
    // whereas the DB/-wal mtime only advances when a change frame lands. A generous default
    // (4× the SDK's 15s lock-stale) absorbs heartbeat jitter; > this ⇒ heartbeat stopped.
    lockStaleMs = Number(process.env.CATALYST_REPLICA_LOCK_STALE_MS) || 60_000,
    sizeFloorBytes = 65_536,
    isSqliteFile = defaultIsSqliteFile, // CAT-35
    readDbTables = defaultReadDbTables, // CAT-35
    // CTL-1913: when was the writer ADOPTED? The plist's mtime is the only local
    // evidence of that, and it is what separates "provisioned minutes ago, still
    // seeding" from "provisioned and has never once authenticated".
    agentInstalledAt = defaultAgentInstalledAt,
    // A writer that has not produced a replica within this window has not lost a
    // race — it is inert. Generous on purpose: a cold seed of a large workspace is
    // minutes, not seconds.
    neverSeededGraceMs = Number(process.env.CATALYST_REPLICA_NEVER_SEEDED_GRACE_MS) || 900_000,
    // ⛔ CTL-1913 — `strict` GOVERNS ONE BRANCH, AND IS DELIBERATELY UNWIRED.
    //
    // CTL-1913 asked for a doctor that CAN fail on a permanently-inert replica,
    // because every check here was WARN/INFO and so nothing in the install path
    // ever returned non-zero for one. The capability now exists — but it stays
    // opt-in, for the reason this file already records twice (checkReaper,
    // checkHealthResponder): **doctor's exit code IS the catalyst-join activation
    // gate, and `do_doctor_gate` runs BEFORE `install-services`.** A FAIL here
    // would block the join that reinstalls the writer — i.e. it would block the
    // self-heal for the very condition it is reporting.
    //
    // Nor does the install profile want it: `installChecksForClass` deliberately
    // omits the network/operational checks, since failing on a remote dependency
    // would mis-attribute an operational gap to the install run.
    //
    // So this follows the precedent of `checkDeploymentModeConsistency`'s strict
    // escalation — implemented and tested, wired into no profile yet. The
    // install-time actuator is the one the ticket itself names:
    // `catalyst-stack verify-cloud-sync --strict`.
    strict = false,
  } = deps;

  const installed = agentInstalled(label, laDir);
  const dbPresent = fileExists(dbPath);

  // Gate: a node with NO writer agent, the read flag OFF, and NO replica file is simply not
  // on the replica tier — one INFO and out, so this check is safe to wire into every class.
  if (!installed && mode !== "on" && !dbPresent) {
    return [mkCheck("cloud-sync", STATUS.INFO, "local Linear replica tier not enabled on this node")];
  }

  const checks = [];

  // (a) writer agent — installed + process alive (+ writer-lock as a corroborator).
  if (!installed) {
    checks.push(mkCheck("cloud-sync", STATUS.WARN, "agent not installed (run: catalyst-stack adopt-cloud-sync) — reads fall back to live linearis"));
  } else if (processAlive()) {
    const lockHeld = fileExists(`${dbPath}.writer.lock`);
    checks.push(mkCheck("cloud-sync", STATUS.PASS, `agent installed + running${lockHeld ? " (writer-lock held)" : ""}`));
  } else {
    checks.push(mkCheck("cloud-sync", STATUS.WARN, "agent installed but no writer process found — KeepAlive may be retrying; check ~/catalyst/cloud-sync.log"));
  }

  // (a2) launchd LABEL BINDING — CTL-1963. Does `ai.coalesce.catalyst-cloud-sync` in the live
  // per-user domain resolve to ~/Library/LaunchAgents/<label>.plist, or to somebody else's file?
  //
  // Branch (a) above proves the CORRECT plist exists and whether A writer process is running. It
  // cannot see that launchd is bound to a DIFFERENT plist — which is exactly the observed failure:
  // a sealed-prefix install run bootstraps the real gui/$UID domain from a temp HOME, rebinds the
  // label to /var/folders/…/T/tmp.XXXX/…, then exits and lets its temp dir be reaped. The writer
  // dies, the correct plist is still sitting there untouched, and every other signal reads normal.
  //
  // ⚠️ WARN, never FAIL — deliberately, and for the reason this function documents at length above:
  // doctor's exit code IS the catalyst-join activation gate, and `do_doctor_gate` runs BEFORE
  // `install-services`. Failing here would block the very join that would re-bootstrap the label,
  // i.e. it would block the self-heal for the condition it is reporting.
  if (installed) {
    const bound = labelPath(label);
    const expected = resolve(laDir, `${label}.plist`);
    if (bound === null) {
      // ⛔ Not a pass. "Could not measure" and "measured, correct" must never render the same —
      // an unmeasurable binding is precisely the state the squat produces on a host where the
      // label was booted out entirely.
      checks.push(mkCheck("cloud-sync-label", STATUS.INFO,
        `could not resolve launchd label ${label} (launchctl unavailable or label not bootstrapped) — binding UNVERIFIED, not confirmed healthy`));
    } else if (bound === expected) {
      checks.push(mkCheck("cloud-sync-label", STATUS.PASS, `launchd label resolves to ${expected}`));
    } else {
      // Name whether the squatting file still exists: if it does not, no kickstart/bootstrap/reboot
      // can revive the writer, which changes the remedy from "restart it" to "rebind it".
      const gone = !fileExists(bound);
      checks.push(mkCheck("cloud-sync-label", STATUS.WARN,
        `launchd label ${label} is bound to ${bound}${gone ? " (WHICH NO LONGER EXISTS — the writer cannot be restarted, only rebound)" : ""}, ` +
        `not ${expected} — a sealed-prefix install run squatted the per-user domain (gui/$UID is per-user, not per-HOME). ` +
        `Rebind: launchctl bootout gui/$(id -u)/${label}; launchctl bootstrap gui/$(id -u) ${expected}`));
    }
  }

  // (b) replica freshness + writer liveness. KEY INSIGHT: the DB + -wal mtime only advance
  // when a change FRAME is applied, so a quiet Linear feed (no ticket changes) freezes them
  // even though the writer is perfectly alive — the SDK has no idle keepalive. So DB mtime
  // measures "time since last mirrored change", NOT writer liveness. The feed-independent
  // liveness signal is the writer-lock HEARTBEAT (<db>.writer.lock), rewritten ~every 5s.
  // Gate liveness on the lock heartbeat; report the data-age as info only, never as "down".
  let size = 0;
  let statOk = false;
  if (!dbPresent) {
    // ⛔ CTL-1913 — THE ONE STATE IN THIS CHECK THAT EARNS A **FAIL**.
    //
    // Agent installed + replica never created is not a transient: the writer
    // `process.exit(0)`s when its token is absent, misnamed, or rejected, and under
    // `KeepAlive={SuccessfulExit:false}` a CLEAN EXIT IS PERMANENT — launchd never
    // retries. So this state does not heal, and it is exactly what a green install
    // with an unvalidated token produces. Every check on this path was WARN/INFO, so
    // nothing in the install path ever returned non-zero for a completely inert
    // replica; that is the gap this grade closes.
    //
    // Gated on the ADOPTION AGE rather than graded immediately, because a writer
    // provisioned seconds ago legitimately has no db yet — escalating on that would
    // be a false alarm on every fresh install. Three-valued, and it never escalates
    // on an inability to measure: an unreadable plist mtime keeps the plain WARN and
    // SAYS the grace could not be evaluated, rather than treating "could not look"
    // as evidence of the terminal state.
    const adoptedAt = installed ? agentInstalledAt(label, laDir) : null;
    const measurable = typeof adoptedAt === "number" && Number.isFinite(adoptedAt);
    if (installed && measurable && now - adoptedAt > neverSeededGraceMs) {
      const mins = Math.round((now - adoptedAt) / 60_000);
      checks.push(
        mkCheck("replica-fresh", strict ? STATUS.FAIL : STATUS.WARN,
          `writer agent adopted ${mins}m ago and the replica db has NEVER been created (${dbPath}) — ` +
          `the writer has never authenticated. A token that is absent, misnamed, or rejected makes it exit 0, ` +
          `and KeepAlive={SuccessfulExit:false} means launchd never retries, so this does NOT self-heal. ` +
          `Check ~/catalyst/cloud-sync.log, confirm ${tokenEnv.envVar} is set in a 0600 file the launcher sources, ` +
          `then: catalyst-stack verify-cloud-sync --strict`),
      );
    } else if (installed && !measurable) {
      checks.push(
        mkCheck("replica-fresh", STATUS.WARN,
          "replica db not present, and the writer agent's adoption time is unreadable — cannot tell a fresh adoption from a writer that has never seeded (not connected)"),
      );
    } else {
      // Unchanged wording for the ordinary not-yet-seeded case: a fresh adoption,
      // or no agent at all.
      checks.push(mkCheck("replica-fresh", STATUS.WARN, "replica db not present — writer has not seeded yet (not connected)"));
    }
  } else {
    let dataNewest = 0; // newest of DB + non-empty -wal mtime = last mirrored change
    try { const s = statFile(dbPath); size = s.size; dataNewest = s.mtimeMs; statOk = true; } catch { /* unreadable → handled below */ }
    try { const w = statFile(`${dbPath}-wal`); if (w.size > 0) dataNewest = Math.max(dataNewest, w.mtimeMs); } catch { /* no -wal sidecar */ }
    let lockMtime = 0;
    try { lockMtime = statFile(`${dbPath}.writer.lock`).mtimeMs; } catch { /* no lock: guard disabled / writer not started */ }
    const dataAge = dataNewest ? `${Math.round((now - dataNewest) / 1000)}s` : "unknown";

    if (size < sizeFloorBytes) {
      checks.push(mkCheck("replica-fresh", STATUS.WARN, "replica present but tiny — snapshot seed not applied yet (not connected)"));
    } else if (lockMtime > 0) {
      // Writer-lock heartbeat is the truth (feed-independent). A quiet feed never trips this.
      const lockAge = Math.round((now - lockMtime) / 1000);
      if (now - lockMtime <= lockStaleMs) {
        checks.push(mkCheck("replica-fresh", STATUS.PASS, `writer live (heartbeat ${lockAge}s ago); last mirrored change ${dataAge} ago`));
      } else {
        checks.push(mkCheck("replica-fresh", STATUS.WARN, `writer heartbeat stale (${lockAge}s > ${Math.round(lockStaleMs / 1000)}s) — writer likely down`));
      }
    } else if (dataNewest === 0 || now - dataNewest > staleMs) {
      // No writer-lock (guard disabled / not started) — fall back to the DB data-mtime as a
      // COARSE proxy, but word it ambiguously since a quiet feed is indistinguishable here.
      checks.push(mkCheck("replica-fresh", STATUS.WARN, `no writer-lock + no mirrored change in ${dataAge} — writer may be down (or the feed is quiet)`));
    } else {
      checks.push(mkCheck("replica-fresh", STATUS.PASS, `replica updated ${dataAge} ago (no writer-lock present)`));
    }
  }

  // CAT-35: distinguish a never-seeded/no-schema file from ordinary staleness.
  // Size alone must never earn a PASS: a truncated, corrupt, or entirely unrelated
  // file above the floor would otherwise be declared "schema seeded" while every
  // production read misses, which is the exact failure this check exists to catch.
  // So a PASS additionally requires the SQLite magic header AND — when a sqlite3
  // reader is available — the two tables the production reader actually prepares
  // against (`issues`, `sync_meta`). With no reader present we say so rather than
  // claiming verification we did not perform.
  if (dbPresent) {
    if (!statOk) {
      checks.push(mkCheck("replica-schema", STATUS.WARN, "replica db is present but unreadable — cannot determine whether schema is seeded"));
    } else if (size === 0) {
      checks.push(mkCheck("replica-schema", STATUS.WARN, "replica db is 0 bytes — no schema, never seeded; the writer has never authenticated"));
    } else if (size < sizeFloorBytes) {
      checks.push(mkCheck("replica-schema", STATUS.WARN, `replica db is ${size}B (< ${sizeFloorBytes}B floor) — seed incomplete`));
    } else if (!isSqliteFile(dbPath)) {
      checks.push(mkCheck("replica-schema", STATUS.WARN, `replica db is ${Math.round(size / 1024)}KiB but has no SQLite header — corrupt or not a database; every read will miss`));
    } else {
      const tables = readDbTables(dbPath);
      if (tables === null) {
        checks.push(mkCheck("replica-schema", STATUS.INFO, `replica db ${Math.round(size / 1024)}KiB, valid SQLite header — table presence unverified (no sqlite3 reader available)`));
      } else {
        const missing = REQUIRED_REPLICA_TABLES.filter((t) => !tables.includes(t));
        checks.push(
          missing.length > 0
            ? mkCheck("replica-schema", STATUS.WARN, `replica db ${Math.round(size / 1024)}KiB is missing required table(s): ${missing.join(", ")} — the reader cannot prepare its queries`)
            : mkCheck("replica-schema", STATUS.PASS, `replica db ${Math.round(size / 1024)}KiB — schema seeded (${REQUIRED_REPLICA_TABLES.join(" + ")} present)`),
        );
      }
    }
  }

  // (c) token presence — by NAME only, NEVER the value.
  const tokenVal = env[tokenEnv.envVar];
  const tokenSet = typeof tokenVal === "string" && tokenVal.length > 0;
  checks.push(
    tokenSet
      ? mkCheck("replica-token", STATUS.PASS, `${tokenEnv.envVar} is set (len>0, source=${tokenEnv.source})`)
      : mkCheck("replica-token", STATUS.WARN, `${tokenEnv.envVar} not set — the writer cannot authenticate (idle no-op); provision it in a 0600 file the launcher sources`),
  );

  // (d) read-flag ↔ writer consistency.
  if (mode === "on") {
    checks.push(
      dbPresent
        ? mkCheck("replica-read-flag", STATUS.PASS, "CATALYST_LINEAR_REPLICA=on with a local replica present — reads served locally")
        : mkCheck("replica-read-flag", STATUS.WARN, "CATALYST_LINEAR_REPLICA=on but no local replica db — every read MISSES through to live linearis (no relief)"),
    );
  } else if (installed && dbPresent) {
    checks.push(mkCheck("replica-read-flag", STATUS.WARN, "writer running + replica present but CATALYST_LINEAR_REPLICA=off — flip it on to read from the replica"));
  } else {
    checks.push(mkCheck("replica-read-flag", STATUS.INFO, "replica read tier off (CATALYST_LINEAR_REPLICA unset/off)"));
  }

  const tokenMissing = !tokenSet;
  const flagOff = mode !== "on";
  if (tokenMissing && flagOff) {
    checks.push(mkCheck("replica-tier", STATUS.WARN,
      `replica tier INERT end-to-end: token ${tokenEnv.envVar} unset AND CATALYST_LINEAR_REPLICA off. Both must be fixed, token FIRST`));
  } else if (tokenMissing || flagOff) {
    checks.push(mkCheck("replica-tier", STATUS.WARN,
      `replica tier partially configured (${tokenMissing ? `token ${tokenEnv.envVar} unset` : "CATALYST_LINEAR_REPLICA off"}) — reads still fall back`));
  } else {
    checks.push(mkCheck("replica-tier", STATUS.PASS, "replica tier fully configured (token set + read flag on)"));
  }

  return checks;
}

// defaultProcessCommandForPid — the full argv of a live pid, or null. Used ONLY to prove
// a recorded pid still names the program that wrote the record. `kill -0` would answer
// "some process holds this pid", which on a recycled pid is a fresh-looking lie — the same
// fail-closed identity discipline catalyst-monitor.sh applies to its pid files.
function defaultProcessCommandForPid(pid) {
  try {
    const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    const cmd = r.stdout.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

// checkFleetTokenExport — CTL-1908. Does a LOGIN SHELL hand the fleet's Claude subscription
// token to every process this user starts?
//
// THE INCIDENT. 2026-08-17 ~02:00–08:57 CT the entire overnight fleet — three owner sessions
// plus the coordinator's relaunches — stalled on "You've hit your weekly limit", while Ryan's
// own account sat at 78%. `~/.zshenv` sourced `claude-accounts.env` in EVERY zsh, interactive
// or not, exporting CLAUDE_CODE_OAUTH_TOKEN = the fleet's armed account. Claude Code prefers
// the env token over the keychain login, so every shell-launched `claude` — coordinator,
// owners, and Ryan's own terminal until he re-ran /login — silently spent the fleet's budget.
// Seven hours of fleet time, and the symptom named the wrong account.
//
// ⭐ WHY THIS IS A CHECK AND NOT A FIX. The daemon does NOT need the login-shell export:
// `catalyst-execution-core` sources `claude-accounts.env` into its own boot environment
// unconditionally, and `claude --bg` children inherit it from there. So the export buys
// nothing and costs the budget. But `~/.zshenv` is an unmanaged machine dotfile that nothing
// in this repo writes, so the codified form of "keep it off" is a check that SAYS SO on every
// host — measured 2026-08-17 23:2x CT, the laptop had been hand-fixed and BOTH minis had not,
// which is exactly the drift an uncodified hand-fix produces.
export function checkFleetTokenExport(deps = {}) {
  const {
    home = homedir(),
    // The same six candidates check-setup.sh's CTL-869 proxy-leak scan uses. ⛔ `.bashrc` was
    // missing here: a bash operator sourcing the env file from it would inherit the fleet
    // credential in every interactive shell while this check reported PASS off a clean
    // `.profile` (Codex P2 on #3506).
    rcFiles = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"],
    fileExists = existsSync,
    readText = (p) => readFileSync(p, "utf8"),
  } = deps;

  const offenders = [];
  const unreadable = [];
  let scanned = 0;
  for (const rc of rcFiles) {
    const path = resolve(home, rc);
    let text;
    try {
      if (!fileExists(path)) continue;
      text = readText(path);
    } catch {
      // ⛔ NOT a `continue` that leaves `scanned > 0`. An unreadable rc may hold the very export
      // being looked for, and an unreadable `.zshenv` beside a clean `.profile` used to report
      // this host CLEAN — a fail-OPEN in a check whose only value is being trustworthy
      // (Codex P2 on #3506). It now suppresses PASS below.
      unreadable.push(rc);
      continue;
    }
    scanned += 1;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // A COMMENTED line is the fixed state, not a finding — that is precisely how the laptop
      // and (since tonight) the minis carry the fix, so matching the bare text would report
      // every fixed host as broken.
      if (/^\s*#/.test(line)) continue;
      // ⚠️ Only an ACTUAL source of the file counts. Merely naming it — `CLAUDE_ACCOUNTS_ENV=<path>`,
      // or an alias that cats it — injects nothing, and telling an operator to comment those out is
      // wrong advice from a check they are meant to trust (Codex P2 on #3506).
      //
      // ⛔ And `source`/`.` is NOT anchored to line start, because the form this fleet actually
      // had is `[ -f "$HOME/…/claude-accounts.env" ] && . "$HOME/…/claude-accounts.env"` — the
      // `.` sits after `&&`. check-setup.sh's analogous regex anchors at `^` and would miss the
      // exact line that stalled the fleet for seven hours. Command position is start-of-line or
      // after a shell separator.
      const sourcesEnvFile = /(?:^|[;&|{(]|&&|\|\|)\s*(?:source|\.)\s+[^;&|]*claude-accounts\.env/.test(line);
      const exportsToken = /\bCLAUDE_CODE_OAUTH_TOKEN\s*=/.test(line);
      if (sourcesEnvFile || exportsToken) offenders.push(`${rc}:${i + 1}`);
    }
  }

  if (scanned === 0) {
    return [mkCheck("fleet-token-export", STATUS.INFO, `no readable shell rc files to inspect${unreadable.length ? ` (${unreadable.length} unreadable: ${unreadable.join(", ")})` : ""} — nothing measured, which is not the same as clean`)];
  }
  if (offenders.length === 0 && unreadable.length > 0) {
    return [
      mkCheck(
        "fleet-token-export",
        STATUS.INFO,
        `${scanned} rc file(s) are clean, but ${unreadable.join(", ")} could not be read — the export may be in there, so this is UNKNOWN rather than clean`,
      ),
    ];
  }
  if (offenders.length > 0) {
    return [
      mkCheck(
        "fleet-token-export",
        STATUS.WARN,
        `a login shell exports the FLEET subscription token (${offenders.join(", ")}) — every shell-launched \`claude\` on this host spends the fleet's budget instead of its own login (CTL-1908). The daemon does not need it: catalyst-execution-core sources claude-accounts.env into its own boot env. Comment the line out.`,
      ),
    ];
  }
  return [mkCheck("fleet-token-export", STATUS.PASS, `no login-shell export of the fleet token in ${scanned} shell rc file(s)`)];
}

// checkCloudSyncSkew — CTL-1659. Is the RUNNING cloud-sync writer serving the modules the
// current lockfile resolves? The measured incident (2026-08-04): a dependency fix landed
// on main, the updater pulled it, the install succeeded, and the daemon kept serving the
// OLD modules for days — because `plugin-refresh` stops at `restart_needed` by design and
// the broker's `decideStackReload` hard-codes three components, cloud-sync among neither.
// Nothing was red. This converts "invisible for weeks" into "named on the next doctor run"
// — the property that was actually missing, and worth having even where a restart cannot
// fix the drift (a partial install from the 180s SIGKILL ceiling).
//
// THREE THINGS IT WILL NOT DO, each one a way the check could otherwise report healthy
// while the defect is present:
//   • it never PASSes on absent input (no boot record → WARN "skew unknown"): a daemon
//     that predates this feature, or whose breadcrumb write failed, is unmeasured, not
//     clean. The first pipeline pass after deploy legitimately reads WARN.
//   • it never PASSes on STALE input: the record's pid must still name a live
//     cloud-sync.mjs, or the whole comparison is graded against the wrong process.
//   • it never PASSes on ZERO comparisons ([].every(p) === true), and never derives the
//     "loaded" side from the lockfile — that would re-manufacture the very claim under
//     test (the CTL-1646 shadowed-install class).
// Advisory by construction: WARN/INFO/PASS only, NEVER FAIL. It sits in the checkCloudSync
// family, whose FAIL count gates catalyst-join activation. The ALARM is not this check —
// doctor is on-demand, and an on-demand-only check reproduces "invisible until a human
// looks"; the alerting surface is the writer's own heartbeat line (depSkewFields →
// cloud-sync.log → Alloy → Loki).
export function checkCloudSyncSkew(deps = {}) {
  const {
    label = CLOUD_SYNC_AGENT_LABEL,
    laDir = defaultLaunchAgentsDir(),
    agentInstalled = defaultAgentInstalled,
    processAlive = defaultCloudSyncProcessAlive,
    depsPath = getCloudSyncDepsPath(),
    readBreadcrumb = (p) => readDepsBreadcrumb(p),
    evaluate = evaluateDepSkew,
    readText = (p) => readFileSync(p, "utf8"),
    readJson = (p) => JSON.parse(readFileSync(p, "utf8")),
    processCommandForPid = defaultProcessCommandForPid,
    // CTL-1931: the SAME resolver the real pull path and checkPluginSourceFreshness use, so
    // "the root this node maintains" cannot drift from "the root this check expects".
    //
    // ⚠️ `repoConfigPath` is passed explicitly (Codex #3493 P2). The resolver's precedence is
    // env > REPO `.catalyst/config.json` > machine config, and the parameter defaults to
    // null — so `resolvePluginCheckoutRoots({})` silently skips the repo rung the broker and
    // updater pull paths both supply. That matters here in a way it does not for a purely
    // advisory reader: this check is GRADE-CHANGING, so on a node whose `pluginDirs` lives
    // only in Layer 1 it would resolve no roots and sit inconclusive forever, and on a node
    // whose machine config holds an OLDER value it would compare against a root the node no
    // longer maintains and report a false DEPENDENCY SKEW on a healthy host.
    resolveExpectedRoots = () => resolvePluginCheckoutRoots({ repoConfigPath: DOCTOR_REPO_CONFIG_PATH }),
  } = deps;

  // Wrapped whole: this check reads files and spawns `ps`, and a throw here would abort
  // the entire doctor run. A failure to measure degrades to a WARN that says so.
  try {
    let record = null;
    try {
      record = readBreadcrumb(depsPath);
    } catch (err) {
      return [mkCheck("cloud-sync-skew", STATUS.WARN, `dependency-skew boot record unreadable (${depsPath}): ${err?.message ?? String(err)} — skew is UNKNOWN`)];
    }

    // Gate: no writer agent, no live writer, and no boot record → nothing is loaded on
    // this node, so nothing can be skewed. One INFO, matching checkCloudSync's own gate
    // so this check is safe to wire into every class.
    const installed = agentInstalled(label, laDir);
    if (!installed && !record) {
      return [mkCheck("cloud-sync-skew", STATUS.INFO, "cloud-sync writer not installed on this node — no loaded modules to compare")];
    }

    if (!record) {
      const alive = processAlive();
      return [
        mkCheck(
          "cloud-sync-skew",
          STATUS.WARN,
          `no dependency-skew boot record at ${depsPath} — skew is UNKNOWN${alive ? " while a writer is running" : ""}. ` +
            "Expected before the writer's first boot after CTL-1659 ships; it self-clears on the next restart (launchctl kickstart -k gui/$UID/" +
            `${label}).`,
        ),
      ];
    }

    // The guard sits at the CALL SITE, not inside the default: an INJECTED resolver can
    // throw too, and putting the try/catch in the default would let that escape to the
    // outer catch and be reported as a generic check failure instead of the specific
    // inconclusive serving-root verdict. null degrades to INCONCLUSIVE, never to a pass.
    let expectedRoots = null;
    try {
      expectedRoots = resolveExpectedRoots();
    } catch {
      expectedRoots = null;
    }
    const result = evaluate({ breadcrumb: record, readText, readJson, processCommandForPid, expectedRoots });
    const bad = result.verdicts.filter((v) => v.status !== "ok");
    if (bad.length === 0) {
      return [mkCheck("cloud-sync-skew", STATUS.PASS, `loaded modules match the lockfile — ${result.verdicts.map((v) => v.link).join(", ")} all verified`)];
    }
    // WARN either way, but lead with the skew when there is one: a confirmed drift is
    // actionable now, whereas an inconclusive link is a request to look again.
    const lead = result.skew ? "DEPENDENCY SKEW" : "dependency skew UNKNOWN";
    return [mkCheck("cloud-sync-skew", STATUS.WARN, `${lead}: ${bad.map((v) => `[${v.link}] ${v.detail}`).join(" | ")}`)];
  } catch (err) {
    return [mkCheck("cloud-sync-skew", STATUS.WARN, `dependency-skew check could not run: ${err?.message ?? String(err)} — skew is UNKNOWN, not absent`)];
  }
}

// defaultClusterGit — a capturing git runner for the freshness check. Returns
// { status, stdout }; never throws. Injectable so the check stays hermetic.
function defaultClusterGit(args) {
  try {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 5_000 });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "" };
  } catch {
    return { status: 1, stdout: "" };
  }
}

// checkClusterSecretFreshness — CTL-1393. ADVISORY ONLY (never FAILs — runDoctor's
// exit code = FAIL count and catalyst-join gates activation on exit 0, so a
// transient staleness must never block a node; the running daemon self-heals within
// ~5 min via refreshClusterSecretsIfChanged, same WARN-not-FAIL rationale as
// checkReaper / checkCloudTokenEnv). Compares the durable .cluster-sync-state.json
// marker's lastDecryptedSha against the cluster clone's HEAD: when secrets/ changed
// between them, the node is running on STALE secrets (a rotation reached the clone
// but not the running daemon). All reads are injectable + fail-open.
export function checkClusterSecretFreshness(deps = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    statePath = getClusterSyncStatePath(),
    git = defaultClusterGit,
    fileExists = (p) => existsSync(p),
    readState = (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return null;
      }
    },
  } = deps;
  const checks = [];
  const NAME = "cluster-secret-freshness";

  // No clone → node is not on the GitOps secret control plane. INFO (never blocks).
  if (!fileExists(resolve(clusterDir, ".git"))) {
    checks.push(
      mkCheck(
        NAME,
        STATUS.INFO,
        "no catalyst-cluster clone — node is not on the GitOps secret control plane (expected for a standalone node)",
      ),
    );
    return checks;
  }

  const headRes = git(["-C", clusterDir, "rev-parse", "HEAD"]);
  const head = headRes?.status === 0 ? (headRes.stdout || "").trim() : "";
  if (!head) {
    checks.push(
      mkCheck(NAME, STATUS.INFO, "catalyst-cluster clone present but HEAD unresolved — nothing to compare"),
    );
    return checks;
  }

  const state = readState(statePath);
  const lastSha = typeof state?.lastDecryptedSha === "string" ? state.lastDecryptedSha : null;
  if (!lastSha) {
    checks.push(
      mkCheck(
        NAME,
        STATUS.WARN,
        `no cluster-sync marker (${statePath}) — the daemon has not recorded a secret decrypt; ` +
          "restart the execution-core daemon (or run a cluster sync) to materialize current secrets",
      ),
    );
    return checks;
  }

  if (lastSha === head) {
    checks.push(
      mkCheck(
        NAME,
        STATUS.PASS,
        `cluster secrets current at HEAD ${head.slice(0, 8)} (last decrypted ${state?.lastDecryptedAt ?? "unknown"})`,
      ),
    );
    return checks;
  }

  // HEAD advanced past the last decrypt — did secrets/ actually change? exit 0 =
  // identical (not stale); anything else (changed, or an unknown/force-pushed sha) =
  // treat as stale and surface it.
  const diff = git(["-C", clusterDir, "diff", "--quiet", lastSha, head, "--", "secrets/"]);
  if (diff?.status === 0) {
    checks.push(
      mkCheck(
        NAME,
        STATUS.PASS,
        `cluster HEAD advanced ${lastSha.slice(0, 8)}→${head.slice(0, 8)} but secrets/ unchanged — node secrets are current`,
      ),
    );
    return checks;
  }

  checks.push(
    mkCheck(
      NAME,
      STATUS.WARN,
      `running on STALE secrets — secrets/ changed between the last decrypt (${lastSha.slice(0, 8)}) and ` +
        `cluster HEAD (${head.slice(0, 8)}); the running daemon refreshes within ~5 min, else restart the ` +
        "execution-core daemon or run a cluster sync",
    ),
  );
  return checks;
}

// checkConfigScopeLeak — CTL-1214. Flags a committed Layer-1 .catalyst/config.json
// that still carries node/cluster-scoped keys, or a legacy .catalyst/hosts.json
// roster file. `.catalyst/config.json` is committed per-repo and must carry ONLY
// project-identity fields; the project roster (monitor.linear.teams[]) belongs in
// the CLUSTER scope (catalyst-cluster/cluster.json → projects[]), and repoColors /
// the orchestration.*/feedback.*/sweep.* stanzas belong in the NODE scope
// (~/.config/catalyst/config.json). Carrying them in the committed repo config
// leaks machine/cluster state into version control (and violates CLAUDE.md's
// "keep PROJ / keep null / don't commit Linear IDs" rule).
//
// Reuses the single-source-of-truth leak-category list (RELOCATED_LAYER1_KEYS) +
// pure validator (validateLayer1Config) from lib/validate-catalyst-config.mjs —
// the same module the Phase-1 schema tests exercise — so there is exactly one
// definition of "what leaks". Back-compat: presence of a relocated key does NOT
// invalidate the config at runtime; this check is an advisory migration tracker
// (STATUS.WARN, never FAIL during the back-compat window) that tells operators
// which repos still need slimming. It must stay WARN until Phase 6 slims the
// committed configs, because runDoctor's exit code = FAIL count and
// catalyst-join.sh gates member activation on doctor exit 0.
//
// Injected deps (all have real defaults):
//   readLayer1      — () => string   (raw Layer-1 config body; "" when absent)
//   hostsJsonExists — () => boolean  (.catalyst/hosts.json present in this repo?)
export function checkConfigScopeLeak(deps = {}) {
  const {
    readLayer1 = () => {
      try {
        return readFileSync(layer1Path(), "utf8");
      } catch {
        return "";
      }
    },
    hostsJsonExists = () => existsSync(resolve(_repoRoot(), ".catalyst", "hosts.json")),
  } = deps;

  const checks = [];

  const body = readLayer1();
  let parsed = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      checks.push(
        mkCheck(
          "config-scope-leak",
          STATUS.INFO,
          "Layer-1 .catalyst/config.json is unreadable/malformed — cannot check for scope leaks",
        ),
      );
      return checks;
    }
  }

  const { deprecatedKeys } = validateLayer1Config(parsed ?? {});
  const hostsLeak = hostsJsonExists();

  if (deprecatedKeys.length === 0 && !hostsLeak) {
    checks.push(
      mkCheck(
        "config-scope-leak",
        STATUS.PASS,
        "Layer-1 .catalyst/config.json carries only project-identity fields (no node/cluster scope leak)",
      ),
    );
    return checks;
  }

  // Name each leaked stanza + its correct destination so the remediation is actionable.
  const leaks = [];
  for (const key of deprecatedKeys) {
    const entry = RELOCATED_LAYER1_KEYS.find((e) => e.path === key);
    const dest = entry ? `${entry.scope} scope → ${entry.destination}` : "node/cluster scope";
    leaks.push(`catalyst.${key} (relocate to ${dest})`);
  }
  if (hostsLeak) {
    leaks.push(
      ".catalyst/hosts.json (roster relocates to cluster scope → catalyst-cluster/cluster.json → roster)",
    );
  }

  checks.push(
    mkCheck(
      "config-scope-leak",
      // WARN, not FAIL, during the back-compat migration window (CTL-1214). runDoctor
      // returns the FAIL count as the process exit code, and catalyst-join.sh
      // do_doctor_gate() gates cluster-member activation strictly on exit 0
      // (run_stage "doctor" do_doctor_gate || exit 1). The committed Layer-1
      // .catalyst/config.json is NOT yet slimmed (Phase 6 deferred), so EVERY node
      // today still carries these relocated keys. Emitting FAIL here would make
      // `catalyst doctor` exit non-zero on every host and fail-close the join gate —
      // a runtime regression, contradicting the "purely observational" contract.
      // This mirrors checkReaper's deliberate WARN ("a FAILing reaper check would
      // BLOCK a node from self-healing via join"). Promote to FAIL only after Phase 6
      // slims the committed configs.
      STATUS.WARN,
      `Layer-1 .catalyst/config.json carries node/cluster-scoped keys (advisory migration tracker): ${leaks.join("; ")}. ` +
        `Remediation: run plugins/dev/scripts/migrate-config-to-node.sh to seed the node config ` +
        `(~/.config/catalyst/config.json), move the project roster into ` +
        `catalyst-cluster/cluster.json, then remove these keys from the committed .catalyst/config.json.`,
    ),
  );
  return checks;
}

// ─── CTL-1793: config provenance + host-divergence advisory ─────────────────
//
// checkConfigProvenance — surfaces the two per-host config facts that today are
// invisible to EVERY existing surface:
//
//   1. The Layer-1 file the DAEMON reads is not the one doctor grades. doctor's
//      other config checks read either the plugin checkout's config (layer1Path())
//      or doctor's own cwd (resolveDoctorLayer1Path()); the daemon reads whatever
//      the launcher pinned via CATALYST_CONFIG_FILE — and when nothing pins it,
//      whatever directory the daemon happened to be launched from. On a live
//      worker host those were measured to be DIFFERENT FILES with different
//      contents (one carrying no catalyst.orchestration stanza at all), so every
//      Layer-1-driven feature ran on defaults with nothing surfaced anywhere.
//   2. Which knobs are in force because of a per-host ENV OVERRIDE rather than a
//      committed file — including overrides that live only in the daemon's
//      execution-core.env and are therefore invisible to a naive process.env read.
//
// ADVISORY ONLY — this check never returns STATUS.FAIL, and that is enforced
// structurally, not just by intent:
//   • STATUS.FAIL is never referenced in this function;
//   • the whole body is wrapped in one try/catch that degrades to INFO, so a throw
//     can neither crash the suite (runDoctor's Promise.all has no per-check
//     isolation) nor push the exit code off zero;
//   • doctor.test.mjs asserts BOTH a fixture matrix (no fixture ever yields FAIL)
//     and a source-level guard (this function's body contains no STATUS.FAIL), so
//     a future edit that adds one fails CI immediately.
// This matters because runDoctor returns the FAIL count as its exit code and
// catalyst-join.sh gates member activation on exit 0: a FAIL here would take an
// otherwise-healthy fleet red overnight for a purely observational finding.
//
// It REPORTS the daemon/doctor Layer-1 split; it deliberately does NOT repair it.
// Changing which file checkConfigScopeLeak (and friends) grade is a behavior
// change on a live host and belongs in its own ticket.
export function checkConfigProvenance(deps = {}) {
  try {
    const {
      // The dump is injectable so the fixture matrix needs no filesystem at all.
      dump = collectConfigDump(),
      // The Layer-1 doctor's own config checks read (cwd/env chain).
      doctorLayer1 = resolveDoctorLayer1Path(),
      // The Layer-1 of the plugin CHECKOUT (what checkConfigScopeLeak grades).
      repoLayer1 = layer1Path(),
      // Only a WORKER runs the execution-core daemon (monitor/developer run the
      // observation substrate only — AGENTS.md "Deployment Mode": node class).
      // On a non-worker the "daemon's Layer-1" question has no subject, so the
      // divergence branch reports INFO instead of WARN: a permanent WARN on every
      // laptop/monitor `catalyst doctor` run is noise that trains operators to
      // ignore the check. The env-override half stays useful on every class.
      nodeClass = resolveNodeClass().class,
    } = deps;

    const checks = [];
    const runsDaemon = nodeClass === "worker";
    // Non-worker: the finding is real but not actionable here — soften to INFO.
    const DIVERGENCE = runsDaemon ? STATUS.WARN : STATUS.INFO;
    const scopeNote = runsDaemon
      ? ""
      : ` (informational on a ${nodeClass} node — it runs no execution-core daemon)`;
    const daemon = dump?.daemonLayer1 ?? null;
    const fp = typeof dump?.fingerprint === "string" ? dump.fingerprint.slice(0, 12) : "unknown";
    const suffix = ` [fingerprint=${fp}; compare hosts with: diff <(ssh a catalyst config dump --json) <(ssh b catalyst config dump --json)]`;

    // ── (1) daemon-visible Layer-1 ───────────────────────────────────────────
    if (!daemon) {
      checks.push(
        mkCheck("config-provenance", STATUS.INFO, "daemon Layer-1 resolution was not computed for this run" + suffix),
      );
    } else if (!daemon.pinned) {
      checks.push(
        mkCheck(
          "config-provenance",
          DIVERGENCE,
          "the execution-core daemon's Layer-1 config path is UNPINNED — no CATALYST_CONFIG_FILE in the " +
            "environment or in ~/.config/catalyst/execution-core.env, and no $CATALYST_DIR/.catalyst/config.json " +
            "to fall back on, so the daemon reads whatever directory it was launched from. That file may differ " +
            `from the one doctor grades (${doctorLayer1}). Remediation: export CATALYST_CONFIG_FILE=<repo>/.catalyst/config.json ` +
            "in ~/.config/catalyst/execution-core.env (CTL-1793)" +
            scopeNote +
            suffix,
        ),
      );
    } else if (daemon.path !== doctorLayer1) {
      checks.push(
        mkCheck(
          "config-provenance",
          DIVERGENCE,
          `the daemon reads a DIFFERENT Layer-1 config than doctor grades: daemon="${daemon.path}" ` +
            `(pinned via ${daemon.source}) vs doctor="${doctorLayer1}"` +
            (repoLayer1 !== doctorLayer1 ? ` (plugin checkout: "${repoLayer1}")` : "") +
            " — every Layer-1-driven setting reported by other checks may not be the one in force (CTL-1793)" +
            scopeNote +
            suffix,
        ),
      );
    } else if (dump.layer1?.present && dump.layer1?.parsed && !dump.layer1?.hasOrchestration) {
      checks.push(
        mkCheck(
          "config-provenance",
          DIVERGENCE,
          `the daemon's Layer-1 config ("${daemon.path}") carries no catalyst.orchestration stanza — ` +
            "executor routing, the reaper/worktree-refresh/stale-PR timers, reconcile mode and the " +
            "eligible query all silently run on built-in defaults (CTL-1793)" +
            scopeNote +
            suffix,
        ),
      );
    } else if (!dump.layer1?.present || !dump.layer1?.parsed) {
      checks.push(
        mkCheck(
          "config-provenance",
          DIVERGENCE,
          `the daemon's Layer-1 config ("${daemon.path}") is ` +
            (dump.layer1?.present ? "present but MALFORMED" : "ABSENT") +
            " — every Layer-1-driven setting runs on built-in defaults (CTL-1793)" +
            scopeNote +
            suffix,
        ),
      );
    } else {
      checks.push(
        mkCheck(
          "config-provenance",
          STATUS.PASS,
          `daemon and doctor read the same Layer-1 config ("${daemon.path}", pinned via ${daemon.source})` + suffix,
        ),
      );
    }

    // ── (2) per-host env overrides ───────────────────────────────────────────
    // INFO, never a grade change: an override is a legitimate operator action.
    // The point is that it should be VISIBLE — these are the knobs that differ
    // between two hosts running the same committed config.
    const overrides = (dump?.rows ?? []).filter((r) => r.provenance === "env-override" && !r.secret);
    checks.push(
      overrides.length === 0
        ? mkCheck("config-env-overrides", STATUS.INFO, "no config knob is in force via a per-host env override")
        : mkCheck(
            "config-env-overrides",
            STATUS.INFO,
            `${overrides.length} config knob(s) in force via a per-host env override (not the committed config): ` +
              overrides.map((r) => `${r.key}=${String(r.value)} (${r.envVar})`).join("; "),
          ),
    );

    return checks;
  } catch (err) {
    // Total: any throw degrades to INFO. Never FAIL, never a crashed suite.
    return [
      mkCheck(
        "config-provenance",
        STATUS.INFO,
        `config provenance could not be resolved (advisory only): ${err?.message ?? String(err)}`,
      ),
    ];
  }
}

// ─── CTL-1481: worker:<host> label ownership visibility advisory ────────────

// defaultLinearGraphQLPost — minimal fetch-based Linear GraphQL POST, mirroring
// checkBotCredentials' inline probe above. Injectable via deps.post so tests
// never hit the network; throws on a non-2xx response (caught by the caller).
async function defaultLinearGraphQLPost(query, token) {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// parseEnvFileVar / overlayDaemonDrainEnv — CTL-1678 (Codex P2). Read a single
// `[export ]KEY=val` assignment out of an env-file body (same shape parseEnvFileExecutor
// matches for CATALYST_EXECUTOR) and overlay the two durable drain overrides onto an env
// object. The daemon launcher `source`s execution-core.env AFTER inheriting the ambient
// env, so a file assignment wins over an inherited one — the overlay reproduces that
// precedence (file value replaces ambient only when the file actually sets the key).
function parseEnvFileFlag(text, re) {
  if (typeof text !== "string" || !text) return null;
  const m = text.match(re);
  return m ? m[1] : null;
}
function overlayDaemonDrainEnv(env, envFileText) {
  // Literal per-key regexes (no dynamic RegExp) mirroring parseEnvFileExecutor. File
  // value replaces ambient only when the file actually sets the key (matching `source`).
  const out = { ...env };
  const dd = parseEnvFileFlag(envFileText, /^\s*(?:export\s+)?CATALYST_DRAIN_DISABLED=["']?([^"'\s]+)/m);
  if (dd !== null) out.CATALYST_DRAIN_DISABLED = dd;
  const bd = parseEnvFileFlag(envFileText, /^\s*(?:export\s+)?CATALYST_BOOT_DRAINED=["']?([^"'\s]+)/m);
  if (bd !== null) out.CATALYST_BOOT_DRAINED = bd;
  return out;
}

// checkDrainDisabled — CTL-1678. Advisory report of the per-node drain override.
// A worker with CATALYST_DRAIN_DISABLED=1 permanently ignores the drain flag; this
// surfaces the third "draining-but-ignored" state so an operator scanning doctor
// output sees an active neutralization. NEVER FAILs (advisory, like checkWorkerLabels)
// — the override is an intended operator action, so its presence must not block the
// activation gate. WARN only when the flag is present AND being ignored; PASS/INFO
// otherwise. Worker-suite only (the env is worker-only).
export function checkDrainDisabled(deps = {}) {
  const {
    env = process.env,
    orchDir = getExecutionCoreDir(),
    resolveDrainState: _resolve = resolveDrainState,
    // CTL-1678 (Codex P2): the durable CATALYST_DRAIN_DISABLED / CATALYST_BOOT_DRAINED
    // overrides live in the machine-local execution-core.env that the daemon launcher
    // sources at start — `catalyst-doctor` runs doctor.mjs WITHOUT sourcing it, so a
    // naive process.env read reports "honors the drain flag" while the running daemon
    // ignores it (contradictory operator health output). Overlay the file's values onto
    // the ambient env (file wins, matching `source` semantics) so this check mirrors the
    // daemon's EFFECTIVE env. Mirrors checkSdkDaemonEnv's env-file read for CATALYST_EXECUTOR.
    // Injectable seam; default reads the real file, absent/unreadable → "".
    execCoreEnvPath = defaultExecCoreEnvPath(),
    readEnvFile = (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
    // CTL-1678 (Codex round-3 P1): when a daemon is RUNNING, the file overlay below can
    // still lie — the overrides are restart-only, so a file edited after daemon start
    // describes the NEXT daemon, not this one. Prefer the live daemon's boot-time
    // snapshot (pid-gated: a marker from a dead daemon is ignored); the overlay is the
    // fallback for the stopped-daemon case, where next-start config is the honest answer.
    readRuntimeEnv = readDaemonRuntimeEnv,
  } = deps;
  const runtime = readRuntimeEnv(orchDir);
  const effectiveEnv = runtime
    ? {
        CATALYST_DRAIN_DISABLED: runtime.drainDisabled ? "1" : "0",
        // drainDisabled is recorded post-precedence (boot-drain already folded in), so
        // the synthetic env never re-triggers isDrainDisabled's boot-drain gate.
        CATALYST_BOOT_DRAINED: "0",
      }
    : overlayDaemonDrainEnv(env, readEnvFile(execCoreEnvPath));
  const { flagPresent, disabled } = _resolve(orchDir, { env: effectiveEnv });
  if (disabled && flagPresent) {
    return mkCheck(
      "drain-disabled",
      STATUS.WARN,
      "drain flag is present but being IGNORED (CATALYST_DRAIN_DISABLED=1) — " +
        "this node admits new work despite an active drain (CTL-1678)",
    );
  }
  if (disabled) {
    return mkCheck(
      "drain-disabled",
      STATUS.PASS,
      "drain-disabled — this node ignores the drain flag (CATALYST_DRAIN_DISABLED=1, CTL-1678)",
    );
  }
  return mkCheck(
    "drain-disabled",
    STATUS.INFO,
    "not drain-disabled — this node honors the drain flag (CTL-1678)",
  );
}

// Advisory report for registry entries whose checkout declares a different
// Linear team. This check is total and never FAILs: host registry state is an
// operator repair, and doctor's FAIL count gates worker activation.
export function checkRegistryTeamIdentity(deps = {}) {
  const { listProjects: readProjects = listProjects } = deps;
  let projects;
  try {
    projects = readProjects();
  } catch (err) {
    return mkCheck(
      "registry-team-identity",
      STATUS.INFO,
      `registry unreadable — team identity not checked (${err?.message ?? "unknown"}) (CAT-52)`,
    );
  }
  if (!projects.length) {
    return mkCheck(
      "registry-team-identity",
      STATUS.INFO,
      "registry has no projects — nothing to check (the zero-project warning is the daemon's, CTL-854)",
    );
  }
  const mismatches = projects.filter((project) => project?.identity?.matches === false);
  if (mismatches.length) {
    const details = mismatches
      .map((project) =>
        `${project.team} → ${project.repoRoot} (declares "${project.identity.declared}")`)
      .join("; ");
    return mkCheck(
      "registry-team-identity",
      STATUS.WARN,
      `${mismatches.length} registry entr${mismatches.length === 1 ? "y" : "ies"} point at a ` +
        "checkout that declares a DIFFERENT Linear team — worktrees cut from it inherit that " +
        `checkout's Layer-1 catalyst.linear config and ticket prefix: ${details} (CAT-52)`,
    );
  }
  const known = projects.filter((project) => project?.identity?.matches === true).length;
  // No mismatch is NOT the same as verified. An entry whose checkout config is
  // absent, unreadable, malformed, or missing teamKey yields matches:null, and
  // grading that PASS would report a clean contract that was never actually
  // checked — exactly the drift this check exists to surface. Anything short of
  // full verification stays INFO (advisory-only: this check never FAILs).
  if (known < projects.length) {
    const unverified = projects.length - known;
    return mkCheck(
      "registry-team-identity",
      STATUS.INFO,
      `${known}/${projects.length} registry entries verified against their repoRoot's declared ` +
        `teamKey; ${unverified} could not be checked (config absent, unreadable, malformed, or ` +
        "missing catalyst.linear.teamKey) — no mismatch found, but the contract is unverified " +
        "for those entries (CAT-52)",
    );
  }
  return mkCheck(
    "registry-team-identity",
    STATUS.PASS,
    `${known}/${projects.length} registry entries verified against their repoRoot's declared ` +
      "teamKey; no mismatches (CAT-52)",
  );
}

// checkWorkerLabels — CTL-1481. Advisory health of the workspace `worker`
// label group + its `worker:<host>` children (the best-effort claim-win
// VISIBILITY PROJECTION stamped by worker-label.mjs — never the claim
// arbiter; the fence CAS in cluster-claim.mjs stays the source of truth).
// EVERY condition is WARN/INFO/PASS, NEVER FAIL: doctor's exit code is the
// FAIL count and gates catalyst-join activation — a projection label that
// hasn't been provisioned yet must never block a node. Doctor does NOT
// mutate Linear here (repo convention: setup-execution-core-states.sh is the
// sole writer); this check only reports drift and points at the remediation.
export async function checkWorkerLabels(deps = {}) {
  const {
    getRoster = getExistenceHosts,
    // CTL-1616 PR3 cutover (design §9): resolveSecretContract is the LIVE
    // answer now — see resolveLinearTokenLive's docstring for why the PR2
    // shadow comparison this call site carried is retired, not merely muted.
    resolveSecretContract = resolveSecret,
    linearToken = () => resolveLinearTokenLive(resolveSecretContract) ?? "",
    post = defaultLinearGraphQLPost,
  } = deps;

  const REMEDIATION = "run plugins/dev/scripts/setup-execution-core-states.sh";

  const roster = getRoster();
  // Single-host (or empty roster): no ownership ambiguity to visualize.
  if (!Array.isArray(roster) || roster.length <= 1) {
    return [mkCheck("worker-labels", STATUS.INFO, "single-host — worker ownership labels not applicable")];
  }

  const token = linearToken();

  if (!token) {
    return [
      mkCheck("worker-labels", STATUS.INFO, "no LINEAR_API_TOKEN / LINEAR_API_KEY — skipping worker-label check"),
    ];
  }

  // Narrowed server-side to names starting "worker" so the group + children
  // always fit one page regardless of workspace label count (Codex #2650 r3).
  const QUERY = `query { issueLabels(filter: {team: {null: true}, name: {startsWith: "worker"}}, first: 250) { nodes { id name parent { id } } } }`;
  let nodes;
  try {
    const json = await post(QUERY, token);
    if (json?.errors?.length) {
      return [mkCheck("worker-labels", STATUS.WARN, `Linear GraphQL error: ${JSON.stringify(json.errors)}`)];
    }
    nodes = json?.data?.issueLabels?.nodes;
    if (!Array.isArray(nodes)) {
      return [mkCheck("worker-labels", STATUS.WARN, "unexpected issueLabels response shape from Linear")];
    }
  } catch (err) {
    return [mkCheck("worker-labels", STATUS.WARN, `Linear unreachable: ${err?.message ?? err}`)];
  }

  // #2631-safe match: the exclusive-group marker is parent==null + the group
  // name, NOT isGroup (drift-prone — see the CTL-1481 write-test verdict).
  const group = nodes.find((n) => n?.name === WORKER_LABEL_GROUP && n?.parent == null);
  if (!group) {
    return [
      mkCheck(
        "worker-labels",
        STATUS.WARN,
        `workspace label group "${WORKER_LABEL_GROUP}" not found — ${REMEDIATION}`,
      ),
    ];
  }

  const checks = [];
  for (const host of roster) {
    const childName = `${WORKER_LABEL_PREFIX}${host}`;
    const child = nodes.find((n) => n?.name === childName && n?.parent?.id === group.id);
    checks.push(
      child
        ? mkCheck(`worker-label:${host}`, STATUS.PASS, `label "${childName}" present under group "${WORKER_LABEL_GROUP}"`)
        : mkCheck(`worker-label:${host}`, STATUS.WARN, `label "${childName}" missing — ${REMEDIATION}`),
    );
  }
  return checks;
}

// ─── CTL-1375: repo-icon token-scope advisory ────────────────────────────────

// _ownerRepoFromRepoRoot — extract "owner/repo" from a repoRoot filesystem path that
// contains a /github/<owner>/<repo> segment (mirrors monitor-config's registry derivation,
// e.g. "/Users/x/code-repos/github/groundworkapp/Adva" → "groundworkapp/Adva"). Returns
// null when there is no such segment.
function _ownerRepoFromRepoRoot(repoRoot) {
  if (typeof repoRoot !== "string") return null;
  const i = repoRoot.indexOf("/github/");
  if (i === -1) return null;
  const seg = repoRoot
    .slice(i + "/github/".length)
    .split("/")
    .filter(Boolean);
  return seg.length >= 2 ? `${seg[0]}/${seg[1]}` : null;
}

// _isOwnerRepo — a bare "owner/repo" slug (exactly one slash, no whitespace/path).
function _isOwnerRepo(s) {
  return typeof s === "string" && /^[^/\s]+\/[^/\s]+$/.test(s.trim());
}

// resolveDoctorLayer1Path — mirror monitor-config's resolveLayer1ConfigPath (CTL-1375,
// Codex P2 #3 / P3 #1) so the check reads the SAME Layer-1 roster the running monitor
// resolves: honor the CATALYST_CONFIG_FILE / CATALYST_CONFIG_PATH env pointers the
// daemon/deploy sets, then fall back to ${cwd}/.catalyst/config.json EXACTLY like the
// monitor (not the plugin-repo config) — so an interactive `catalyst doctor` from a project
// repo checks that repo's roster, not Catalyst's checked-in teams.
function resolveDoctorLayer1Path() {
  return (
    process.env.CATALYST_CONFIG_FILE ||
    process.env.CATALYST_CONFIG_PATH ||
    resolve(process.cwd(), ".catalyst", "config.json")
  );
}

// defaultConfiguredRepos — the "owner/repo" slugs the monitor daemon ACTUALLY resolves
// favicons for. Mirrors monitor-config's loadMonitorConfig repoOwners FAITHFULLY (CTL-1375,
// Codex P2 #1/#3 + P3 #1/#2/#3):
//   • Build a team-key → owner/repo map first — Layer-1 monitor.linear.teams[] as the base,
//     cluster.json projects[] {teamKey,vcsRepo} overriding BY TEAM KEY (P3 #2: mirrors
//     readClusterProjects, so a cluster rename ADV→new-org/new-name REPLACES the stale
//     Layer-1 slug even when the basename differs, instead of probing both).
//   • Derive a short-name → owner/repo map from that, then the execution-core registry's
//     repoRoot OVERRIDES on top BY SHORT NAME (the live daemon's final override).
//   • Read Layer-1 teams from `(obj.catalyst ?? obj).monitor.linear.teams` so the bare
//     `{ monitor: { linear: { teams } } }` shape works too (P3 #3, mirrors readLayer1Teams).
// Returns the resolved values (the daemon's set), NOT a union of every source — so the
// check never WARNs about a repo the monitor doesn't use. IO is injectable for tests; every
// read fail-opens.
export function defaultConfiguredRepos(io = {}) {
  const {
    readLayer1 = () => readFileSync(resolveDoctorLayer1Path(), "utf8"),
    readCluster = () => readClusterConfig(),
    readRegistry = () => readFileSync(getRegistryPath(), "utf8"),
  } = io;

  // team-key(UPPERCASED) → owner/repo: Layer-1 base, cluster overrides by team key
  // (mirrors readClusterProjects' byKey dedup, cluster wins).
  const byTeam = new Map();
  const setTeam = (key, slug) => {
    if (!_isOwnerRepo(slug) || key == null || String(key).trim() === "") return;
    byTeam.set(String(key).trim().toUpperCase(), slug.trim());
  };

  // 1. Layer-1 monitor.linear.teams[] — bare {monitor…} OR {catalyst:{monitor…}} (P3 #3).
  try {
    const obj = JSON.parse(readLayer1());
    const teams = (obj?.catalyst ?? obj)?.monitor?.linear?.teams;
    if (Array.isArray(teams)) for (const t of teams) setTeam(t?.key, t?.vcsRepo);
  } catch {
    /* absent/malformed Layer-1 → skip */
  }
  // 2. cluster.json projects[] {teamKey, vcsRepo} — override by team key (P3 #2).
  try {
    const cluster = readCluster();
    if (Array.isArray(cluster?.projects)) for (const p of cluster.projects) setTeam(p?.teamKey, p?.vcsRepo);
  } catch {
    /* absent/malformed cluster config → skip */
  }

  // short-name(lowercased) → owner/repo, derived from the team-resolved set; then the
  // registry OVERRIDES by short-name, exactly as loadMonitorConfig keys repoOwners.
  const byShort = new Map();
  const setShort = (slug) => {
    const short = slug.split("/").at(-1)?.toLowerCase();
    if (short) byShort.set(short, slug);
  };
  for (const slug of byTeam.values()) setShort(slug);
  // 3. execution-core registry projects[].repoRoot (the live override — WINS, by short-name).
  try {
    const reg = JSON.parse(readRegistry());
    if (Array.isArray(reg?.projects)) {
      for (const p of reg.projects) {
        const slug = _ownerRepoFromRepoRoot(p?.repoRoot);
        if (slug) setShort(slug);
      }
    }
  } catch {
    /* absent/malformed registry → skip */
  }
  return [...byShort.values()];
}

// defaultProbeContents — does the effective `gh` token resolve the PRIVATE
// /repos/<owner>/<repo>/contents endpoint? (the exact endpoint repo-icon-fetcher probes).
// gh ENOENT → { ghMissing: true } (environmental, skip); else { ok, status }.
function defaultProbeContents(ownerRepo) {
  const r = spawnSync("gh", ["api", `/repos/${ownerRepo}/contents`, "--silent"], {
    timeout: 8000,
    encoding: "utf8",
  });
  if (r.error && r.error.code === "ENOENT") return { ghMissing: true };
  return { ok: r.status === 0, status: r.status };
}

// checkRepoIconTokenScope — CTL-1375. ADVISORY ONLY (never FAIL). The orch-monitor daemon
// auto-detects each configured team's repo favicon by probing /repos/<owner>/<repo>/contents
// with the effective `gh` token (repo-icon-fetcher.ts). For a PRIVATE repo (e.g.
// rightsite-cloud/Adva) that probe needs an org-read token; if the daemon's token cannot
// read it, the fetcher silently falls back to the PUBLIC org AVATAR — the picker then shows
// the org logo, never the real favicon. This check probes each configured repo and WARNs
// (never FAILs — runDoctor's exit code = FAIL count and catalyst-join gates activation on
// exit 0, so a cosmetic favicon must never block a node, same rationale as checkReaper /
// checkConfigScopeLeak), naming the unreadable repos and telling the operator to provision
// an org-read GH_TOKEN/GITHUB_TOKEN in the MONITOR DAEMON env. All reads injectable +
// fail-open; never throws.
//
// Injected deps (all have real defaults):
//   configuredRepos — () => string[]                ("owner/repo" per configured team)
//   probeContents   — (ownerRepo) => { ok?, status?, ghMissing? }
export function checkRepoIconTokenScope(deps = {}) {
  const { configuredRepos = defaultConfiguredRepos, probeContents = defaultProbeContents } = deps;
  const checks = [];

  let repos;
  try {
    repos = configuredRepos();
  } catch {
    repos = [];
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    checks.push(
      mkCheck(
        "repo-icon-token",
        STATUS.INFO,
        "no configured team repos found — repo-icon token scope not checked",
      ),
    );
    return checks;
  }

  const unreadable = [];
  try {
    for (const ownerRepo of repos) {
      const r = probeContents(ownerRepo);
      if (r && r.ghMissing) {
        // gh absent is environmental and the fetcher already fail-opens to the lucide
        // fallback — an INFO skip, not a token problem.
        checks.push(
          mkCheck(
            "repo-icon-token",
            STATUS.INFO,
            "gh CLI not found on PATH — skipping repo-icon token-scope probe (the fetcher fail-opens)",
          ),
        );
        return checks;
      }
      if (!r || !r.ok) unreadable.push(ownerRepo);
    }
  } catch {
    checks.push(
      mkCheck(
        "repo-icon-token",
        STATUS.INFO,
        "repo-icon token-scope probe errored — skipped (advisory only)",
      ),
    );
    return checks;
  }

  if (unreadable.length === 0) {
    checks.push(
      mkCheck(
        "repo-icon-token",
        STATUS.PASS,
        // Honest scope (CTL-1375, Codex P2 #2): this probes with the token available to the
        // CALLER's environment. The monitor DAEMON is started separately (launchd / the shell
        // running catalyst-monitor.sh) and may carry a different token, so a PASS here does
        // not by itself prove the daemon can read these repos.
        `the gh token available HERE can read contents of all ${repos.length} configured repo(s) — ` +
          `ensure the MONITOR DAEMON's environment carries the same token (launchd plist EnvironmentVariables / ` +
          `the shell that starts catalyst-monitor.sh); a daemon lacking it still falls back to the org avatar`,
      ),
    );
    return checks;
  }

  checks.push(
    mkCheck(
      "repo-icon-token",
      STATUS.WARN,
      `gh token cannot read contents of ${unreadable.join(", ")} (private repo without an ` +
        `org-read token, or repo moved/renamed) — repo-icon detection falls back to the public ` +
        `org avatar instead of the real favicon. Provision an org-read GH_TOKEN/GITHUB_TOKEN in ` +
        `the MONITOR DAEMON environment (launchd plist EnvironmentVariables / the shell that ` +
        `starts catalyst-monitor.sh), not just your interactive shell.`,
    ),
  );
  return checks;
}

// ─── CTL-1355: class-aware grading ───────────────────────────────────────────

// checkNodeClass — grade catalyst.node.class itself. An EXPLICIT but unrecognized
// value (resolveNodeClass.recognized === false, e.g. a typo'd "developr") is the
// single hard FAIL that fail-closes the gate until the value is corrected (the
// resolver already degraded it to the most-restrictive `monitor`). An INFERRED
// default (class unset) is a benign INFO — it grades as `worker` (today's
// behavior, zero change), just noting the role was never declared. An explicit,
// recognized class PASSes. Injectable for tests.
export function checkNodeClass(deps = {}) {
  const { nodeClass = resolveNodeClass(), strict = false } = deps;
  const nc = nodeClass;
  if (!nc.recognized) {
    return [
      mkCheck(
        "node-class",
        STATUS.FAIL,
        `catalyst.node.class "${nc.raw}" is not one of [${NODE_CLASSES.join(", ")}] — ` +
          `treating this node as "${nc.class}" (most restrictive); correct or unset ` +
          `the value in ~/.config/catalyst/config.json (or CATALYST_NODE_CLASS) (CTL-1355)`,
      ),
    ];
  }
  if (nc.inferred) {
    // CTL-1369 PR4 (Codex P2): under the install-verification profile (strict), an INFERRED class is a
    // FAIL — the install's write-config (`catalyst class <x>`) must have PERSISTED catalyst.node.class,
    // so an inferred/absent class means the class write did not take (else later daemons boot as the
    // default worker). In the activation rubric (non-strict) it stays INFO (absent ⇒ worker, zero change).
    if (strict) {
      return [
        mkCheck(
          "node-class",
          STATUS.FAIL,
          `catalyst.node.class is NOT explicitly persisted (inferred "${nc.class}") — the install's ` +
            `write-config must persist it into the Layer-2 config; an inferred class means the ` +
            `'catalyst class <x>' write did not take (the node would boot as the default worker)`,
        ),
      ];
    }
    return [
      mkCheck(
        "node-class",
        STATUS.INFO,
        `catalyst.node.class is not explicitly set — grading as "${nc.class}" ` +
          `(absent ⇒ worker ⇒ today's behavior, zero change). Set CATALYST_NODE_CLASS ` +
          `or catalyst.node.class to make the role explicit`,
      ),
    ];
  }
  return [
    mkCheck(
      "node-class",
      STATUS.PASS,
      `catalyst.node.class="${nc.class}" (explicit, source=${nc.source})`,
    ),
  ];
}

// ─── CTL-1617: deployment-mode consistency grading ───────────────────────────

// checkLayer2PathDivergence — CTL-1616 PR6 follow-up (#2930 round-2 Codex P1).
// On a host that sets CATALYST_MACHINE_CONFIG or XDG_CONFIG_HOME without
// CATALYST_LAYER2_CONFIG_FILE, the fleet's Layer-2 readers/writers are SPLIT:
// legacy readers (catalyst-secret-env.sh, the scheduler's per-tick reload) and
// the write destinations fed by getLayer2ConfigPath use the legacy home chain,
// while the registry-based consumers folded in PR3-PR5 (the OAuth mint chain,
// cloud-token name) use the canonical resolveLayer2Path chain. A credential
// rotation on such a host writes fresh material where half the readers never
// look — so the configuration is UNSUPPORTED until the canonical cutover sweep,
// and this check FAILs it loudly with the real remedy:
// CATALYST_LAYER2_CONFIG_FILE is tier 1 of BOTH chains, pinning every reader
// and writer to one file. On every non-divergent host (all live fleet hosts)
// this check is a silent PASS-less no-op (zero rows).
export function checkLayer2PathDivergence(deps = {}) {
  const {
    env = process.env,
    legacyPathFn = () =>
      env.CATALYST_LAYER2_CONFIG_FILE || resolve(homedir(), ".config", "catalyst", "config.json"),
    canonicalPathFn = () => resolveLayer2Path(env),
  } = deps;
  let legacyRaw;
  let canonicalRaw;
  try {
    legacyRaw = legacyPathFn();
    canonicalRaw = canonicalPathFn();
  } catch {
    return []; // fail-open: a throwing resolver must not invent a divergence
  }
  // #2938 round-2 (Codex P2): a RELATIVE configured path must never be
  // cwd-normalized into agreement — resolveLayer2Path preserves the relative
  // string and canonical consumers read it against THEIR cwd, so a supervised
  // service with a different cwd reads a different (or missing) file. Reject
  // it outright instead of comparing.
  if (!isAbsolute(legacyRaw) || !isAbsolute(canonicalRaw)) {
    return [
      mkCheck(
        "layer2-path-divergence",
        STATUS.FAIL,
        `Layer-2 config path is RELATIVE ("${!isAbsolute(legacyRaw) ? legacyRaw : canonicalRaw}") — ` +
          `each consumer resolves it against its own working directory, so different services read ` +
          `different files; set an ABSOLUTE CATALYST_LAYER2_CONFIG_FILE (tier 1 of BOTH chains — ` +
          `an absolute CATALYST_MACHINE_CONFIG pointing anywhere other than the legacy default ` +
          `path still diverges from the legacy chain and fails the split-brain gate)`,
      ),
    ];
  }
  // #2931 round-2 (Codex P2): NORMALIZE (absolute-only — cwd-independent)
  // before comparing, so an equivalent absolute spelling (e.g.
  // "$HOME/.config/catalyst/../catalyst/config.json") is not a false FAIL.
  const legacyPath = resolve(legacyRaw);
  const canonicalPath = resolve(canonicalRaw);
  if (legacyPath === canonicalPath) return [];
  return [
    mkCheck(
      "layer2-path-divergence",
      STATUS.FAIL,
      `Layer-2 config path is SPLIT-BRAIN on this host: legacy chain resolves "${legacyPath}" ` +
        `(read by catalyst-secret-env.sh + the scheduler reload; fed by cluster-sync writes) but ` +
        `the registry's canonical chain resolves "${canonicalPath}" (read by the OAuth mint chain ` +
        `and cloud-token name resolution) — a credential rotation would land where half the ` +
        `readers never look. This CATALYST_MACHINE_CONFIG/XDG_CONFIG_HOME-divergent layout is ` +
        `unsupported until the canonical reader/writer sweep; set CATALYST_LAYER2_CONFIG_FILE ` +
        `(tier 1 of BOTH chains) in the environment of EVERY supervised service AND interactive ` +
        `shell — no single env file covers them all today (execution-core sources ` +
        `execution-core.env, the monitor's start path sources lib/catalyst-secret-env.sh, shells ` +
        `have their own profile), so the pin must reach each service's own environment source; a ` +
        `pin visible only to this doctor run would pass the check while running services still split`,
    ),
  ];
}

// checkDeploymentModeConsistency — grade catalyst.deployment.mode (CTL-1617
// design §7, all four sub-checks). Every
// message says "deployment mode" fully qualified: this codebase already has
// three unrelated "mode" concepts (catalyst.orchestration.dispatchMode, the
// executor-derived dispatch-mode telemetry, readLinearReplica().mode), so
// bare "mode" in a doctor line is ambiguous.
//
//   1. deployment-mode — always emitted. Explicit+recognized → PASS (value +
//      source). Explicit+UNRECOGNIZED (the resolver already degraded it to
//      "single-host") → INFO deferring to deployment-mode-recognized below,
//      which owns that FAIL — this check's own branches are declared-vs-
//      inferred, not valid-vs-invalid, so it never duplicates check 2's FAIL.
//      Inferred (unset everywhere) → WARN with the declare-it message
//      (mirrors the host-name-source WARN-when-implicit pattern verbatim,
//      ~line 184 above); escalates to FAIL when `strict:true` (the install-
//      verification profile — an installer that was supposed to persist the
//      value and didn't is the CTL-1355 install-correctness pattern, same as
//      checkNodeClass's strict branch above). NOT wired into any strict
//      profile by this PR — see the checksForClass wiring note below.
//   2. deployment-mode-recognized — FAIL when `recognized: false` (explicit
//      typo, already degraded to single-host by the resolver). Same severity
//      class as checkNodeClass's typo path.
//   3. deployment-mode-roster-consistency — GATED on `inferred: false` (a
//      day-one inferred default on a live multi-host cluster must produce
//      only check 1's declare-it WARN, not a second warning here). Reuses
//      the same resolveClusterHosts() resolver checkHostIdentity already
//      calls (no new probe — a cheap, pure, file-backed read, not a network
//      call). Declared single-host + a multi-host roster resolved, OR
//      declared cluster/cloud + no authoritative roster (source=single-host)
//      → WARN. WARN, never FAIL: a transient cluster-repo git-fetch hiccup,
//      or the declare-then-join migration window, must not flip a healthy
//      node's doctor red.
//   4. deployment-mode-tunnel-consistency — GATED on `dm.mode === "cloud"`.
//      Structurally provably inert for single-host/cluster/inferred: the
//      resolver's constant default is always "single-host" (§4 of the
//      design — nothing ever infers "cloud"), so `mode === "cloud"` can only
//      be true via an EXPLICIT, RECOGNIZED value — this one gate covers both
//      "only fires in cloud mode" and "only fires when explicit" from the
//      design in one condition, with no separate `inferred`/`recognized`
//      check needed. Probes the LOCAL monitor's
//      `GET /api/status/webhook-tunnel` (port-resolution spike, CTL-1617 §11
//      Q2: `MONITOR_PORT` env or 7400 — the exact pattern already live in
//      checkMonitorProductionBuild (defined later in this file); deliberately NOT
//      checkReadReplicaReachable's baseUrl, which targets a REMOTE
//      read-replica by design and FAILs on localhost on purpose).
//      `connected: true` → WARN: a live smee tunnel on a declared-cloud node
//      is contrary-to-mode (the cloud SDK connection is the expected event
//      source). Unreachable monitor / any probe failure → INFO "could not
//      verify" — NEVER FAIL; a down local monitor must not contaminate this
//      check (same advisory posture as checkMonitorProductionBuild's
//      INFO-skip).
//
// Injected deps (all have real defaults):
//   deploymentMode      — the resolveDeploymentMode() result object
//                          ({mode,source,inferred,recognized,raw})
//   resolveRoster       — () => { hosts, source, multiHost }
//   strict              — bool, default false (see check 1 above)
//   webhookTunnelBaseUrl — check 4 only: local monitor base URL, default
//                          `http://localhost:${MONITOR_PORT || 7400}`
//   fetch               — check 4 only: default globalThis.fetch
export async function checkDeploymentModeConsistency(deps = {}) {
  const {
    deploymentMode: dm = resolveDeploymentMode(),
    resolveRoster = resolveClusterHosts,
    strict = false,
    webhookTunnelBaseUrl = `http://localhost:${process.env.MONITOR_PORT || 7400}`,
    fetch: _fetch = globalThis.fetch,
  } = deps;

  const checks = [];

  // 1. deployment-mode — always emitted.
  if (!dm.recognized) {
    checks.push(
      mkCheck(
        "deployment-mode",
        STATUS.INFO,
        `deployment mode "${dm.raw}" is not recognized — see deployment-mode-recognized below`,
      ),
    );
  } else if (dm.inferred) {
    checks.push(
      mkCheck(
        "deployment-mode",
        strict ? STATUS.FAIL : STATUS.WARN,
        `deployment mode not declared — treating this node as "${dm.mode}"; set ` +
          `catalyst.deployment.mode (Layer-1 for the fleet default, Layer-2 for this ` +
          `host) or CATALYST_DEPLOYMENT_MODE`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "deployment-mode",
        STATUS.PASS,
        `deployment mode="${dm.mode}" (explicit, source=${dm.source})`,
      ),
    );
  }

  // 2. deployment-mode-recognized — FAIL on an explicit typo.
  if (!dm.recognized) {
    checks.push(
      mkCheck(
        "deployment-mode-recognized",
        STATUS.FAIL,
        `deployment mode "${dm.raw}" is not one of [${DEPLOYMENT_MODES.join(", ")}] — ` +
          `treating this node as "${dm.mode}" (safest); correct or unset the value ` +
          `(source=${dm.source})`,
      ),
    );
  }

  // 3. deployment-mode-roster-consistency — gated on inferred:false.
  if (!dm.inferred) {
    const roster = resolveRoster() ?? {};
    const rosterSource = roster.source ?? "unknown";
    // "declared" vs "resolved": when the explicit value was a typo the resolver
    // DEGRADED it to single-host — the operator declared the typo, not the mode
    // this check is grading. Say "resolved (degraded from an unrecognized
    // value)" in that case so this WARN cannot contradict check 2's FAIL.
    const declaredPhrase = dm.recognized
      ? "declared deployment mode"
      : "resolved deployment mode (degraded from an unrecognized value)";
    if (dm.mode === "single-host" && roster.multiHost) {
      checks.push(
        mkCheck(
          "deployment-mode-roster-consistency",
          STATUS.WARN,
          `${declaredPhrase} "single-host" but a multi-host roster resolved ` +
            `(source=${rosterSource}) — HRW dispatch/recovery gates still partition across it`,
        ),
      );
    } else if ((dm.mode === "cluster" || dm.mode === "cloud") && rosterSource === "single-host") {
      checks.push(
        mkCheck(
          "deployment-mode-roster-consistency",
          STATUS.WARN,
          `${declaredPhrase} "${dm.mode}" but no authoritative roster resolved ` +
            `(source=single-host) — this node effectively runs single-host`,
        ),
      );
    } else {
      checks.push(
        mkCheck(
          "deployment-mode-roster-consistency",
          STATUS.PASS,
          `${declaredPhrase} "${dm.mode}" is consistent with the resolved roster ` +
            `(source=${rosterSource}, multiHost=${Boolean(roster.multiHost)})`,
        ),
      );
    }
  }

  // 4. deployment-mode-tunnel-consistency — gated on mode==="cloud" only (see
  // the doc comment above: structurally provably inert otherwise, since the
  // resolver never infers "cloud").
  if (dm.mode === "cloud") {
    const base = (typeof webhookTunnelBaseUrl === "string" ? webhookTunnelBaseUrl : "").replace(
      /\/+$/,
      "",
    );
    try {
      const res = await _fetch(base + "/api/status/webhook-tunnel", {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!(res?.ok ?? false)) {
        checks.push(
          mkCheck(
            "deployment-mode-tunnel-consistency",
            STATUS.INFO,
            `could not verify webhook-tunnel state for deployment mode "cloud" — ` +
              `${base}/api/status/webhook-tunnel returned HTTP ${res?.status ?? "?"}`,
          ),
        );
      } else {
        const body = await res.json();
        if (body?.connected === true) {
          checks.push(
            mkCheck(
              "deployment-mode-tunnel-consistency",
              STATUS.WARN,
              `smee webhook tunnel is live on a node with declared deployment mode ` +
                `"cloud" — expected event ingestion is the cloud SDK connection, not the ` +
                `smee tunnel`,
            ),
          );
        } else {
          checks.push(
            mkCheck(
              "deployment-mode-tunnel-consistency",
              STATUS.PASS,
              `no smee webhook tunnel is live on this declared-cloud node — consistent ` +
                `with deployment mode "cloud"`,
            ),
          );
        }
      }
    } catch (err) {
      checks.push(
        mkCheck(
          "deployment-mode-tunnel-consistency",
          STATUS.INFO,
          `could not verify webhook-tunnel state for deployment mode "cloud" — local ` +
            `monitor at ${base} could not be verified (unreachable or malformed response: ${err?.message ?? err})`,
        ),
      );
    }
  }

  return checks;
}

// checkEntitlementConsistency — CTL-1785 (W13). Advisory report on the entitlement
// seam: the resolved off/shadow/enforce mode, the active provider (local vs a real
// lease authority), and whether the load-bearing ordering constraint holds
// (ENTITLEMENT_TTL_MS > work-lease TTL). ADVISORY ONLY — never emits STATUS.FAIL,
// so it can never move doctor's exit code or wedge the run (mirrors
// checkDeploymentModeConsistency's INFO/WARN posture). Fleet-topology-independent
// (does not consult resolveRoster), wired into checksForClass for every class.
//
// Deps injectable so tests (and, later, W12's authority) can point every input at
// a fixture: `mode` (the resolved entitlement mode), `entitlementTtlMs` /
// `workLeaseTtlMs` (the ordering pair), and `providerKind` ("local" today;
// "authority" once CTL-1786's lease store is injected).
export function checkEntitlementConsistency(deps = {}) {
  const {
    mode: m = resolveEntitlementMode(),
    entitlementTtlMs = ENTITLEMENT_TTL_MS,
    workLeaseTtlMs = WORK_LEASE_TTL_MS,
    providerKind = "local",
  } = deps;

  const checks = [];

  // 1. entitlement-mode — the resolved rollout mode. INFO for a recognized value
  //    (incl. the inferred `off` default); WARN (never FAIL) for an unrecognized
  //    typo, which degrades to off (byte-identical to today).
  if (!m.recognized) {
    checks.push(
      mkCheck(
        "entitlement-mode",
        STATUS.WARN,
        `entitlement mode "${printableRaw(m.raw)}" is not one of [${ENTITLEMENT_MODES.join(", ")}] — ` +
          `treating this node as "${m.mode}" (byte-identical to today); correct or unset ` +
          `catalyst.entitlement.mode / CATALYST_ENTITLEMENT (source=${m.source})`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "entitlement-mode",
        STATUS.INFO,
        `entitlement mode="${m.mode}" (source=${m.source}${m.inferred ? ", inferred default" : ""})`,
      ),
    );
  }

  // 2. entitlement-provider — which authority answers "may this host take work?".
  //    WARN (advisory) when enforce is selected but only the LOCAL fallback is
  //    wired: the local provider always entitles self (self ∈ its own roster), so
  //    enforce is byte-identical to today until W12 (CTL-1786) injects a real
  //    authority. INFO otherwise.
  if (m.mode === "enforce" && providerKind === "local") {
    checks.push(
      mkCheck(
        "entitlement-provider",
        STATUS.WARN,
        `entitlement mode=enforce but no lease authority is injected — the local fallback ` +
          `provider always entitles self, so enforce is byte-identical to today until the ` +
          `W12 lease authority (CTL-1786) lands`,
      ),
    );
  } else {
    checks.push(
      mkCheck(
        "entitlement-provider",
        STATUS.INFO,
        `entitlement provider=${providerKind}` + (m.mode === "off" ? " (mode=off — provider unused)" : ""),
      ),
    );
  }

  // 3. entitlement-ordering — the load-bearing constraint. INFO when it holds;
  //    WARN (NEVER FAIL — advisory only) if inverted. The leaf's module-load
  //    assertEntitlementOrdering() already throws loudly on a real inversion of
  //    the shipped constants, so a WARN here only surfaces an injected/misconfigured pair.
  const ordersOk = Number(entitlementTtlMs) > Number(workLeaseTtlMs);
  checks.push(
    mkCheck(
      "entitlement-ordering",
      ordersOk ? STATUS.INFO : STATUS.WARN,
      ordersOk
        ? `entitlement TTL ${entitlementTtlMs}ms > work-lease TTL ${workLeaseTtlMs}ms (ordering constraint holds)`
        : `entitlement TTL ${entitlementTtlMs}ms must EXCEED work-lease TTL ${workLeaseTtlMs}ms — ` +
            `an unentitled node would hold work invisible to the reclaim loop (advisory)`,
    ),
  );

  return checks;
}

// ─── CTL-1616 PR2/PR3: secret-contract observability ─────────────────────────
//
// checkSecretContract — INFO-ONLY OBSERVATION (design §7/§9), UNCHANGED by the
// PR3 cutover below. Resolves a handful of SECRET_REGISTRY rows through the
// shared lib/secret-contract.mjs engine and reports them as INFO-level
// observations: presence for `linear-api-token` and `groq-api-key` — NEW
// coverage design §7 asked for ("plus new Linear/Groq presence checks"), since
// no existing doctor check resolved either through the contract pre-CTL-1616.
//
// PR3 (design §9) cuts checkPeerUniqueness/checkBotCredentials/checkWorkerLabels
// over to the contract as their LIVE answer for linear-api-token — see
// resolveLinearTokenLive above — which retires the PR2 shadow-comparison those
// 3 call sites used to run against their own hand-rolled reads (there is no
// hand-rolled answer left there to compare against). checkSecretContract
// itself stays exactly what it was in PR2: an INFO-only observation, not a
// graded check — grading `source` against the active deployment mode's
// expected provider (PASS/WARN/FAIL) is explicitly NOT part of this cutover
// and remains open work for a later PR. checkWebhookIngestion's
// webhook-secret shadow and checkCloudTokenEnv's cloud-token shadow are also
// UNCHANGED — those secrets cut over in their own later migration PRs (design
// §8/§9 PR4-PR6), not this one.
//
// Every emitted check is STATUS.INFO — summarize() never counts INFO toward
// pass/warn/fail (doctor.mjs:1728-1736 — see summarize()), so this check
// cannot move doctor's exit code (the FAIL count) or its pass/warn/fail
// summary line.
//
// Fleet-topology-independent (does not consult resolveRoster) — wired into
// checksForClass's shared prelude for EVERY class, exactly like
// checkDeploymentModeConsistency (CTL-1617) just above it.
export function checkSecretContract(deps = {}) {
  const { env = process.env, deploymentMode = resolveDeploymentModeForShadow(env), resolveSecretFn = resolveSecret } = deps;
  const checks = [];
  for (const id of ["linear-api-token", "groq-api-key"]) {
    // CTL-1616 PR2 (B1): isolated via safeResolveSecretContract — a throwing
    // resolver surfaces as a shadowThrowCheck INFO row for this id instead of
    // crashing the whole doctor run (there is no per-check isolation in
    // runDoctor's Promise.all).
    const resolution = safeResolveSecretContract(resolveSecretFn, id, { env, deploymentMode });
    if (!resolution.ok) {
      checks.push(shadowThrowCheck(`secret-contract-${id}`, id, resolution.error));
      continue;
    }
    const resolved = resolution.value;
    checks.push(
      mkCheck(
        `secret-contract-${id}`,
        STATUS.INFO,
        resolved?.value != null
          ? `secret contract resolves "${id}" (source=${resolved.source}, provider=${resolved.provider})`
          : `secret contract has no resolution for "${id}" (source=${resolved?.source ?? "none"})`,
      ),
    );
  }
  return checks;
}

// ─── Developer/monitor: read-replica REACHABILITY (CTL-1346 + CTL-1355) ───────

// defaultReadReplicaBaseUrl — mirror catalyst-stack _vn_read_replica_base /
// read-replica-config.ts readReplicaBaseUrlFromLayer2: CATALYST_MONITOR_URL env
// override, else Layer-2 catalyst.readReplica.baseUrl. Trimmed; null when neither
// is set (a developer/monitor reads from a worker monitor, never an empty local
// replica). Never throws.
function defaultReadReplicaBaseUrl() {
  const env = process.env.CATALYST_MONITOR_URL;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  try {
    const v = JSON.parse(readFileSync(layer2Path(), "utf8"))?.catalyst?.readReplica?.baseUrl;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

// checkReadReplicaReachable — doctor's value-add over verify-node (which only
// CLASSIFIES the config): an ACTUAL reachability probe of the read endpoint. A
// developer/monitor that can't reach its worker monitor serves a stale/empty board.
//   • unset              → FAIL (no endpoint; resolver refuses to fall back to localhost)
//   • localhost/127      → FAIL (an empty local replica; point at a worker monitor)
//   • remote + 2xx       → PASS
//   • remote + non-2xx   → FAIL (a TCP/any-response check would mask an unhealthy monitor)
//   • remote + unreach   → FAIL (the probe threw / timed out)
// GET + 5 s timeout; a 2xx is the health floor (CTL-1355 F4 — was "any response").
// Probes the lightweight, always-on GET /api/version (server.ts) — orch-monitor
// serves no plain /api/health (only the heavier /api/health/{otel,services}), so a
// /api/health probe would 404 and false-FAIL a healthy read-replica (CTL-1355 P1).
export async function checkReadReplicaReachable(deps = {}) {
  const { baseUrl = defaultReadReplicaBaseUrl(), fetch: _fetch = globalThis.fetch } = deps;
  const base = typeof baseUrl === "string" ? baseUrl.trim() : "";

  if (!base) {
    return [
      mkCheck(
        "read-replica",
        STATUS.FAIL,
        `no read-replica endpoint (CATALYST_MONITOR_URL / catalyst.readReplica.baseUrl ` +
          `unset) — a non-worker node reads from a worker monitor (CTL-1346); point it at ` +
          `one, e.g. http://mini:7400`,
      ),
    ];
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(base)) {
    return [
      mkCheck(
        "read-replica",
        STATUS.FAIL,
        `read-replica endpoint is localhost (${base}) — serves an empty local replica; ` +
          `point at a worker monitor (e.g. http://mini:7400)`,
      ),
    ];
  }
  const url = base.replace(/\/+$/, "") + "/api/version";
  try {
    const res = await _fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    // F4 (CTL-1355): a 2xx is the health floor — any other response (404/5xx/…)
    // means the endpoint answered but is NOT healthy. Honor a real Response.ok;
    // fall back to a 2xx status-range test when a mock omits `ok`.
    const status = res?.status;
    const ok =
      res?.ok ?? (typeof status === "number" && status >= 200 && status < 300);
    if (!ok) {
      return [
        mkCheck(
          "read-replica",
          STATUS.FAIL,
          `read-replica ${url} returned HTTP ${status ?? "?"} — not healthy (a 2xx is required)`,
        ),
      ];
    }
    return [
      mkCheck("read-replica", STATUS.PASS, `read-replica endpoint healthy: ${url} → HTTP ${status}`),
    ];
  } catch (err) {
    return [
      mkCheck(
        "read-replica",
        STATUS.FAIL,
        `read-replica endpoint ${url} unreachable: ${err?.message ?? err}`,
      ),
    ];
  }
}

// ─── Monitor build hygiene (CTL-1372) ─────────────────────────────────────────
// checkMonitorProductionBuild — flag a DEVELOPMENT react-dom bundle served by the
// LOCAL monitor. A dev build calls performance.measure() on every render and never
// clears the User Timing buffer, so PerformanceMeasure entries accumulate unbounded
// in Blink's native buffer (12 GB / 1.8M entries observed in a long-lived PWA tab).
// ADVISORY (never FAIL): a leaky monitor must not block the work daemon from
// activating, but operators should see it. INFO-skips when no local monitor serves.
export async function checkMonitorProductionBuild(deps = {}) {
  const {
    baseUrl = `http://localhost:${process.env.MONITOR_PORT || 7400}`,
    fetch: _fetch = globalThis.fetch,
  } = deps;
  const base = (typeof baseUrl === "string" ? baseUrl : "").replace(/\/+$/, "");
  const skip = (why) => [mkCheck("monitor-build", STATUS.INFO, why)];
  try {
    const rootRes = await _fetch(base + "/", { method: "GET", signal: AbortSignal.timeout(5000) });
    if (!(rootRes?.ok ?? false)) return skip(`no local monitor serving at ${base} — skipping production-build check`);
    const html = (await rootRes.text()) || "";
    const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/);
    if (!asset) return skip(`monitor at ${base} served no /assets bundle — skipping production-build check`);
    const jsRes = await _fetch(base + asset[0], { method: "GET", signal: AbortSignal.timeout(5000) });
    const js = (await jsRes.text()) || "";
    if (js.includes("react-dom-client.development")) {
      return [
        mkCheck(
          "monitor-build",
          STATUS.WARN,
          `local monitor serves a DEVELOPMENT React bundle (${asset[0]}) — it leaks memory via ` +
            `performance.measure() per render and never clears the User Timing buffer (CTL-1372); ` +
            `rebuild production: MONITOR_FORCE_BUILD=1 catalyst-monitor restart`,
        ),
      ];
    }
    return [mkCheck("monitor-build", STATUS.PASS, `local monitor is a production React build (${asset[0]})`)];
  } catch (err) {
    return skip(`local monitor at ${base} unreachable (${err?.message ?? err}) — skipping production-build check`);
  }
}

// ─── Developer/monitor: "will NOT pick up work" (CTL-1355) ────────────────────

// checkWontOwnWork — a developer/monitor MUST sit out of the work pipeline. The
// node class is a LABEL ONLY today — it does not auto-drain or auto-leave the
// roster (config.mjs applyBootDrainPolicy keys drain off CATALYST_BOOT_DRAINED,
// resolveClusterHosts is class-blind) — so this is the check that actually proves
// the node won't be assigned work.
//
// FAIL-CLOSED (CTL-1355 F1): resolveClusterHosts is FAIL-OPEN — an absent/stale/
// malformed cluster-repo clone (the COMMON case on a daemonless dev laptop)
// collapses to { hosts:[self], source:"single-host", multiHost:false }, so a node
// that would own 100% of work under HRW must NOT grade as safe. The PASS condition
// is therefore that we can POSITIVELY confirm the node sits out — never the mere
// ABSENCE of a confirmed conflict. Structural test (offline, deterministic):
//   • boot-drained / draining                       → PASS (admits no new work)
//   • AUTHORITATIVE roster (cluster-repo / static),
//     node NOT in it                                → PASS (HRW assigns it nothing)
//   • in the roster, not drained                    → FAIL (HRW would assign work)
//   • single-host / fail-open / unresolved roster,
//     not drained                                   → FAIL (can't confirm out-of-roster;
//                                                      a fail-open collapse = owns 100%)
// "Authoritative" = a real configured roster source (cluster-repo or an explicit
// static roster) — NOT the single-host collapse the resolver returns when nothing
// resolves. If the resolver exposes no source flag (defensive), only multiHost===true
// is treated as authoritative; a single-host/unflagged roster is the dangerous case.
// The would-own COUNT is printed separately by checkHrwPartition (kept in every
// suite for visibility). Injectable for tests.
export function checkWontOwnWork(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    getHostName: _getHostName = getHostName,
    isDraining: _isDraining = isDraining,
    orchDir = getExecutionCoreDir(),
    bootDrained = process.env.CATALYST_BOOT_DRAINED === "1",
  } = deps;

  const resolved = resolveRoster() ?? {};
  const hosts = Array.isArray(resolved.hosts) ? resolved.hosts : [];
  const source = resolved.source;
  const multiHost = resolved.multiHost === true;
  const self = _getHostName();
  const inRoster = hosts.includes(self);
  const drained = _isDraining(orchDir) || bootDrained;

  // 1. Explicitly drained → PASS (admits no new work regardless of roster).
  if (drained) {
    return [
      mkCheck("would-not-own-work", STATUS.PASS, "drained — will not own work (boot-drained / draining; admits no new work)"),
    ];
  }

  // A roster is AUTHORITATIVELY resolved only when it came from a real configured
  // source (the cluster repo or an explicit static roster). The fail-open
  // single-host collapse (source==="single-host", or — defensively, if the resolver
  // exposes no source flag — anything that is not multiHost) is NOT authoritative.
  const authoritative =
    source === "cluster-repo" ||
    source === "static" ||
    (source === undefined && multiHost);

  // 2. Authoritative roster that does NOT contain this node → PASS (HRW assigns it
  //    nothing; we can POSITIVELY confirm it sits out).
  if (authoritative && !inRoster) {
    return [
      mkCheck(
        "would-not-own-work",
        STATUS.PASS,
        `"${self}" is not in the authoritative cluster roster [${hosts.join(", ")}] ` +
          `(source=${source ?? "?"}) — HRW assigns it nothing`,
      ),
    ];
  }

  // 3. Everything else (in the roster, OR a single-host/fail-open/unresolved roster
  //    we cannot confirm excludes this node) → FAIL, fail-closed.
  const why = inRoster
    ? `it is in the cluster roster [${hosts.join(", ")}] (source=${source ?? "?"}) and is NOT drained, ` +
      `so HRW would assign it work`
    : `the cluster roster could not be authoritatively confirmed (source=${source ?? "?"}, ` +
      `multiHost=${multiHost}), so a fail-open single-host collapse means this node would own ` +
      `100% of tickets if the daemons start`;
  return [
    mkCheck(
      "would-not-own-work",
      STATUS.FAIL,
      `"${self}" would own work — a developer/monitor must be drained or out of an authoritative ` +
        `roster; set CATALYST_BOOT_DRAINED=1 (or drain) — ${why}`,
    ),
  ];
}

// ─── Developer: daemonless + plugins-fresh, folded from verify-node ───────────

// resolveStackBin — the catalyst-stack script. Prefer the sibling in this repo
// (deterministic, same version as doctor.mjs); fall back to PATH.
function resolveStackBin() {
  const sibling = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalyst-stack");
  return existsSync(sibling) ? sibling : "catalyst-stack";
}

// defaultRunVerifyNode — shell out to `catalyst-stack verify-node --json` (a
// read-only, class-aware LOCAL smoke test) and parse its JSON. verify-node EXITS
// non-zero when a required check FAILs — that is expected, not a spawn error, so
// we parse stdout regardless of status; only a missing binary / empty output
// throws. The child grades the SAME class (env-pinned) so its rows match ours.
function defaultRunVerifyNode(nodeClass) {
  const bin = resolveStackBin();
  const r = spawnSync(bin, ["verify-node", "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CATALYST_NODE_CLASS: nodeClass },
  });
  if (r.error) throw r.error;
  if (!r.stdout || !r.stdout.trim()) {
    throw new Error(`verify-node produced no output (status ${r.status}): ${r.stderr?.trim() ?? ""}`);
  }
  const parsed = JSON.parse(r.stdout);
  // F2 (CTL-1355): the child's ACTUAL exit status is the authoritative liveness
  // signal — capture it (don't discard r.status) so checkDaemonlessLocal can
  // fail-close on a non-zero exit even when the JSON body omits exit_code.
  if (typeof parsed.exit_code !== "number" && typeof r.status === "number") {
    parsed.exit_code = r.status;
  }
  return parsed;
}

// verify-node statuses are UPPERCASE (PASS|FAIL|WARN|SKIP, no INFO); translate to
// doctor's lowercase STATUS (SKIP has no doctor analogue → INFO).
const VN_STATUS_MAP = {
  PASS: STATUS.PASS,
  FAIL: STATUS.FAIL,
  WARN: STATUS.WARN,
  SKIP: STATUS.INFO,
};

// checkDaemonlessLocal — fold the daemonless + plugins-fresh rows from verify-node
// into doctor checks rather than re-implementing the broker/exec-core process
// probes and the entire verify-updater stack.
//
// FAIL-CLOSED (CTL-1355 F2): verify-node is the ONLY net that catches a developer
// actually executing work (running daemons / stale plugins). A spawn error, an
// empty/unparseable result, jq unavailability, a non-zero child exit, a `fail`
// verdict, a missing required row, or an unmappable row status all mean we CANNOT
// certify the node is daemonless + fresh — so each is a FAIL (was WARN, which
// masked exactly the dangerous states). Injectable for tests (inject a JSON
// fixture instead of spawning).
export function checkDaemonlessLocal(deps = {}) {
  const {
    nodeClass = "developer",
    runVerifyNode = defaultRunVerifyNode,
    rows = ["broker-stopped", "exec-core-stopped", "plugins-fresh"],
  } = deps;

  let result;
  try {
    result = runVerifyNode(nodeClass);
  } catch (err) {
    return [
      mkCheck(
        "verify-node",
        STATUS.FAIL,
        `could not verify daemonless local state — could not run ` +
          `'catalyst-stack verify-node --json': ${err?.message ?? err}; ` +
          `cannot certify the developer is daemonless + fresh`,
      ),
    ];
  }

  // A parsed-but-UNUSABLE verify-node result (empty/unparseable output, jq unavailable)
  // cannot certify daemonless+fresh at all — that's the generic short-circuit below. A
  // non-zero exit / "fail" verdict ALONE is NOT unusable: it's the expected shape whenever
  // ANY required row failed (including one outside `rows`), and the per-row loop below
  // already fails closed on a missing/unmappable named row. Short-circuiting on exit/verdict
  // only hid WHICH row failed — e.g. a dead event-mirror reported as a generic "verify-node
  // unavailable" FAIL instead of naming "event-mirror-running" (CTL-1662 Codex P2).
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  if (checks.length === 0 || result?.jq === false) {
    return [
      mkCheck(
        "verify-node",
        STATUS.FAIL,
        `could not verify daemonless local state — verify-node unavailable/failed ` +
          `(exit ${result?.exit_code ?? "?"}, verdict ${result?.verdict ?? "?"}, jq ${result?.jq ?? "?"}, ` +
          `checks ${checks.length}); cannot certify the developer is daemonless + fresh`,
      ),
    ];
  }

  const out = [];
  for (const name of rows) {
    const row = checks.find((c) => c?.name === name);
    if (!row) {
      out.push(
        mkCheck(
          name,
          STATUS.FAIL,
          `verify-node did not report "${name}" (class=${result?.node_class ?? "?"}) — ` +
            `cannot certify daemonless + fresh`,
        ),
      );
      continue;
    }
    out.push(mkCheck(name, VN_STATUS_MAP[row.status] ?? STATUS.FAIL, row.detail ?? ""));
  }
  return out;
}

// ─── CTL-1369 PR4: install-correctness checks (agent-set + pull-owner per class) ──
//
// These two checks make `catalyst install` self-verifying: they assert the node ended up with the
// CORRECT launchd agent SET and plugin-pull owner for its class — the heart of the per-class
// invariant (catalyst-stack work-stack ⟺ worker; catalyst-updater + pluginPullOwner=updater ⟺
// developer/monitor). A genuine class MISMATCH (the two-puller / mixed-profile hazard) is always a
// FAIL. The `strict` flag governs only the NOT-YET-PROVISIONED case: in the always-on activation
// rubric (strict:false) a missing agent / unset owner is a WARN (a fresh node legitimately has
// neither, and catalyst-join's do_doctor_gate runs BEFORE install-services — a FAIL would fail-close
// the join gate, the same trap checkReaper/checkConfigScopeLeak avoid). In the install-verification
// profile (strict:true, run by `catalyst install` as its post-install pass) a missing agent / unset
// owner is a FAIL — post-install the agents + owner MUST be correct or the install did not take.

const STACK_AGENT_LABEL = "ai.coalesce.catalyst-stack"; // the worker work-stack supervisor (broker/exec-core/monitor)
const UPDATER_AGENT_LABEL = "ai.coalesce.catalyst-updater"; // the 5th updater agent (sole puller) on developer/monitor
const CLOUD_SYNC_AGENT_LABEL = "ai.coalesce.catalyst-cloud-sync"; // CTL-1394 (keep in sync w/ catalyst-stack + check-setup.sh)

function defaultLaunchAgentsDir() {
  return process.env.CATALYST_LAUNCHAGENTS_DIR || resolve(homedir(), "Library", "LaunchAgents");
}

// defaultAgentInstalled — is the launchd plist for <label> present? Deterministic file probe
// (mirrors install-lifecycle.mjs defaultProbeWorkerAgents/defaultProbeUpdaterAgent). Honors
// CATALYST_LAUNCHAGENTS_DIR for sandbox tests.
// defaultAgentInstalledAt — the launchd plist's mtime in ms, or null. (CTL-1913)
// This is the only local record of WHEN a writer was adopted, and it is what lets
// checkCloudSync separate a fresh adoption still seeding from one that has never
// authenticated. Returns null rather than a sentinel number on any failure: the
// caller must be able to say "could not measure" instead of computing an age from
// a fabricated timestamp — a `0` here would read as "adopted in 1970", i.e. an
// instant FAIL on an unreadable plist.
function defaultAgentInstalledAt(label, dir = defaultLaunchAgentsDir()) {
  try {
    const m = statSync(resolve(dir, `${label}.plist`)).mtimeMs;
    return Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

function defaultAgentInstalled(label, dir = defaultLaunchAgentsDir()) {
  try {
    return existsSync(resolve(dir, `${label}.plist`));
  } catch {
    return false;
  }
}

// defaultUpdaterProcessAlive — is a catalyst-updater daemon RUNNING, even with its plist removed?
// Mirrors install-lifecycle.mjs defaultProbeUpdaterAgent (CTL-1369 PR4 Codex P2): a manual/partial
// cleanup can leave the updater process alive without its plist — still the CTL-1348 two-puller hazard
// — so the strict post-install verification must catch it, not just the plist. Honors the
// CATALYST_ASSUME_NO_DAEMONS test seam (same as install-lifecycle).
function defaultUpdaterProcessAlive() {
  if (process.env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  const r = spawnSync("pgrep", ["-f", "execution-core/updater/updater\\.mjs"], { timeout: 5_000 });
  return !r.error && r.status === 0;
}

// defaultCloudSyncProcessAlive — is the supervised cloud-sync daemon RUNNING? (CTL-1394)
// pgrep the writer entrypoint; honors the CATALYST_ASSUME_NO_DAEMONS test seam.
function defaultCloudSyncProcessAlive() {
  if (process.env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  // Match the basename, not the full dir path: the launcher execs the writer via
  // `${SCRIPT_DIR}/../cloud-sync.mjs`, so the live argv is
  // `.../cloud-sync/../cloud-sync.mjs` — a `execution-core/cloud-sync.mjs`
  // pattern would miss it (Codex P2). `cloud-sync.mjs` matches the writer process and
  // not the launcher (`.../cloud-sync/launch.sh` has no `.mjs`).
  const r = spawnSync("pgrep", ["-f", "cloud-sync\\.mjs"], { timeout: 5_000 });
  return !r.error && r.status === 0;
}

// defaultLaunchdLabelPath — which plist is the RUNNING launchd label actually bound to? (CTL-1963)
//
// ⛔ THE DEFECT THIS EXISTS FOR: `gui/$UID` is a PER-USER domain, not a per-HOME one. A sealed-prefix
// install run under a scratch HOME still bootstraps into the REAL user domain, so the label
// `ai.coalesce.catalyst-cloud-sync` gets rebound to a plist under /var/folders/…/T/tmp.XXXX/. The
// squatting run then exits and its temp dir is reaped — leaving the label pointing at a path that NO
// LONGER EXISTS. Measured twice on the laptop 2026-08-18: 04:01 (tmp.p3Tb3ig3kS) and 07:19
// (tmp.dOCLr1E2bn), ~3h18m apart.
//
// ⛔ WHY plist-on-disk IS NOT THE SAME QUESTION. `defaultAgentInstalled` answers "is
// ~/Library/LaunchAgents/<label>.plist present?" — and in BOTH incidents it was, unchanged. The
// correct file existed the whole time; launchd was simply bound to a different one. So the existing
// check reads PASS while the writer is dead. Only the resolved binding distinguishes them.
//
// ⛔ AND WHY THE EXIT-CODE FIX DOES NOT COVER IT. The 04:01 instance was diagnosed as launchd's
// `KeepAlive={SuccessfulExit:false}` contract keeping a cleanly-exited writer down. The 07:19 instance
// is NOT an exit-code problem: the bound path is gone, so no kickstart, bootstrap, or reboot can
// revive it. The invariant that catches both shapes is "the label resolves to ~/Library/LaunchAgents".
//
// Returns the resolved path string, or null when it cannot be measured (launchctl absent, label not
// bootstrapped, unparseable output). ⛔ null means UNKNOWN, never "fine" — the caller must not grade a
// failure to measure as a pass. Honors CATALYST_ASSUME_NO_DAEMONS so tests touch no launchctl.
function defaultLaunchdLabelPath(label) {
  if (process.env.CATALYST_ASSUME_NO_DAEMONS === "1") return null;
  try {
    const r = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
      timeout: 5_000,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    // `launchctl print` emits a tab-indented `path = /abs/path.plist` line. Anchor on the field name
    // so the many other `... path = ...` keys in that output (stdout path, stderr path) cannot match.
    const m = r.stdout.match(/^\s*path\s*=\s*(\S.*?)\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// checkAgentsForClass — assert the correct launchd agent SET for the class. The two discriminators
// are the worker stack agent and the developer/monitor updater agent; their PRESENCE is mutually
// exclusive (a node running both is the CTL-1348 two-puller hazard). Injectable for tests.
export function checkAgentsForClass(deps = {}) {
  const {
    nodeClass,
    strict = false,
    hasStackAgent = defaultAgentInstalled(STACK_AGENT_LABEL),
    // the DURABLE updater LaunchAgent plist (survives reboot/logout) — REQUIRED for a developer/monitor PASS.
    hasUpdaterAgent = defaultAgentInstalled(UPDATER_AGENT_LABEL),
    // a live updater PROCESS (may exist WITHOUT a plist after a partial cleanup). Used ONLY to catch the
    // worker two-puller hazard (CTL-1369 PR4 Codex P2); a process with no plist is NOT a durable install.
    updaterProcessAlive = defaultUpdaterProcessAlive,
  } = deps;
  const updaterProc = typeof updaterProcessAlive === "function" ? updaterProcessAlive() : !!updaterProcessAlive;

  if (nodeClass === "worker") {
    // A worker's broker owns the pull; an updater present in ANY form — durable plist OR a live process
    // (a manual cleanup can leave the process without its plist) — is the two-puller race.
    if (hasUpdaterAgent || updaterProc) {
      return [
        mkCheck(
          "agents-for-class",
          STATUS.FAIL,
          `worker node has a developer/monitor updater ${hasUpdaterAgent ? `agent (${UPDATER_AGENT_LABEL})` : "process running (no plist)"} present — ` +
            `the two-puller hazard (the broker AND the updater would both pull the plugin checkout). ` +
            `Run 'catalyst reinstall --class worker' (its teardown removes the updater) or 'catalyst-stack uninstall-services'`,
        ),
      ];
    }
    if (hasStackAgent) {
      return [mkCheck("agents-for-class", STATUS.PASS, `worker work-stack agent (${STACK_AGENT_LABEL}) installed; no updater agent/process (correct for class=worker)`)];
    }
    return [
      mkCheck(
        "agents-for-class",
        strict ? STATUS.FAIL : STATUS.WARN,
        `no worker work-stack agent (${STACK_AGENT_LABEL}) installed — this node is not yet provisioned as a worker; run 'catalyst install --class worker'`,
      ),
    ];
  }

  // developer / monitor: the updater agent is the sole puller; the worker stack must NOT be present.
  if (hasStackAgent) {
    return [
      mkCheck(
        "agents-for-class",
        STATUS.FAIL,
        `${nodeClass} node has the worker work-stack agent (${STACK_AGENT_LABEL}) installed — a developer/monitor must NOT run ` +
          `the broker/execution-core (it would pick up work). Run 'catalyst reinstall --class ${nodeClass}' (its teardown removes the worker stack)`,
      ),
    ];
  }
  // A developer/monitor PASS REQUIRES the DURABLE plist — a live process with NO plist won't restart
  // after reboot/logout, so it is not a provisioned node (CTL-1369 PR4 Codex P2).
  if (hasUpdaterAgent) {
    return [mkCheck("agents-for-class", STATUS.PASS, `updater agent (${UPDATER_AGENT_LABEL}) installed; no worker work-stack agent (correct for class=${nodeClass})`)];
  }
  if (updaterProc) {
    return [
      mkCheck(
        "agents-for-class",
        strict ? STATUS.FAIL : STATUS.WARN,
        `${nodeClass} node has a live updater process but NO ${UPDATER_AGENT_LABEL} plist — it will NOT restart after ` +
          `reboot/logout (not durably installed). Run 'catalyst install --class ${nodeClass}' (or 'catalyst-stack adopt-updater')`,
      ),
    ];
  }
  return [
    mkCheck(
      "agents-for-class",
      strict ? STATUS.FAIL : STATUS.WARN,
      `no updater agent (${UPDATER_AGENT_LABEL}) installed — this ${nodeClass} node has no plugin-freshness puller; run 'catalyst install --class ${nodeClass}' (or 'catalyst-stack adopt-updater')`,
    ),
  ];
}

// defaultPluginPullOwner — the PERSISTED plugin-pull owner this node was INSTALLED with: the Layer-2
// catalyst.orchestration.pluginPullOwner value (any non-"updater" / unset ⇒ "broker"). Two deliberate
// properties (both from Codex P2):
//   (1) It reads from doctor's UNIFORM Layer-2 path — layer2Path() (CATALYST_LAYER2_CONFIG_FILE →
//       ~/.config) — which is exactly the path resolveNodeClass uses for the CLASS. Reading class AND
//       owner from one config file is what keeps them from skewing (round 2): an earlier revision honored
//       CATALYST_MACHINE_CONFIG here but NOT in the class resolver, so a config selected only via
//       CATALYST_MACHINE_CONFIG graded the class as an inferred worker while the owner read developer.
//       install-lifecycle pins CATALYST_LAYER2_CONFIG_FILE (= its own layer2Path) in the doctor step env,
//       so this reads the node's actual installed config.
//   (2) It IGNORES the transient CATALYST_PLUGIN_PULL_OWNER env that broker/plugin-refresh.mjs honors at
//       runtime (round 1): the launchd updater agent never inherits a caller's shell env, so a stray
//       `CATALYST_PLUGIN_PULL_OWNER=broker` must not make a correctly-adopted developer's post-install
//       doctor falsely FAIL. The doctor verifies INSTALLED STATE, not a runtime override.
// Inlined (doctor runs under bare node).
function defaultPluginPullOwner() {
  const coerce = (v) => (typeof v === "string" && v.trim() === "updater" ? "updater" : "broker");
  try {
    const v = JSON.parse(readFileSync(layer2Path(), "utf8"))?.catalyst?.orchestration?.pluginPullOwner;
    if (typeof v === "string" && v.trim().length > 0) return coerce(v);
  } catch {
    /* unreadable/malformed/absent Layer-2 → fail safe to broker */
  }
  return "broker";
}

// checkPluginPullOwner — assert pluginPullOwner is sane for the class. worker → broker (its broker
// pulls); developer/monitor → updater (the standalone updater agent pulls; the node runs no broker).
// A class MISMATCH is always a FAIL. For a developer/monitor an UNSET owner (resolves to broker) is a
// WARN in the activation rubric (not yet adopted) and a FAIL under strict (post-install it must be
// updater). Injectable for tests.
export function checkPluginPullOwner(deps = {}) {
  const { nodeClass, strict = false, owner = defaultPluginPullOwner() } = deps;

  if (nodeClass === "worker") {
    if (owner === "updater") {
      return [
        mkCheck(
          "plugin-pull-owner",
          STATUS.FAIL,
          `pluginPullOwner=updater on a worker — the broker DEFERS the pull to a catalyst-updater agent a worker does not run, ` +
            `so the plugin checkout goes stale. Reset it to broker (a 'catalyst install --class worker' does this; or set ` +
            `catalyst.orchestration.pluginPullOwner=broker / unset it)`,
        ),
      ];
    }
    return [mkCheck("plugin-pull-owner", STATUS.PASS, `pluginPullOwner resolves to broker — the worker's broker owns plugin freshness (correct for class=worker)`)];
  }

  // developer / monitor
  if (owner === "updater") {
    return [mkCheck("plugin-pull-owner", STATUS.PASS, `pluginPullOwner=updater — the standalone catalyst-updater agent owns the pull (correct for class=${nodeClass}, which runs no broker)`)];
  }
  return [
    mkCheck(
      "plugin-pull-owner",
      strict ? STATUS.FAIL : STATUS.WARN,
      `pluginPullOwner resolves to broker on a ${nodeClass} node — a developer/monitor runs no broker, so NOTHING pulls the plugin ` +
        `checkout (it goes stale). Run 'catalyst-stack adopt-updater' (sets pluginPullOwner=updater)`,
    ),
  ];
}

// defaultPluginSourceHealth — CTL-1421: shell out to lib/plugin-dirs.sh's
// plugin_source_health (CTL-992), the single source of truth for pristine-checkout
// health. Returns the array of typed problem lines
// (MISSING/NOT_A_CHECKOUT/LINKED_WORKTREE/OFF_MAIN/DIRTY); [] = healthy. Reused
// rather than re-implemented so the "pristine" definition can't drift from the
// pull path. Seam-injected for tests.
function defaultPluginSourceHealth(root) {
  const libPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "plugin-dirs.sh");
  const r = spawnSync("bash", ["-c", 'source "$1"; plugin_source_health "$2"', "bash", libPath, root], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return String(r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// classifyPluginSourceFreshness — CTL-1421: PURE decision core. The bg + SDK
// phase-agent workers load their skills/scripts from the resolved pluginDirs roots
// via `--plugin-dir` / SDK `plugins:`. A node with NO healthy pristine root
// SILENTLY falls back to the Claude Code marketplace cache
// (~/.claude/plugins/cache/catalyst, refreshed only on the daily release-please
// cycle → up to ~24h stale), so CI/CD would run stale code with no signal
// (phase-agent-dispatch:~922 "Empty = marketplace behavior unchanged";
// sdk-run-phase-agent.mjs:~792 omits the plugins option). This asserts the
// worker plugin path is fresh. Distinct from checkDaemonlessLocal's "plugins
// fresh" (HEAD-vs-origin currency of a resolved checkout) — this is about whether
// a healthy pristine checkout is RESOLVED at all. A worker node FAILs (it is the
// CI/CD executor); developer/monitor WARN (not the primary executors).
export function classifyPluginSourceFreshness({ roots = [], healthByRoot = {}, nodeClass = "worker" } = {}) {
  const sev = nodeClass === "worker" ? STATUS.FAIL : STATUS.WARN;
  if (roots.length === 0) {
    return mkCheck(
      "plugin-source-freshness",
      sev,
      "pluginDirs is unset / resolves to no checkout — bg + SDK phase-agent workers SILENTLY fall back to the " +
        "marketplace cache (~/.claude/plugins/cache/catalyst, ~≤24h stale on the release cycle) instead of the " +
        "fresh pristine plugin-source, so CI/CD runs stale skills/scripts with no signal. Set " +
        "catalyst.orchestration.pluginDirs to the pristine checkout (run 'catalyst install' / setup-plugin-source.sh)",
    );
  }
  const problems = roots.flatMap((r) => (healthByRoot[r] || []).map((line) => line));
  if (problems.length > 0) {
    return mkCheck(
      "plugin-source-freshness",
      sev,
      `plugin-source is not a healthy pristine checkout (${problems.join("; ")}) — workers would load ` +
        "non-pristine / off-main / dirty code instead of released main. Restore a clean, main-only, standalone checkout",
    );
  }
  if (roots.length > 1) {
    return mkCheck(
      "plugin-source-freshness",
      STATUS.WARN,
      `${roots.length} plugin-source roots resolved (${roots.join(", ")}) — expected a single pristine ` +
        "plugin-source; multiple roots are ambiguous for skill resolution",
    );
  }
  return mkCheck(
    "plugin-source-freshness",
    STATUS.PASS,
    `worker plugin path resolves to a single healthy pristine plugin-source (${roots[0]}) — no marketplace-cache fallback`,
  );
}

// checkPluginSourceFreshness — CTL-1421: resolve the same pluginDirs the workers
// use (resolvePluginCheckoutRoots, the JS mirror of lib/plugin-dirs.sh), health-
// probe each resolved root, and classify. Seams injectable for tests.
export function checkPluginSourceFreshness(deps = {}) {
  const {
    nodeClass = "worker",
    resolveRootsFn = () => resolvePluginCheckoutRoots({}),
    healthFn = defaultPluginSourceHealth,
  } = deps;
  const roots = resolveRootsFn();
  const healthByRoot = {};
  for (const r of roots) healthByRoot[r] = healthFn(r);
  return [classifyPluginSourceFreshness({ roots, healthByRoot, nodeClass })];
}

// checkStaleLock — CTL-1415: a stale `.git/index.lock` in the node's plugin-source
// checkout silently freezes every plugin pull (a crashed git op leaves the lock;
// each later `git reset --hard` then fails forever — the ~8.5h laptop freeze in
// CTL-1401). doctor REPORTS the frozen state so the node isn't silently stuck on
// stale plugins; the updater/broker pull path (broker/plugin-refresh.mjs) is what
// auto-clears it. Age-gated via the SHARED lib/stale-lock.mjs classifier, so the
// "safe age" can't drift from what the pull path clears, and a live git op (a
// fresh lock) is reported as in-progress, never flagged.
//
// Codex P2 (#2530): a checkout provisioned via `setup-plugin-source.sh --path`
// only persists the custom root through catalyst.orchestration.pluginDirs — it
// does NOT guarantee CATALYST_PLUGIN_SOURCE is set in doctor's environment. The
// old hardcoded ~/catalyst/plugin-source default could report "no stale lock"
// while the ACTUAL configured checkout sat frozen. Resolve the same
// resolvePluginCheckoutRoots() the adjacent freshness check and the real pull
// path use (CTL-1421), so this check inspects the checkout(s) that are actually
// live rather than an unconditional guess. An explicit `root` still wins (tests /
// single-checkout callers); the historical env/default guess is the last-resort
// fallback only when nothing resolves at all (no pluginDirs configured).
export function checkStaleLock(deps = {}) {
  const {
    root,
    resolveRootsFn = () => resolvePluginCheckoutRoots({}),
    now = Date.now(),
    thresholdMs = STALE_LOCK_THRESHOLD_MS,
    statFn,
  } = deps;
  const resolved = root ? [root] : resolveRootsFn();
  const roots =
    resolved.length > 0
      ? resolved
      : [process.env.CATALYST_PLUGIN_SOURCE || resolve(homedir(), "catalyst", "plugin-source")];

  const statuses = roots.map((r) => ({ r, s: staleLockStatus({ root: r, now, thresholdMs, statFn }) }));
  const stale = statuses.filter(({ s }) => s.present && s.stale);
  if (stale.length > 0) {
    const thMins = Math.round(thresholdMs / 60000);
    const details = stale
      .map(({ r, s }) => `${indexLockPath(r)} (~${Math.round(s.ageMs / 60000)}m old)`)
      .join("; ");
    return [mkCheck("stale-plugin-lock", STATUS.WARN,
      `stale .git/index.lock (age ≥ ${thMins}m threshold) — plugin pulls are FROZEN until it clears; the updater/broker auto-clears it on its next pull (CTL-1415), or remove by hand: ${details}`)];
  }
  const inProgress = statuses.find(({ s }) => s.present && !s.stale);
  if (inProgress) {
    const secs = Math.round(inProgress.s.ageMs / 1000);
    const thSecs = Math.round(thresholdMs / 1000);
    return [mkCheck("stale-plugin-lock", STATUS.PASS, `a git operation is in progress in plugin-source (index.lock ${secs}s old < ${thSecs}s threshold) — not stale`)];
  }
  return [mkCheck("stale-plugin-lock", STATUS.PASS, `no stale git index.lock in plugin-source (${roots.join(", ")})`)];
}

// ─── Skills-dir plugin migration ─────────────────────────────────────────────
// The daemon / SDK / Codex executors load catalyst plugins from the resolved
// pluginDirs checkout (still — the Agent SDK does not auto-load ~/.claude/skills
// plugins, so pluginDirs stays and checkPluginSourceFreshness above guards it).
// Every OTHER session type Claude Code itself resolves plugins for (interactive
// `claude`, `claude --bg`, bg-spare, desktop) must load catalyst IN-PLACE from
// that same checkout via user-scope skills-dir symlinks — never the version-keyed
// `catalyst` marketplace cache (the one path that goes stale, the "stale copy
// reports healthy" class this migration closes). This check asserts that end
// state: every plugin in the checkout has a matching ~/.claude/skills/<name>
// symlink resolving into it, AND no legacy path (marketplace registration,
// enabledPlugins residue, an installed marketplace copy that precedence-BLOCKS the
// skills-dir plugin, or the retired interactive --plugin-dir wrapper) survives.
// worker = FAIL (the fleet node), developer/monitor = WARN.

const SKILLS_DIR_WRAPPER_MARKER = "# >>> catalyst plugin-source (managed) >>>";

// claudeConfigDir — Claude Code's data directory, honoring CLAUDE_CONFIG_DIR.
//
// CTL (Codex #2664 P1): the skills-dir call sites hardcoded homedir()/.claude. Claude
// Code lets an operator relocate that directory, and CLAUDE_CONFIG_DIR may hold a
// COLON-SEPARATED list whose FIRST entry is the writable primary — so on a relocated
// install the cutover wrote symlinks to, and doctor verified them in, a directory
// Claude Code never reads. Mirrors setup-plugin-source.sh's claude_config_dir() so the
// bash writer and this JS verifier can never disagree about where the links live.
export function claudeConfigDir() {
  const v = process.env.CLAUDE_CONFIG_DIR;
  if (typeof v === "string" && v !== "") return v.split(":")[0];
  return resolve(homedir(), ".claude");
}

// defaultExpectedSkillsPlugins — every <root>/plugins/*/.claude-plugin/plugin.json,
// keyed by manifest `name` (the symlink basename) with `dir` realpath'd for a
// direct string compare against the (also realpath'd) symlink target.
function defaultExpectedSkillsPlugins(roots) {
  const out = [];
  for (const root of roots) {
    const pluginsDir = resolve(root, "plugins");
    let entries;
    try {
      entries = readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = resolve(pluginsDir, e.name);
      try {
        const name = JSON.parse(readFileSync(resolve(dir, ".claude-plugin", "plugin.json"), "utf8"))?.name;
        if (name) out.push({ name, dir: realpathSync(dir) });
      } catch {
        /* no manifest → not a loadable plugin */
      }
    }
  }
  return out;
}

// defaultSkillLink — classify ~/.claude/skills/<name>: symlink (target realpath'd,
// null if dangling) | other (a real file/dir, never clobbered) | missing.
function defaultSkillLink(name) {
  const link = resolve(claudeConfigDir(), "skills", name);
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isSymbolicLink()) return { kind: "other" };
  try {
    return { kind: "symlink", target: realpathSync(link) };
  } catch {
    return { kind: "symlink", target: null }; // dangling
  }
}

// defaultReadInstalledPlugins — ~/.claude/plugins/installed_plugins.json (records a
// marketplace copy install even when it is not in enabledPlugins).
function defaultReadInstalledPlugins() {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return null;
  }
}

// defaultWrapperRcFiles — interactive rc files still carrying the retired managed
// `claude()` --plugin-dir wrapper block (double-loads with skills-dir).
function defaultWrapperRcFiles() {
  const found = [];
  for (const rc of [".zshrc", ".bashrc", ".bash_profile"].map((f) => resolve(homedir(), f))) {
    try {
      if (readFileSync(rc, "utf8").includes(SKILLS_DIR_WRAPPER_MARKER)) found.push(rc);
    } catch {
      /* absent */
    }
  }
  return found;
}

// classifySkillsDirPlugins — PURE decision core (all IO injected). Aggregates every
// residue into a single check, mirroring classifyPluginSourceFreshness's shape.
export function classifySkillsDirPlugins({
  roots = [],
  expectedPlugins = [],
  linkByName = {},
  settings = null,
  installedPlugins = null,
  wrapperRcFiles = [],
  nodeClass = "worker",
} = {}) {
  const sev = nodeClass === "worker" ? STATUS.FAIL : STATUS.WARN;

  if (roots.length === 0) {
    return mkCheck(
      "skills-dir-plugins",
      sev,
      "no plugin-source checkout resolved (pluginDirs unset) — cannot verify the ~/.claude/skills symlinks; " +
        "run setup-plugin-source.sh",
    );
  }

  const problems = [];

  // (a) every plugin in the checkout has a matching skills-dir symlink into it
  for (const { name, dir } of expectedPlugins) {
    const link = linkByName[name];
    if (!link || link.kind === "missing") {
      problems.push(`~/.claude/skills/${name} is missing`);
    } else if (link.kind === "other") {
      problems.push(`~/.claude/skills/${name} exists but is not a symlink`);
    } else if (!link.target) {
      problems.push(`~/.claude/skills/${name} is a dangling symlink`);
    } else if (link.target !== dir) {
      problems.push(`${claudeConfigDir()}/skills/${name} resolves to ${link.target}, not the plugin-source checkout (${dir})`);
    }
  }

  // (b) legacy marketplace load-path residue — any of these reintroduces the stale
  //     version-keyed cache and/or precedence-blocks the in-place skills-dir copy.
  //     Covers EVERY plugin in the checkout's catalog (via expectedPlugins), not a
  //     hardcoded catalyst-dev/-pm allowlist — Codex P1: the marketplace catalog has
  //     ten plugins (catalyst-meta, catalyst-analytics, catalyst-debugging, …); a
  //     two-name check would report clean while an untouched marketplace copy of one
  //     of the other eight kept running stale code.
  const marketplaceIds =
    expectedPlugins.length > 0
      ? expectedPlugins.map(({ name }) => `${name}@catalyst`)
      : ["catalyst-dev@catalyst", "catalyst-pm@catalyst"];
  const ep = settings?.enabledPlugins || {};
  for (const k of marketplaceIds) {
    if (k in ep) problems.push(`enabledPlugins still lists ${k} — clear it`);
  }
  if (settings?.extraKnownMarketplaces?.catalyst) {
    problems.push("the 'catalyst' marketplace is still registered (extraKnownMarketplaces) — remove it");
  }
  const installed = installedPlugins?.plugins || {};
  for (const k of marketplaceIds) {
    if (installed[k]) {
      problems.push(`${k} is still installed from the marketplace — it precedence-BLOCKS the skills-dir copy; uninstall it`);
    }
  }

  // (c) the retired interactive --plugin-dir wrapper (double-loads with skills-dir)
  for (const rc of wrapperRcFiles) {
    problems.push(`the legacy interactive --plugin-dir wrapper is still in ${rc} — remove the managed block`);
  }

  if (problems.length > 0) {
    return mkCheck(
      "skills-dir-plugins",
      sev,
      `catalyst plugins do not load cleanly in-place via user-scope skills-dir (${problems.join("; ")}). ` +
        "Run the full 'bash setup-plugin-source.sh' cutover to fix (marketplace copies enabled at project scope in " +
        "another repo need 'claude plugin uninstall <p>@catalyst --scope project -y' from that repo).",
    );
  }
  return mkCheck(
    "skills-dir-plugins",
    STATUS.PASS,
    `all ${expectedPlugins.length} catalyst plugins load in-place via ~/.claude/skills symlinks into ${roots[0]}; ` +
      "no marketplace / wrapper residue",
  );
}

// checkSkillsDirPlugins — gather the IO, then classify. Seams injectable for tests.
export function checkSkillsDirPlugins(deps = {}) {
  const {
    nodeClass = "worker",
    resolveRootsFn = () => resolvePluginCheckoutRoots({}),
    expectedPluginsFn = defaultExpectedSkillsPlugins,
    skillLinkFn = defaultSkillLink,
    readSettingsFn = defaultReadClaudeSettings,
    readInstalledPluginsFn = defaultReadInstalledPlugins,
    wrapperRcFilesFn = defaultWrapperRcFiles,
  } = deps;
  const roots = resolveRootsFn();
  const expectedPlugins = expectedPluginsFn(roots);
  const linkByName = {};
  for (const { name } of expectedPlugins) linkByName[name] = skillLinkFn(name);
  return [
    classifySkillsDirPlugins({
      roots,
      expectedPlugins,
      linkByName,
      settings: readSettingsFn(),
      installedPlugins: readInstalledPluginsFn(),
      wrapperRcFiles: wrapperRcFilesFn(),
      nodeClass,
    }),
  ];
}

// ─── Suite selection ─────────────────────────────────────────────────────────

// checksForClass — build the check-thunk suite for a resolved node class. This is
// the single class switch; runDoctor calls it unless an explicit `checks` array is
// injected. `opts` carries seed/otel/expectedBotUserId plus the injectable seams
// the developer/monitor checks honor (runVerifyNode, baseUrl, fetch, roster/drain).
// Undefined seams fall through to each check's real default (JS default params
// apply for `undefined`), so production passes nothing and tests inject fixtures.
export function checksForClass(nc, opts = {}) {
  const {
    seed = null,
    otel = null,
    expectedBotUserId = null,
    runVerifyNode,
    readReplicaBaseUrl,
    fetch: _fetch,
    linearToken: _linearToken, // CTL-1355 P3: injectable for the developer Linear-token gate
    resolveRoster,
    isDraining: _isDraining,
    orchDir,
    bootDrained,
    getHostName: _getHostName,
    // CTL-1369 PR4: install-correctness seams (agent-set + pull-owner). `strict` is false in the
    // always-on activation rubric (missing agent / unset owner = WARN, safe for the pre-install join
    // gate) and true in installChecksForClass (the post-install verification pass).
    strict = false,
    hasStackAgent,
    hasUpdaterAgent,
    pluginPullOwner,
    // CTL-1473: pre-install flag downgrades install-remediable checks (shipper, agents-for-class)
    // from FAIL to WARN when the join gate runs BEFORE install-services (which creates the services).
    preinstall = !!process.env.CATALYST_DOCTOR_PREINSTALL,
  } = opts;

  const nodeClassCheck = () => checkNodeClass({ nodeClass: nc });
  // CTL-1617: deployment-mode consistency — a fleet-topology fact independent
  // of node class, so it runs for every class (unlike nodeClassCheck it is
  // never the class-selection short-circuit below). strict:false always here
  // — this PR wires only the non-strict activation rubric (land-dormant,
  // CTL-1523 convention); the strict install-profile escalation branch exists
  // in checkDeploymentModeConsistency but is not wired into any profile yet.
  const deploymentModeCheck = () => checkDeploymentModeConsistency({ resolveRoster });
  // CTL-1785: entitlement consistency — a fleet-topology fact independent of node
  // class (like deploymentModeCheck), so it runs for every class. ADVISORY ONLY:
  // every check it emits is INFO/WARN, never FAIL, so it can never move doctor's
  // exit code (mirrors the CTL-1523/deployment-mode land-dormant convention).
  const entitlementCheck = () => checkEntitlementConsistency();
  // #2930 round-2: split-brain Layer-2 path layout is unsupported until the
  // canonical sweep — zero rows on every non-divergent host.
  const layer2PathDivergenceCheck = () => checkLayer2PathDivergence();
  // CTL-1616 PR2: secret-contract shadow pass — like deploymentModeCheck, a
  // fleet-topology-independent fact (does not consult resolveRoster), so it
  // runs for every class. SHADOW ONLY: every check it (and the injected
  // resolvers inside checkWebhookIngestion/checkBotCredentials/
  // checkPeerUniqueness/checkCloudTokenEnv/checkWorkerLabels) emits is
  // STATUS.INFO — zero grade change (design §7/§9). PR3 flips this to graded.
  const secretContractCheck = () => checkSecretContract();
  // CTL-2026 (Codex P2): class-INDEPENDENT, for the same reason deploymentModeCheck is.
  // The out-of-tree agent tools are invoked by an operator's skills, and a `developer`
  // node is defined a few lines below as one whose "operator's skills write
  // transitions/comments to Linear" — so a developer is precisely where these tools run.
  // Registering this only on the worker arm would have left the class that HOLDS the live
  // copies reporting clean: measured on this laptop (node class `developer`), whose
  // ~/catalyst/comms/tools/linear-reply.mjs is the drifted file this row exists to name.
  const agentToolsWritePathCheck = () => checkAgentToolsWritePath();
  const executionCoreEnvDriftCheck = () => checkExecutionCoreEnvDrift(); // CTL-2042: on-disk-vs-repo posture drift

  // Unrecognized explicit class → a single hard FAIL; grade no profile (CTL-1355).
  if (!nc.recognized) {
    return [nodeClassCheck];
  }

  // CTL-1369 PR4: the install-correctness thunks, shared by all class arms. The agent-set + pull-owner
  // for the resolved class; `strict` distinguishes the activation rubric (advisory) from the
  // post-install verification (fail-closed). Seams (undefined in production) fall through to defaults.
  const agentsThunk = () => checkAgentsForClass({ nodeClass: nc.class, strict, hasStackAgent, hasUpdaterAgent });
  const pullOwnerThunk = () => checkPluginPullOwner({ nodeClass: nc.class, strict, owner: pluginPullOwner });
  // CTL-1421: assert the worker plugin path resolves to a healthy pristine plugin-source
  // (else workers silently serve stale marketplace-cache code). worker=FAIL, dev/monitor=WARN.
  const pluginSourceFreshThunk = () => checkPluginSourceFreshness({ nodeClass: nc.class });
  // CTL-1415: a stale plugin-source .git/index.lock freezes pulls on ANY node class.
  const staleLockThunk = () => checkStaleLock();
  // skills-dir-plugin migration: catalyst loads in-place via ~/.claude/skills symlinks
  // for every session type Claude Code resolves plugins for; no marketplace/wrapper
  // residue. worker=FAIL, dev/monitor=WARN.
  const skillsDirPluginsThunk = () => checkSkillsDirPlugins({ nodeClass: nc.class });

  const replicaThunk = () => checkReadReplicaReachable({ baseUrl: readReplicaBaseUrl, fetch: _fetch });
  // CTL-2074: verify the self-echo recognition set against who ACTUALLY writes state
  // in real issue_history (not config). Advisory (never FAIL). Defaults resolve
  // proxyMode/botIds/replica internally; graded for the classes that write to Linear.
  const selfEchoIdentityHistoryThunk = () => checkSelfEchoIdentityHistory();
  const wontOwnThunk = () =>
    checkWontOwnWork({
      resolveRoster,
      isDraining: _isDraining,
      orchDir,
      bootDrained,
      getHostName: _getHostName,
    });

  if (nc.class === "developer") {
    // A developer is a FUNCTIONAL node: it reads the board via the read-replica
    // (CTL-1346) AND its operator's skills write transitions/comments to Linear, so a
    // working Linear token is REQUIRED (CTL-1355 P3). checkBotCredentials degrades a
    // missing token to WARN; for a developer that is a fail-closed FAIL on
    // linear-connectivity (an unreachable token already FAILs upstream). The
    // bot-identity ACTOR-match, by contrast, stays advisory — a developer's
    // interactive token need not be the bot — so a FAIL there downgrades to INFO.
    const developerBotCredentials = async () => {
      const cs = await checkBotCredentials({ expectedBotUserId, fetch: _fetch, linearToken: _linearToken });
      return cs.map((c) => {
        if (c.name === "linear-connectivity" && c.status === STATUS.WARN) {
          return mkCheck(
            c.name,
            STATUS.FAIL,
            `${c.detail} — a developer needs a working Linear token to read the board ` +
              `(read-replica, CTL-1346) and write transitions/comments`,
          );
        }
        if (c.name === "bot-identity" && c.status === STATUS.FAIL) {
          return mkCheck(c.name, STATUS.INFO, `${c.detail} (advisory for a developer — interactive token need not be the bot)`);
        }
        return c;
      });
    };
    // NOTE (CTL-1355 P2): no checkClaudeSettings here — that gates worker-cluster-MEMBER
    // telemetry/host-pin provisioning. A developer is a CLIENT, not a roster member; a
    // developer deliberately out of a multi-host roster must not be graded against
    // worker-member Claude settings that don't apply to it.
    return [
      nodeClassCheck,
      deploymentModeCheck, // CTL-1617: fleet-topology fact, graded for every class
      entitlementCheck, // CTL-1785: entitlement consistency, advisory-only (INFO/WARN, never FAIL), every class
      layer2PathDivergenceCheck, // CTL-1616 PR6 follow-up: split-brain Layer-2 layout FAILs until the sweep
      secretContractCheck, // CTL-1616 PR2: secret-contract shadow pass, INFO-only, graded for every class
      agentToolsWritePathCheck, // CTL-2026: out-of-tree agent tools, graded for every class
      executionCoreEnvDriftCheck, // CTL-2042: on-disk-vs-repo posture drift
      () => checkConnectivity({ seed, otel, fetch: _fetch }),
      () => checkSecretsHygiene(),
      developerBotCredentials,
      () => checkHrwPartition(), // would-own count (visibility)
      () =>
        checkDaemonlessLocal({
          nodeClass: nc.class,
          runVerifyNode,
          rows: ["broker-stopped", "exec-core-stopped", "plugins-fresh", "event-mirror-running"], // CTL-1662: without this row a dead event-mirror is invisible to doctor
        }), // broker/exec-core down + plugins fresh + event-mirror alive
      agentsThunk, // CTL-1369 PR4: updater agent installed, no worker stack (correct class agent set)
      pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=updater (a developer runs no broker)
      pluginSourceFreshThunk, // CTL-1421: worker plugin path resolves to a fresh pristine plugin-source (WARN on a developer)
      staleLockThunk, // CTL-1415: a stale plugin-source index.lock silently freezes the updater's pulls
      skillsDirPluginsThunk, // skills-dir migration: catalyst loads in-place via ~/.claude/skills; no marketplace/wrapper residue (WARN on a developer)
      replicaThunk,
      wontOwnThunk,
      () => checkReaper(), // advisory (never FAIL), class-agnostic
      () => checkHealthResponder(), // CTL-1509: cloud-sync health responder installed + baked path + kill-switch (advisory, never FAIL)
      () => checkAgentBrowser(), // CTL-1500: developers run the mini live-test browser loop too (advisory)
      () => checkMonitorProductionBuild({ fetch: _fetch }), // CTL-1372: warn on a dev-build monitor (advisory)
      () => checkCloudTokenEnv(), // advisory
      () => checkClusterSecretFreshness(), // CTL-1393: warn if running on stale rotated secrets (advisory)
      () => checkCloudSync(), // CTL-1394: developer nodes read Linear from the local replica too (advisory)
      selfEchoIdentityHistoryThunk, // CTL-2074: does the self-echo set name the id the fleet's proxied writes actually carry? (advisory)
      () => checkCloudSyncSkew(), // CTL-1659: is the RUNNING writer serving the lockfile's modules? (advisory)
      () => checkFleetTokenExport(), // CTL-1908: does a login shell spend the FLEET's Claude budget? (advisory)
      () => checkConfigScopeLeak(), // advisory
      () => checkWorkerLabels(), // CTL-1481: worker:<host> label is a best-effort visibility projection, never the claim arbiter — advisory only
      () => checkConfigProvenance(), // CTL-1793: daemon-vs-doctor Layer-1 split + per-host env overrides — advisory only (never FAIL)
      () => checkIndexServingRoot(), // CTL-1935: is this node's catalyst-index serving root the PINNED release? evaluateDepSkew cannot answer it (the indexer is an on-demand CLI with no boot record) — advisory only (never FAIL)
    ];
  }

  if (nc.class === "monitor") {
    // Most-restrictive STUB (no monitor host exists yet): reachability + must-not-
    // own-work + a fail-closed profile stub. monitor grading is unimplemented, so
    // doctor must REFUSE to certify a monitor node (FAIL, not WARN) — a WARN would
    // exit 0 and let a misconfigured monitor running the work daemons masquerade as
    // verified-healthy. This is correct because no real monitor nodes exist yet;
    // the FAIL is removed when the monitor rubric lands (CTL-1355 F3).
    return [
      nodeClassCheck,
      deploymentModeCheck, // CTL-1617: fleet-topology fact, graded for every class
      entitlementCheck, // CTL-1785: entitlement consistency, advisory-only (INFO/WARN, never FAIL), every class
      layer2PathDivergenceCheck, // CTL-1616 PR6 follow-up: split-brain Layer-2 layout FAILs until the sweep
      secretContractCheck, // CTL-1616 PR2: secret-contract shadow pass, INFO-only, graded for every class
      agentToolsWritePathCheck, // CTL-2026: out-of-tree agent tools, graded for every class
      executionCoreEnvDriftCheck, // CTL-2042: on-disk-vs-repo posture drift
      () => checkConnectivity({ seed, otel, fetch: _fetch }),
      () => checkHrwPartition(), // would-own count (visibility)
      agentsThunk, // CTL-1369 PR4: updater agent installed, no worker stack (monitor is adopt-updater-shaped)
      pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=updater
      pluginSourceFreshThunk, // CTL-1421: worker plugin path resolves to a fresh pristine plugin-source (WARN on a monitor)
      staleLockThunk, // CTL-1415: a stale plugin-source index.lock silently freezes the updater's pulls
      skillsDirPluginsThunk, // skills-dir migration: catalyst loads in-place via ~/.claude/skills; no marketplace/wrapper residue (WARN on a monitor)
      replicaThunk,
      wontOwnThunk,
      () => [
        mkCheck(
          "monitor-profile",
          STATUS.FAIL,
          "monitor profile grading is not yet implemented — fail-closed (no monitor host " +
            "exists yet); a monitor node cannot be certified by doctor until the monitor " +
            "rubric lands (CTL-1355)",
        ),
      ],
    ];
  }

  // worker (explicit OR inferred default) → today's full CTL-1186 activation gate,
  // unchanged, with the node-class check prepended (INFO/PASS — never FAILs here).
  return [
    nodeClassCheck,
    deploymentModeCheck, // CTL-1617: fleet-topology fact, graded for every class
    entitlementCheck, // CTL-1785: entitlement consistency, advisory-only (INFO/WARN, never FAIL), every class
      layer2PathDivergenceCheck, // CTL-1616 PR6 follow-up: split-brain Layer-2 layout FAILs until the sweep
    secretContractCheck, // CTL-1616 PR2: secret-contract shadow pass, INFO-only, graded for every class
    agentToolsWritePathCheck, // CTL-2026: out-of-tree agent tools, graded for every class
    executionCoreEnvDriftCheck, // CTL-2042: on-disk-vs-repo posture drift
    () => checkHostIdentity(),
    () => checkHrwPartition(),
    () => checkPeerUniqueness(),
    () => checkBotCredentials({ expectedBotUserId }),
    () => checkConnectivity({ seed, otel }),
    () => checkSecretsHygiene(),
    () => checkDaemonToolPath(), // CTL-1289: daemon launchd PATH resolves linearis/node/claude
    agentsThunk, // CTL-1369 PR4: worker work-stack agent installed, no updater agent (correct class agent set)
    pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=broker (the worker's broker owns the pull)
    pluginSourceFreshThunk, // CTL-1421: worker plugin path resolves to a fresh pristine plugin-source (FAIL — the CI/CD executor)
    staleLockThunk, // CTL-1415: a stale plugin-source index.lock silently freezes the broker's pulls
    skillsDirPluginsThunk, // skills-dir migration: catalyst loads in-place via ~/.claude/skills; no marketplace/wrapper residue (FAIL on a worker)
    () => checkWebhookIngestion(), // CTL-1284: multiHost member ingests webhooks; single-host does not
    () => checkThoughts(), // CTL-1293: member thoughts repo provisioned + non-foreign primary
    () => checkClaudeSettings(), // CTL-1231: member settings.json pins host identity + OTLP endpoint
    () => checkReaper(), // CTL-1306: orphan-sweep reaper installed + baked path still exists (not dead-127)
    () => checkLogShipper({ shipsLogs: shipsLogs("worker"), preinstall }), // CTL-1473: log-shipper present + canonical config path
    () => checkHealthResponder(), // CTL-1509: cloud-sync health responder installed + baked path + kill-switch (advisory, never FAIL)
    () => checkAgentBrowser(), // CTL-1500: worker browser tool present + >= min + idle-timeout wired + reaper (advisory, never FAIL)
    () => checkCloudTokenEnv(), // CTL-1307: cluster cloud token decrypted → projected to machine-level env (advisory)
    () => checkClusterSecretFreshness(), // CTL-1393: warn if the node is running on stale rotated secrets (advisory)
    () => checkCloudSync(), // CTL-1394: supervised cloud-sync daemon + read tier on the worker hot path (advisory)
    selfEchoIdentityHistoryThunk, // CTL-2074: does the self-echo set name the id the fleet's proxied writes actually carry? (advisory)
    () => checkCloudSyncSkew(), // CTL-1659: a merged dependency fix that never reached the running writer (advisory)
    () => checkFleetTokenExport(), // CTL-1908: the login-shell export that stalled the fleet for 7h (advisory)
    () => checkSdkExecutorAuth(), // CTL-1367 item 9: under executor=sdk, subscription auth must be correct (no api-key metering)
    () => checkSdkDaemonEnv(), // CTL-1396 item A: under executor=sdk, the RUNNING daemon's process env must carry CLAUDE_CODE_OAUTH_TOKEN (not just the operator shell) + surface recent silent sdk→bg degrades
    () => checkConfigScopeLeak(), // CTL-1214: committed Layer-1 .catalyst/config.json must not carry node/cluster scope (roster/orchestration/feedback/sweep/repoColors/hosts.json)
    () => checkRepoIconTokenScope(), // CTL-1375: monitor daemon's gh token can read configured private repos' contents (else favicons fall back to the org avatar) — advisory (never FAIL)
    () => checkMonitorProductionBuild(), // CTL-1372: warn if the local monitor serves a dev-build React bundle (leaks via performance.measure) — advisory (never FAIL)
    () => checkWorkerLabels(), // CTL-1481: worker:<host> label is a best-effort visibility projection, never the claim arbiter — advisory only
    () => checkDrainDisabled(), // CTL-1678: surface the per-node drain override + the draining-but-ignored third state — advisory only (never FAIL)
    () => checkRegistryTeamIdentity(), // CAT-52: registry team ↔ checkout teamKey contract — advisory only
    () => checkInstallCompleteness(), // CTL-1918: did the install FINISH — CLIs, plugin-source, sweep, enrolment — advisory only (never FAIL)
    () => checkHostWriteCredentialClass(), // CTL-2045: is this host's cloud WRITE credential a per-host org key, or the admin bearer that froze the board for 4h? — advisory only (never FAIL)
    () => checkLinearWriteBudget(), // CTL-1936: host cloud-write spend / exhaustion — advisory only (never FAIL)
    () => checkConfigProvenance(), // CTL-1793: daemon-vs-doctor Layer-1 split + per-host env overrides — advisory only (never FAIL)
    () => checkIndexServingRoot(), // CTL-1935: is this node's catalyst-index serving root the PINNED release? evaluateDepSkew cannot answer it (the indexer is an on-demand CLI with no boot record) — advisory only (never FAIL)
  ];
}

// installChecksForClass — CTL-1369 PR4: the FOCUSED install-verification rubric, run by
// `catalyst install` as its post-install pass (`catalyst-doctor --profile install`). Unlike the
// activation rubric, it grades ONLY what an install actually CONTROLS and lands deterministically +
// offline: the node-class itself (CTL-1355 unrecognized → FAIL), the correct launchd agent SET, and a
// sane plugin-pull owner — each `strict:true` (a not-yet-provisioned agent/owner is a FAIL, because
// post-install it MUST be correct). It deliberately OMITS the network/operational checks (Linear/bot/
// read-replica reachability/webhooks/thoughts): those depend on remote nodes + tokens an install
// can't guarantee, so failing them would mis-attribute an operational gap to the install run.
export function installChecksForClass(nc, opts = {}) {
  const {
    hasStackAgent,
    hasUpdaterAgent,
    pluginPullOwner,
    // Injectable like the sibling probes — the skills-dir state is environment-dependent
    // (a real ~/.claude tree), so tests supply a stub rather than the live filesystem.
    skillsDirCheck = () => checkSkillsDirPlugins({ nodeClass: nc.class }),
  } = opts;
  // strict:true — under install verification an INFERRED/unpersisted class is a FAIL (the install's
  // write-config must have persisted catalyst.node.class), not the activation INFO (CTL-1369 PR4 Codex P2).
  const nodeClassCheck = () => checkNodeClass({ nodeClass: nc, strict: true });
  // Unrecognized explicit class → the single hard FAIL, same as the activation rubric.
  if (!nc.recognized) return [nodeClassCheck];
  return [
    nodeClassCheck,
    () => checkAgentsForClass({ nodeClass: nc.class, strict: true, hasStackAgent, hasUpdaterAgent }),
    () => checkPluginPullOwner({ nodeClass: nc.class, strict: true, owner: pluginPullOwner }),
    // CTL (Codex #2664 P1): verify the skills-dir cutover here too. The cutover runs
    // BEST-EFFORT from the install lifecycle's write-config phase — a partial or failed
    // symlink pass does not fail the install — so without this check the install
    // reported success while the plugins did not actually load in place. This is the
    // post-install verification pass, which is exactly where a best-effort step must be
    // confirmed. No `strict` option here: unlike its siblings this check has no advisory
    // mode — it already returns FAIL when the cutover is incomplete (verified), so
    // passing strict would be a silently-ignored no-op.
    skillsDirCheck,
  ];
}

// runDoctor — orchestrate all checks, render, and return the fail count.
export async function runDoctor(opts = {}) {
  const {
    checks: checkFns = null,
    json = false,
    log: _log = (msg) => process.stdout.write(msg + "\n"),
    host = null,
    seed = process.env.CATALYST_SEED_HOST ?? null,
    otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    expectedBotUserId = null,
    // CTL-1369 PR4: "activation" (default — the full class rubric) | "install" (the focused
    // post-install verification subset). Selects which suite builder runDoctor uses.
    profile = "activation",
    // CTL-1355: the class resolver is injectable so tests can drive each rubric.
    resolveClass = resolveNodeClass,
  } = opts;

  // CTL-1355: resolve the node class once, then grade against its rubric. An
  // explicit `checks` array still bypasses selection entirely (the test seam).
  const nc = resolveClass();
  const fns =
    checkFns ??
    (profile === "install"
      ? installChecksForClass(nc, { ...opts })
      : checksForClass(nc, { ...opts, seed, otel, expectedBotUserId }));

  // Run all check functions concurrently
  const results = await Promise.all(fns.map((fn) => Promise.resolve().then(fn)));

  // Flatten: each fn may return an array or a single check
  const all = results.flat();

  const meta = { host: host ?? getHostName() };
  const output = json ? renderJson(all, meta) : renderHuman(all, meta);
  _log(output);

  const { fail } = summarize(all);
  return fail;
}

// ─── Cross-runtime main guard ─────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/doctor.mjs") || process.argv[1].endsWith("doctor.mjs"));

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  runDoctor(opts).then((code) => process.exit(code));
}
