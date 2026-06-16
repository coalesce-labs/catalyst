// cli/cluster.mjs — CTL-1188. `catalyst cluster <verb>` data verbs.
// Pure functions (buildStatus, addHost, removeHost, renameHost, setAnchor, tune)
// take injectable deps for unit testing; runX() wires real config/heartbeat/git;
// main() dispatches. drain + join-token are handled in the bash front end.
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getClusterHosts,
  getHostName,
  getLivenessAnchorIssue,
  getCatalystRepoDirHostsPath,
  getLayer2ConfigPath,
  isDraining,
  getExecutionCoreDir,
} from "../config.mjs";
import { readPeerHeartbeatsSync } from "../cluster-heartbeat-sync.mjs";
import { writeSecretConfig } from "../write-secret-config.mjs";
import { listInFlightTickets } from "../scheduler.mjs";

// ── Roster I/O helpers (shared across all mutating verbs) ──────────────────

function readRoster(hostsPath) {
  try {
    const parsed = JSON.parse(readFileSync(hostsPath, "utf8"));
    if (Array.isArray(parsed)) return parsed.filter((h) => typeof h === "string" && h.length > 0);
  } catch { /* absent/malformed */ }
  return [];
}

function writeRosterAtomic(hostsPath, roster) {
  const tmp = `${hostsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(roster, null, 0) + "\n");
  renameSync(tmp, hostsPath);
}

const defaultGit = (args) => execFileSync("git", args, { encoding: "utf8" });

function gitCommitRoster(git, hostsPath, message) {
  try {
    git(["add", hostsPath]);
    git(["commit", "-m", message, "--", hostsPath]);
  } catch { /* surface but non-fatal: the write already landed */ }
}

// ── buildStatus — pure merge of roster ⊕ live heartbeats ⊕ drain ──────────

export function buildStatus({ roster, self, peers, draining }) {
  const hosts = roster.map((name) => {
    const rec = peers[name];
    return {
      name,
      self: name === self,
      live: Boolean(rec && rec.last_seen),
      lastSeen: rec?.last_seen ?? null,
      inFlight: Array.isArray(rec?.in_flight_tickets) ? rec.in_flight_tickets : [],
    };
  });
  return { roster, self, draining, hosts };
}

function renderStatus(s) {
  const lines = [`Cluster roster (${s.hosts.length} host${s.hosts.length === 1 ? "" : "s"}):`];
  for (const h of s.hosts) {
    const tags = [];
    if (h.self) tags.push("self");
    if (h.live) tags.push("live");
    if (s.draining && h.self) tags.push("draining");
    const inFlight = h.inFlight.length > 0 ? ` [${h.inFlight.join(", ")}]` : "";
    lines.push(`  ${h.name}${tags.length ? " (" + tags.join(", ") + ")" : ""}${inFlight}`);
  }
  if (!s.hosts.some((h) => h.live)) lines.push("  (no live heartbeats — liveness anchor may be unset)");
  return lines.join("\n") + "\n";
}

export function runStatus(argv = []) {
  const anchor = getLivenessAnchorIssue();
  const status = buildStatus({
    roster: getClusterHosts(),
    self: getHostName(),
    peers: anchor ? readPeerHeartbeatsSync({ anchorIssue: anchor }) : {},
    draining: isDraining(getExecutionCoreDir()),
  });
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(status) + "\n");
  } else {
    process.stdout.write(renderStatus(status));
  }
  return 0;
}

// ── addHost — append a name to the roster ──────────────────────────────────

export function addHost(name, {
  hostsPath,
  self,
  readPeers = () => readPeerHeartbeatsSync({ anchorIssue: getLivenessAnchorIssue() }),
  git = defaultGit,
  commit = true,
} = {}) {
  if (!name) return { code: 2, msg: "add requires <name>" };
  const roster = readRoster(hostsPath);
  if (roster.includes(name)) return { code: 2, msg: `'${name}' already in roster` };
  const peers = readPeers();
  if (peers[name]?.last_seen) {
    return { code: 2, msg: `'${name}' is already publishing a live heartbeat` };
  }
  const next = [...roster, name];
  writeRosterAtomic(hostsPath, next);
  if (commit) gitCommitRoster(git, hostsPath, `chore(cluster): add ${name} to roster`);
  const anchorUnset = Object.keys(peers).length === 0 && !getLivenessAnchorIssue();
  return { code: 0, roster: next, anchorUnset };
}

export function runAdd(argv = []) {
  const noCommit = argv.includes("--no-commit");
  const name = argv.filter((a) => !a.startsWith("-"))[0];
  const res = addHost(name, {
    hostsPath: getCatalystRepoDirHostsPath(),
    self: getHostName(),
    commit: !noCommit,
  });
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster add: ${res.msg}\n`);
    return res.code;
  }
  process.stdout.write(`Added '${name}' to roster: [${res.roster.join(", ")}]\n`);
  process.stdout.write("Takes effect live (next scheduler tick).\n");
  if (res.anchorUnset) {
    process.stderr.write(
      "warn: liveness anchor is unset — set it with 'catalyst cluster set-anchor <ticket>'\n"
    );
  }
  return 0;
}

// ── removeHost — remove a name from the roster ────────────────────────────

export function removeHost(name, {
  hostsPath,
  self,
  inFlightCount = () => 0,
  git = defaultGit,
  commit = true,
} = {}) {
  if (!name) return { code: 2, msg: "remove requires <name>" };
  const roster = readRoster(hostsPath);
  if (!roster.includes(name)) return { code: 2, msg: `'${name}' not in roster` };
  const count = inFlightCount();
  if (name === self && count > 0) {
    return { code: 2, msg: `refusing to remove self while ${count} ticket(s) in flight` };
  }
  const next = roster.filter((h) => h !== name);
  writeRosterAtomic(hostsPath, next);
  if (commit) gitCommitRoster(git, hostsPath, `chore(cluster): remove ${name} from roster`);
  return { code: 0, roster: next };
}

export function runRemove(argv = []) {
  const noCommit = argv.includes("--no-commit");
  const name = argv.filter((a) => !a.startsWith("-"))[0];
  const orchDir = getExecutionCoreDir();
  const res = removeHost(name, {
    hostsPath: getCatalystRepoDirHostsPath(),
    self: getHostName(),
    inFlightCount: () => listInFlightTickets(orchDir).size,
    commit: !noCommit,
  });
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster remove: ${res.msg}\n`);
    return res.code;
  }
  process.stdout.write(`Removed '${name}' from roster: [${res.roster.join(", ")}]\n`);
  process.stdout.write("Takes effect live (next scheduler tick).\n");
  return 0;
}

// ── renameHost — write Layer-2 host.name + swap roster entry ──────────────

export function renameHost(newName, {
  hostsPath,
  self,
  writeLayer2 = (obj) => writeSecretConfig(getLayer2ConfigPath(), obj),
  git = defaultGit,
  commit = true,
} = {}) {
  if (!newName) return { code: 2, msg: "rename requires <newname>" };
  const roster = readRoster(hostsPath);
  if (roster.includes(newName)) return { code: 2, msg: `'${newName}' already in roster` };
  writeLayer2({ catalyst: { host: { name: newName } } });
  if (roster.includes(self)) {
    const next = roster.map((h) => (h === self ? newName : h));
    writeRosterAtomic(hostsPath, next);
    if (commit) gitCommitRoster(git, hostsPath, `chore(cluster): rename ${self} → ${newName}`);
  }
  return { code: 0, restartRequired: true };
}

export function runRename(argv = []) {
  const noCommit = argv.includes("--no-commit");
  const newName = argv.filter((a) => !a.startsWith("-"))[0];
  const self = getHostName();
  const res = renameHost(newName, {
    hostsPath: getCatalystRepoDirHostsPath(),
    self,
    commit: !noCommit,
  });
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster rename: ${res.msg}\n`);
    return res.code;
  }
  process.stdout.write(`catalyst.host.name → '${newName}'. Run 'catalyst-stack restart' to activate (HRW identity is captured at startup).\n`);
  return 0;
}

// ── setAnchor — write Layer-2 livenessAnchorIssue ────────────────────────

export function setAnchor(ticket, {
  writeLayer2 = (obj) => writeSecretConfig(getLayer2ConfigPath(), obj),
} = {}) {
  if (!ticket) return { code: 2, msg: "set-anchor requires <ticket>" };
  writeLayer2({ catalyst: { cluster: { livenessAnchorIssue: ticket } } });
  return { code: 0, restartRequired: true };
}

export function runSetAnchor(argv = []) {
  const ticket = argv.filter((a) => !a.startsWith("-"))[0];
  const res = setAnchor(ticket);
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster set-anchor: ${res.msg}\n`);
    return res.code;
  }
  process.stdout.write(`catalyst.cluster.livenessAnchorIssue → '${ticket}'. Run 'catalyst-stack restart' to activate.\n`);
  return 0;
}

// ── tune — write a live executionCore concurrency param to Layer-2 ─────────

const TUNE_PARAMS = new Set(["maxParallel", "minParallel", "maxParallelCeiling"]);

export function tune(param, value, {
  writeLayer2 = (obj) => writeSecretConfig(getLayer2ConfigPath(), obj),
} = {}) {
  if (!TUNE_PARAMS.has(param)) {
    return { code: 2, msg: `unknown tune param '${param}' (one of ${[...TUNE_PARAMS].join(", ")})` };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return { code: 2, msg: `tune ${param} requires a positive integer` };
  }
  writeLayer2({ catalyst: { orchestration: { executionCore: { [param]: n } } } });
  return { code: 0, param, value: n };
}

export function runTune(argv = []) {
  const [param, value] = argv.filter((a) => !a.startsWith("-"));
  const res = tune(param, value);
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster tune: ${res.msg}\n`);
    return res.code;
  }
  process.stdout.write(`catalyst.orchestration.executionCore.${res.param} → ${res.value}\n`);
  process.stdout.write("Takes effect live (next scheduler tick — no restart required).\n");
  return 0;
}

// ── main — dispatch ───────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv;
  let code;
  switch (verb) {
    case "status":    code = runStatus(rest); break;
    case "add":       code = runAdd(rest); break;
    case "remove":    code = runRemove(rest); break;
    case "rename":    code = runRename(rest); break;
    case "set-anchor": code = runSetAnchor(rest); break;
    case "tune":      code = runTune(rest); break;
    default:
      process.stderr.write(`catalyst cluster: unknown verb '${verb ?? ""}'\n`);
      code = 2;
  }
  process.exitCode = code ?? 0;
}

const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" && fileURLToPath(import.meta.url) === process.argv[1]);
if (isEntry) main();
