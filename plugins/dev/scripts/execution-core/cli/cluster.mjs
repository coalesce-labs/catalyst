// cli/cluster.mjs — CTL-1188. `catalyst cluster <verb>` data verbs.
// Pure functions (buildStatus, addHost, removeHost, renameHost, setAnchor, tune)
// take injectable deps for unit testing; runX() wires real config/heartbeat/git;
// main() dispatches. drain + join-token are handled in the bash front end.
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownerForTicket } from "../hrw.mjs";
import {
  getClusterHosts,
  getHostName,
  getLivenessAnchorIssue,
  getCatalystRepoDirHostsPath,
  getLayer2ConfigPath,
  isDraining,
  getExecutionCoreDir,
  readClusterConfig,
} from "../config.mjs";
import { readPeerHeartbeatsSync } from "../cluster-heartbeat-sync.mjs";
import { registerNodeSync, deregisterNodeSync } from "../node-roster-sync.mjs"; // CTL-1273: anchor writer
import { writeSecretConfig } from "../write-secret-config.mjs";
import { listInFlightTickets } from "../scheduler.mjs";
import { clusterSync } from "../cluster-sync.mjs";

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
  // CTL-1273: when an anchor is configured the node enrollment record is written
  // to the SAME anchor the resolver reads (getClusterHosts → resolveClusterHosts
  // 'anchor' source) — reader and writer share one source, so the old
  // reader/writer divergence is structurally impossible. When no anchor is set,
  // fall back to the legacy committed .catalyst/hosts.json (migration fallback).
  anchor = getLivenessAnchorIssue(),
  address = null,
  registerNode = registerNodeSync,
  readPeers = () => readPeerHeartbeatsSync({ anchorIssue: getLivenessAnchorIssue() }),
  git = defaultGit,
  commit = true,
} = {}) {
  if (!name) return { code: 2, msg: "add requires <name>" };
  const peers = readPeers();
  if (peers[name]?.last_seen) {
    return { code: 2, msg: `'${name}' is already publishing a live heartbeat` };
  }

  // Anchor path: upsert the catalyst://node/<name> enrollment record.
  if (anchor) {
    const res = registerNode({ anchorIssue: anchor, name, address });
    if (!res?.ok) {
      return { code: 1, msg: `failed to register '${name}' on anchor ${anchor}: ${res?.error ?? "unknown"}` };
    }
    return { code: 0, name, source: "anchor", anchorUnset: false };
  }

  // Legacy fallback: append to the committed .catalyst/hosts.json.
  const roster = readRoster(hostsPath);
  if (roster.includes(name)) return { code: 2, msg: `'${name}' already in roster` };
  const next = [...roster, name];
  writeRosterAtomic(hostsPath, next);
  if (commit) gitCommitRoster(git, hostsPath, `chore(cluster): add ${name} to roster`);
  return { code: 0, roster: next, source: "hosts-fallback", anchorUnset: true };
}

export function runAdd(argv = []) {
  const noCommit = argv.includes("--no-commit");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const name = positional[0];
  const address = positional[1] ?? null; // optional <address> for HRW re-homing
  const res = addHost(name, {
    hostsPath: getCatalystRepoDirHostsPath(),
    self: getHostName(),
    address,
    commit: !noCommit,
  });
  if (res.code !== 0) {
    process.stderr.write(`catalyst cluster add: ${res.msg}\n`);
    return res.code;
  }
  if (res.source === "anchor") {
    process.stdout.write(`Enrolled '${name}' on the cluster anchor.\n`);
  } else {
    process.stdout.write(`Added '${name}' to roster: [${res.roster.join(", ")}]\n`);
  }
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
  // CTL-1273: delete the enrollment record from the SAME anchor the resolver
  // reads when one is configured; else fall back to the legacy committed
  // .catalyst/hosts.json (migration fallback).
  anchor = getLivenessAnchorIssue(),
  deregisterNode = deregisterNodeSync,
  inFlightCount = () => 0,
  git = defaultGit,
  commit = true,
} = {}) {
  if (!name) return { code: 2, msg: "remove requires <name>" };
  const count = inFlightCount();
  if (name === self && count > 0) {
    return { code: 2, msg: `refusing to remove self while ${count} ticket(s) in flight` };
  }

  // Anchor path: delete the catalyst://node/<name> enrollment record.
  if (anchor) {
    const res = deregisterNode({ anchorIssue: anchor, name });
    if (!res?.ok) {
      return { code: 1, msg: `failed to deregister '${name}' on anchor ${anchor}: ${res?.error ?? "unknown"}` };
    }
    if (!res.removed) return { code: 2, msg: `'${name}' not in roster` };
    return { code: 0, name, source: "anchor" };
  }

  // Legacy fallback: remove from the committed .catalyst/hosts.json.
  const roster = readRoster(hostsPath);
  if (!roster.includes(name)) return { code: 2, msg: `'${name}' not in roster` };
  const next = roster.filter((h) => h !== name);
  writeRosterAtomic(hostsPath, next);
  if (commit) gitCommitRoster(git, hostsPath, `chore(cluster): remove ${name} from roster`);
  return { code: 0, roster: next, source: "hosts-fallback" };
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
  if (res.source === "anchor") {
    process.stdout.write(`Deregistered '${name}' from the cluster anchor.\n`);
  } else {
    process.stdout.write(`Removed '${name}' from roster: [${res.roster.join(", ")}]\n`);
  }
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

// ── sync — CTL-1211: pull the cluster repo + decrypt secrets into Layer-2 ────

export function runSync(argv = []) {
  const res = clusterSync();
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(res) + "\n");
    return res.sync.ok ? 0 : 1;
  }
  const { pull, sync, files } = res;
  const lines = [
    `cluster-sync: pull ${pull.pulled ? "ok" : `skipped (${pull.reason ?? ""})`}`,
  ];
  if (!sync.ok && sync.reason) {
    lines.push(`  configs: ${sync.reason}`);
  } else {
    lines.push(
      `  configs: ${sync.synced.length} synced` +
        (sync.skipped.length ? `, ${sync.skipped.length} skipped` : ""),
    );
  }
  lines.push(`  secret-files: ${files.written.length} written`);
  process.stdout.write(lines.join("\n") + "\n");
  return sync.ok ? 0 : 1;
}

// ── ownership — CTL-1211: make the HRW partition SEEABLE (no-contention proof) ─
// Lists every Todo ticket and the single host HRW assigns it to, grouped by host.
// `--roster=mini,mini-2` previews a hypothetical roster BEFORE flipping it live.

// buildOwnership — pure: group tickets by their HRW owner across a roster. Each
// ticket is owned by exactly one host (argmax), so there is never any overlap.
export function buildOwnership(tickets, roster) {
  const byHost = Object.fromEntries(roster.map((h) => [h, []]));
  let unassigned = 0;
  for (const t of tickets) {
    const owner = ownerForTicket(t, roster);
    if (owner && byHost[owner]) byHost[owner].push(t);
    else unassigned += 1;
  }
  return { roster, total: tickets.length, byHost, unassigned };
}

// The cluster's teams (from cluster.json.projects), fallback to CTL.
function clusterTeams() {
  const c = readClusterConfig();
  const teams = Array.isArray(c?.projects) ? c.projects.map((p) => p?.teamKey).filter(Boolean) : [];
  return teams.length ? teams : ["CTL"];
}

// linearis requires --team alongside --status, so aggregate Todo across the
// cluster's teams. A team that errors (auth/network) is skipped, not fatal.
function listTodoTickets(teams = clusterTeams()) {
  const ids = [];
  for (const team of teams) {
    const r = spawnSync("linearis", ["issues", "list", "--team", team, "--status", "Todo", "-l", "200"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status !== 0) continue;
    try {
      const parsed = JSON.parse(r.stdout);
      const items = Array.isArray(parsed) ? parsed : (parsed?.issues ?? parsed?.nodes ?? []);
      for (const t of items) {
        const id = t?.identifier ?? t?.id;
        if (typeof id === "string" && id.length > 0) ids.push(id);
      }
    } catch {
      /* skip an unparseable team response */
    }
  }
  return ids;
}

export function runOwnership(argv = [], { listTickets = listTodoTickets } = {}) {
  const rosterArg = argv.find((a) => a.startsWith("--roster="));
  const roster = rosterArg
    ? rosterArg.slice("--roster=".length).split(",").map((s) => s.trim()).filter(Boolean)
    : getClusterHosts();
  let tickets;
  try {
    tickets = listTickets();
  } catch (err) {
    process.stderr.write(`ownership: could not list tickets: ${err?.message ?? err}\n`);
    return 1;
  }
  const o = buildOwnership(tickets, roster);
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(o) + "\n");
    return 0;
  }
  const lines = [`HRW ownership over roster [${roster.join(", ")}] — ${o.total} Todo ticket(s):`];
  for (const h of roster) {
    const ts = o.byHost[h] ?? [];
    lines.push(`  ${h}: ${ts.length}${ts.length ? "  " + ts.join(", ") : ""}`);
  }
  const assigned = Object.values(o.byHost).reduce((n, a) => n + a.length, 0);
  lines.push(`  → each ticket owned by exactly one host: ${assigned}/${o.total} assigned, 0 overlap`);
  process.stdout.write(lines.join("\n") + "\n");
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
    case "sync":      code = runSync(rest); break;
    case "ownership": code = runOwnership(rest); break;
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
