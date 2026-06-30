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

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

import {
  getHostName,
  getClusterHosts,
  resolveClusterHosts,
  hostMembershipWarning,
  getLivenessAnchorIssue,
  getExecutor, // CTL-1367 item 9: resolve the phase-worker executor for the sdk-auth gate
  // CTL-1355: class-aware grading — resolveNodeClass selects the rubric, isDraining
  // + getExecutionCoreDir drive the developer/monitor "will NOT pick up work" gate.
  resolveNodeClass,
  NODE_CLASSES,
  isDraining,
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
  resolveNodeCloudTokenEnv,
} from "./config.mjs";
import { ownedBy } from "./hrw.mjs";
import { readPeerHeartbeats } from "./cluster-heartbeat.mjs";
// CTL-1367 item 9: reuse the single-source-of-truth subscription-auth predicate
// (sdk-run-phase-agent.mjs imports only node:* + config.mjs — no bun: protocol —
// so it is safe to pull into this node-runnable doctor).
import { assertSdkAuth } from "./sdk-run-phase-agent.mjs";
// CTL-1214: reuse the single-source-of-truth Layer-1 scope-leak validator
// (pure, no-I/O) shared with the Phase-1 config-schema tests. Lives in
// plugins/dev/scripts/lib/ (sibling of execution-core/).
import { validateLayer1Config, RELOCATED_LAYER1_KEYS } from "../lib/validate-catalyst-config.mjs";

// readLinearBotUserIds — inlined from daemon.mjs to avoid pulling in the full
// daemon dependency chain (which includes bun: protocol imports incompatible
// with node). Logic is identical; deps are already imported above.
//
// Collects all known Linear bot user UUIDs from both config layers:
//   1. ~/.config/catalyst/config.json  catalyst.linear.bot.worker.botUserId
//   2. ~/.config/catalyst/config.json  catalyst.linear.bot.orchestrator.botUserId
//   3. .catalyst/config.json           catalyst.monitor.linear.botUserId (Layer-1, back-compat)
// Returns a Set<string>. Empty set = no filter (fail-open). Never throws.
function readLinearBotUserIds(l1Path, l2Path) {
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
  });
  addFromPath(l1Path, (p, s) => {
    const uid = p?.catalyst?.monitor?.linear?.botUserId;
    if (typeof uid === "string" && uid.length > 0) s.add(uid);
  });
  return ids;
}

// ─── Check model ─────────────────────────────────────────────────────────────

export const STATUS = { PASS: "pass", WARN: "warn", FAIL: "fail", INFO: "info" };

export const mkCheck = (name, status, detail) => ({ name, status, detail });

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
    getClusterHosts: _getClusterHosts = getClusterHosts,
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
    hasLinearToken = () =>
      Boolean(
        process.env.LINEAR_API_TOKEN?.length || process.env.LINEAR_API_KEY?.length,
      ),
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
    linearToken = () =>
      process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "",
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
  const {
    daemonPath = defaultDaemonPath(),
    resolveInPath = defaultResolveInPath,
    smokeProbe = defaultSmokeProbe,
    tools = ["linearis", "node", "claude"],
  } = deps;

  if (!daemonPath) {
    return [
      mkCheck(
        "daemon-tool-path",
        STATUS.WARN,
        "no installed catalyst-stack launchd plist found — cannot assert the daemon's PATH; run `catalyst-stack install-services`",
      ),
    ];
  }

  const missing = tools.filter((t) => !resolveInPath(t, daemonPath));
  if (missing.length > 0) {
    return [
      mkCheck(
        "daemon-tool-path",
        STATUS.FAIL,
        `daemon launchd PATH cannot resolve: ${missing.join(", ")} — the daemon shells out to these every tick; missing → exit-127 silent strand (frozen eligible set, freeSlots=0). PATH=${daemonPath}`,
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
      `daemon launchd PATH resolves linearis/node/claude and they run (no exit-127)`,
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

export function checkWebhookIngestion(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    monitor = defaultReadMonitor(),
    configDir = defaultWebhookConfigDir(),
    secretFileNonEmpty = defaultSecretFileNonEmpty,
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

  // GitHub route: smee channel + a github HMAC secret (file or env).
  const ghSmee = typeof m.github?.smeeChannel === "string" ? m.github.smeeChannel : "";
  const ghSecret =
    secretFileNonEmpty(configDir, "webhook-secret") ||
    (process.env.CATALYST_WEBHOOK_SECRET ?? "").length > 0;
  const githubWired = ghSmee.length > 0 && ghSecret;

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
  const keySecretWired = (k) =>
    secretFileNonEmpty(
      configDir,
      k === "workspace" ? "linear-webhook-secret" : `linear-webhook-secret-${k}`,
    ) || (process.env.CATALYST_LINEAR_WEBHOOK_SECRET ?? "").length > 0;
  const wiredKeys = webhookKeys.filter(keySecretWired);
  const danglingKeys = webhookKeys.filter((k) => !keySecretWired(k));
  const linearWired = linSmee.length > 0 && wiredKeys.length > 0;

  if (!githubWired && !linearWired) {
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.FAIL,
        `multiHost member but NO webhook route enabled — github(smee=${ghSmee ? "set" : "unset"},secret=${ghSecret ? "set" : "unset"}) linear(smee=${linSmee ? "set" : "unset"},wiredKeys=${wiredKeys.length}); monitor-merge/comment-wakes will degrade to polling`,
      ),
    ];
  }
  if (danglingKeys.length > 0) {
    return [
      mkCheck(
        "webhook-ingestion",
        STATUS.FAIL,
        `multiHost member with half-wired Linear webhook(s): ${danglingKeys.join(", ")} configured (webhookId) but missing HMAC secret file (linear-webhook-secret-<key>)`,
      ),
    ];
  }
  return [
    mkCheck(
      "webhook-ingestion",
      STATUS.PASS,
      `webhook ingestion wired (github=${githubWired}, linear=${linearWired}, linear keys=${wiredKeys.length})`,
    ),
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

export function checkThoughts(deps = {}) {
  const {
    resolveRoster = resolveClusterHosts,
    readHumanlayer = defaultReadHumanlayer,
    cloneOk = defaultThoughtsCloneOk,
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

  // Pollution guard: primary must be coalesce-labs, NEVER a foreign repo. The
  // global thoughtsRepo fallback defaulting to groundworkapp/rightsite-cloud is
  // the exact pollution bug (locked invariant: provision-thoughts-invariant.test.sh).
  if (/groundworkapp|rightsite-cloud/i.test(thoughtsRepo) || /groundworkapp|rightsite-cloud/i.test(defaultProfile)) {
    checks.push(
      mkCheck(
        "thoughts-primary",
        STATUS.FAIL,
        `humanlayer.json primary resolves to a FOREIGN repo (thoughtsRepo="${thoughtsRepo}", defaultProfile="${defaultProfile}") — pollutes groundworkapp/rightsite-cloud; must be coalesce-labs`,
      ),
    );
  } else if (/coalesce-labs/i.test(thoughtsRepo) || defaultProfile === "coalesce-labs") {
    checks.push(mkCheck("thoughts-primary", STATUS.PASS, "humanlayer.json primary = coalesce-labs"));
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

// scanRecentBgFallback — CTL-1396 item A (3): the daemon-boot auth gate
// (resolveSdkBootExecutor) emits `execution-core.executor.bg-fallback` to the
// unified event log when executor=sdk but the daemon's own env fails the
// subscription-auth precondition (token missing OR ANTHROPIC_API_KEY set) — it
// then silently degrades the WHOLE boot to bg. A presence-of-token probe alone
// can MISS the api-key-induced fallback (token present + api-key set still
// degrades), so this complementary scan surfaces any recent degrade as a WARN.
// All reads are injectable + fail-open (a missing/unreadable log → PASS, never
// throws). Returns a single Check.
function scanRecentBgFallback({ eventLogPath, readEventLog, now, recentWindowMs }) {
  let body = "";
  try {
    body = readEventLog(eventLogPath);
  } catch {
    body = ""; // absent/unreadable → treat as "no degrades observed" (fail-open)
  }
  const cutoff = now() - recentWindowMs;
  const hours = Math.round(recentWindowMs / 3_600_000);
  let recent = 0;
  let latestTs = null;
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let evt;
    try {
      evt = JSON.parse(s);
    } catch {
      continue; // tolerate partial/corrupt lines
    }
    if (evt?.attributes?.["event.name"] !== "execution-core.executor.bg-fallback") continue;
    const t = Date.parse(evt?.ts ?? evt?.observedTs ?? "");
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) {
      recent++;
      if (latestTs === null || t > latestTs) latestTs = t;
    }
  }
  if (recent > 0) {
    return mkCheck(
      "sdk-bg-fallback",
      STATUS.WARN,
      `executor=sdk but ${recent} execution-core.executor.bg-fallback event(s) in the last ${hours}h — ` +
        `the daemon silently degraded sdk→bg at boot (most recent ${new Date(latestTs).toISOString()}); ` +
        `fix the daemon's auth env (CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY) and restart`,
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
// that inherited ~/.zshenv — so doctor can PASS while the live daemon has
// token-in-env=0 and silently degraded sdk→bg. A reinstalled/flipped node then
// looks healthy but isn't. This check closes that gap by inspecting the RUNNING
// exec-core daemon's process env (not the operator shell), and surfacing recent
// silent degrades from the unified event log.
//
// Only bites under executor=sdk (INFO no-op otherwise — the whole fleet is bg in
// Phase 1, so this is a pure pass-through until a node is explicitly flipped).
//
// Severities (the running-daemon env check):
//   • executor != sdk                         → INFO  (not applicable)
//   • no pid-file / unparseable pid           → WARN  (daemon not running; can't verify)
//   • pid present but process not found        → WARN  (stale pid; can't verify)
//   • daemon alive, NO CLAUDE_CODE_OAUTH_TOKEN  → FAIL  (clearly broken — sdk degrades to bg)
//   • daemon alive, token present, CATALYST_EXECUTOR=sdk → PASS
//   • daemon alive, token present, CATALYST_EXECUTOR != sdk → WARN (can't confirm sdk)
// Plus a second `sdk-bg-fallback` check from the event-log scan (WARN on a recent
// degrade, else PASS) — see scanRecentBgFallback.
//
// SECURITY: the token VALUE is NEVER printed or returned — only a boolean
// "present". Detail strings carry the pid and the (non-secret) CATALYST_EXECUTOR
// value only.
//
// All external access is an INJECTABLE SEAM with a real default (executor
// resolution, pid-file read, process-env read, event-log read, clock) so tests
// never shell out or touch the real daemon.
export function checkSdkDaemonEnv(deps = {}) {
  const {
    // Resolve the executor the SAME way the daemon does (getExecutor(configPath));
    // an explicit `executor` overrides resolution entirely (test seam).
    configPath = layer1Path(),
    executor = getExecutor(configPath),
    // The daemon is launched with `--pid-file <orchDir>/daemon.pid`.
    pidFilePath = resolve(getExecutionCoreDir(), "daemon.pid"),
    readPidFile = (p) => readFileSync(p, "utf8"),
    // (pid) => raw `ps eww` env text | null. Default reads the real process; tests
    // inject a synthetic env string and never shell out.
    readProcEnv = defaultReadDaemonProcEnv,
    // Recent sdk→bg silent-degrade scan over the unified event log.
    eventLogPath = getEventLogPath(),
    readEventLog = (p) => readFileSync(p, "utf8"),
    now = () => Date.now(),
    recentWindowMs = 24 * 60 * 60 * 1000, // 24h
  } = deps;

  if (executor !== "sdk") {
    return [
      mkCheck(
        "sdk-daemon-env",
        STATUS.INFO,
        `executor="${executor}" — running-daemon SDK-env gate not applicable (only enforced under executor=sdk)`,
      ),
    ];
  }

  const checks = [];

  // ── (1) RUNNING-daemon process env ──
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
    } else {
      // Presence-only parse — NEVER capture/return the token VALUE. `\S` after the
      // `=` confirms a non-empty value without binding it.
      const hasToken = /(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN=\S/.test(envText);
      const execMatch = envText.match(/(?:^|\s)CATALYST_EXECUTOR=(\S+)/);
      const execEnv = execMatch ? execMatch[1] : null;
      if (!hasToken) {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.FAIL,
            `executor=sdk but the RUNNING exec-core daemon (pid ${pid}) has NO CLAUDE_CODE_OAUTH_TOKEN ` +
              `in its process env — SDK auth will silently degrade to bg (the daemon did not inherit ` +
              `~/.zshenv; restart it from a login shell that exports the subscription token)`,
          ),
        );
      } else if (execEnv === "sdk") {
        checks.push(
          mkCheck(
            "sdk-daemon-env",
            STATUS.PASS,
            `the RUNNING exec-core daemon (pid ${pid}) carries CLAUDE_CODE_OAUTH_TOKEN and CATALYST_EXECUTOR=sdk`,
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

  // ── (2) recent silent sdk→bg degrades from the unified event log ──
  checks.push(scanRecentBgFallback({ eventLogPath, readEventLog, now, recentWindowMs }));

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
  const baked = m ? m[1] : null;
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

// checkCloudTokenEnv — CTL-1307. ADVISORY ONLY (never FAIL): the cluster-shared
// CATALYST_CLOUD_TOKEN is an OPTIONAL extension — a node stays fully local-only
// without it, so its absence must NEVER block activation. WARN only on DRIFT: the
// token has been decrypted from the catalyst-cluster repo (cluster-cloud.json)
// but is not yet projected into the machine-level env (cluster.env + ~/.zshenv
// guard). All reads are injectable + fail-open.
export function checkCloudTokenEnv(deps = {}) {
  const {
    configDir = process.env.CATALYST_CONFIG_DIR || resolve(homedir(), ".config", "catalyst"),
    zshenvPath = process.env.CATALYST_ZSHENV_FILE || resolve(homedir(), ".zshenv"),
    readFile = (p) => readFileSync(p, "utf8"),
  } = deps;
  const checks = [];

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
        "no cluster cloud token decrypted — node is local-only (expected unless opted into catalyst-cloud)",
      ),
    );
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
    return checks;
  }

  checks.push(
    mkCheck(
      "cloud-token",
      STATUS.PASS,
      "cluster cloud token projected to machine-level env (cluster.env + ~/.zshenv guard)",
    ),
  );
  return checks;
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

  // (b) replica freshness + writer liveness. KEY INSIGHT: the DB + -wal mtime only advance
  // when a change FRAME is applied, so a quiet Linear feed (no ticket changes) freezes them
  // even though the writer is perfectly alive — the SDK has no idle keepalive. So DB mtime
  // measures "time since last mirrored change", NOT writer liveness. The feed-independent
  // liveness signal is the writer-lock HEARTBEAT (<db>.writer.lock), rewritten ~every 5s.
  // Gate liveness on the lock heartbeat; report the data-age as info only, never as "down".
  if (!dbPresent) {
    checks.push(mkCheck("replica-fresh", STATUS.WARN, "replica db not present — writer has not seeded yet (not connected)"));
  } else {
    let size = 0;
    let dataNewest = 0; // newest of DB + non-empty -wal mtime = last mirrored change
    try { const s = statFile(dbPath); size = s.size; dataNewest = s.mtimeMs; } catch { /* unreadable → handled below */ }
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

  // A parsed-but-unusable verify-node result cannot certify daemonless+fresh.
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const exit = typeof result?.exit_code === "number" ? result.exit_code : null;
  if (
    checks.length === 0 ||
    result?.jq === false ||
    (exit !== null && exit !== 0) ||
    result?.verdict === "fail"
  ) {
    return [
      mkCheck(
        "verify-node",
        STATUS.FAIL,
        `could not verify daemonless local state — verify-node unavailable/failed ` +
          `(exit ${exit ?? "?"}, verdict ${result?.verdict ?? "?"}, jq ${result?.jq ?? "?"}, ` +
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
  } = opts;

  const nodeClassCheck = () => checkNodeClass({ nodeClass: nc });

  // Unrecognized explicit class → a single hard FAIL; grade no profile (CTL-1355).
  if (!nc.recognized) {
    return [nodeClassCheck];
  }

  // CTL-1369 PR4: the install-correctness thunks, shared by all class arms. The agent-set + pull-owner
  // for the resolved class; `strict` distinguishes the activation rubric (advisory) from the
  // post-install verification (fail-closed). Seams (undefined in production) fall through to defaults.
  const agentsThunk = () => checkAgentsForClass({ nodeClass: nc.class, strict, hasStackAgent, hasUpdaterAgent });
  const pullOwnerThunk = () => checkPluginPullOwner({ nodeClass: nc.class, strict, owner: pluginPullOwner });

  const replicaThunk = () => checkReadReplicaReachable({ baseUrl: readReplicaBaseUrl, fetch: _fetch });
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
      () => checkConnectivity({ seed, otel, fetch: _fetch }),
      () => checkSecretsHygiene(),
      developerBotCredentials,
      () => checkHrwPartition(), // would-own count (visibility)
      () => checkDaemonlessLocal({ nodeClass: nc.class, runVerifyNode }), // broker/exec-core down + plugins fresh
      agentsThunk, // CTL-1369 PR4: updater agent installed, no worker stack (correct class agent set)
      pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=updater (a developer runs no broker)
      replicaThunk,
      wontOwnThunk,
      () => checkReaper(), // advisory (never FAIL), class-agnostic
      () => checkMonitorProductionBuild({ fetch: _fetch }), // CTL-1372: warn on a dev-build monitor (advisory)
      () => checkCloudTokenEnv(), // advisory
      () => checkCloudSync(), // CTL-1394: developer nodes read Linear from the local replica too (advisory)
      () => checkConfigScopeLeak(), // advisory
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
      () => checkConnectivity({ seed, otel, fetch: _fetch }),
      () => checkHrwPartition(), // would-own count (visibility)
      agentsThunk, // CTL-1369 PR4: updater agent installed, no worker stack (monitor is adopt-updater-shaped)
      pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=updater
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
    () => checkHostIdentity(),
    () => checkHrwPartition(),
    () => checkPeerUniqueness(),
    () => checkBotCredentials({ expectedBotUserId }),
    () => checkConnectivity({ seed, otel }),
    () => checkSecretsHygiene(),
    () => checkDaemonToolPath(), // CTL-1289: daemon launchd PATH resolves linearis/node/claude
    agentsThunk, // CTL-1369 PR4: worker work-stack agent installed, no updater agent (correct class agent set)
    pullOwnerThunk, // CTL-1369 PR4: pluginPullOwner=broker (the worker's broker owns the pull)
    () => checkWebhookIngestion(), // CTL-1284: multiHost member ingests webhooks; single-host does not
    () => checkThoughts(), // CTL-1293: member thoughts repo provisioned + non-foreign primary
    () => checkClaudeSettings(), // CTL-1231: member settings.json pins host identity + OTLP endpoint
    () => checkReaper(), // CTL-1306: orphan-sweep reaper installed + baked path still exists (not dead-127)
    () => checkCloudTokenEnv(), // CTL-1307: cluster cloud token decrypted → projected to machine-level env (advisory)
    () => checkCloudSync(), // CTL-1394: supervised cloud-sync daemon + read tier on the worker hot path (advisory)
    () => checkSdkExecutorAuth(), // CTL-1367 item 9: under executor=sdk, subscription auth must be correct (no api-key metering)
    () => checkSdkDaemonEnv(), // CTL-1396 item A: under executor=sdk, the RUNNING daemon's process env must carry CLAUDE_CODE_OAUTH_TOKEN (not just the operator shell) + surface recent silent sdk→bg degrades
    () => checkConfigScopeLeak(), // CTL-1214: committed Layer-1 .catalyst/config.json must not carry node/cluster scope (roster/orchestration/feedback/sweep/repoColors/hosts.json)
    () => checkRepoIconTokenScope(), // CTL-1375: monitor daemon's gh token can read configured private repos' contents (else favicons fall back to the org avatar) — advisory (never FAIL)
    () => checkMonitorProductionBuild(), // CTL-1372: warn if the local monitor serves a dev-build React bundle (leaks via performance.measure) — advisory (never FAIL)
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
  const { hasStackAgent, hasUpdaterAgent, pluginPullOwner } = opts;
  // strict:true — under install verification an INFERRED/unpersisted class is a FAIL (the install's
  // write-config must have persisted catalyst.node.class), not the activation INFO (CTL-1369 PR4 Codex P2).
  const nodeClassCheck = () => checkNodeClass({ nodeClass: nc, strict: true });
  // Unrecognized explicit class → the single hard FAIL, same as the activation rubric.
  if (!nc.recognized) return [nodeClassCheck];
  return [
    nodeClassCheck,
    () => checkAgentsForClass({ nodeClass: nc.class, strict: true, hasStackAgent, hasUpdaterAgent }),
    () => checkPluginPullOwner({ nodeClass: nc.class, strict: true, owner: pluginPullOwner }),
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
