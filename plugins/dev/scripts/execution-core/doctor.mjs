// doctor.mjs — catalyst doctor: fail-closed activation gate for new cluster nodes (CTL-1186).
//
// Runs a suite of read-only checks that a new node MUST pass before the
// execution-core daemon is safe to start. Each check is injectable for unit
// testing; production defaults wire to the real system calls.
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
} from "./config.mjs";
import { ownedBy } from "./hrw.mjs";
import { readPeerHeartbeats } from "./cluster-heartbeat.mjs";

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
  // --dry-run is the default behavior (no separate code path); accept it silently
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--dry-run") { /* default behavior; no-op */ }
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--expected-bot-user-id") {
      expectedBotUserId = args[++i] ?? null;
    }
  }
  return { json, expectedBotUserId, help };
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
  } = opts;

  // Default check suite — all check functions with real deps
  const defaultChecks = [
    () => checkHostIdentity(),
    () => checkHrwPartition(),
    () => checkPeerUniqueness(),
    () => checkBotCredentials({ expectedBotUserId }),
    () => checkConnectivity({ seed, otel }),
    () => checkSecretsHygiene(),
    () => checkDaemonToolPath(), // CTL-1289: daemon launchd PATH resolves linearis/node/claude
    () => checkWebhookIngestion(), // CTL-1284: multiHost member ingests webhooks; single-host does not
    () => checkThoughts(), // CTL-1293: member thoughts repo provisioned + non-foreign primary
    () => checkClaudeSettings(), // CTL-1231: member settings.json pins host identity + OTLP endpoint
    () => checkReaper(), // CTL-1306: orphan-sweep reaper installed + baked path still exists (not dead-127)
  ];

  const fns = checkFns ?? defaultChecks;

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
