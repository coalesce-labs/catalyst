// cluster-data.ts — CTL-865. Joins Linear fence-attachment claims (owner_host),
// heartbeat liveness, and the cluster roster into the cluster-board payload.
// Pure + fully dependency-injected (mirrors cluster-claim.mjs's `post` seam) so
// unit tests never touch the network or filesystem.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { getClusterHosts, getEventLogPath, getHostName } from "../../execution-core/config.mjs";
import { readClaim as readClaimDefault } from "../../execution-core/cluster-claim.mjs";
import { HEARTBEAT_EVENT } from "../../execution-core/heartbeat-event.mjs";

const execFileP = promisify(execFile);

// Liveness windows (5 min = live, 5–10 min = degraded, >10 = offline).
export const CLUSTER_LIVE_MS = 5 * 60_000;
export const CLUSTER_DEGRADED_MS = 10 * 60_000;

export type Liveness = "live" | "degraded" | "offline";

export interface ClusterTicketRow {
  id: string;
  title: string;
  phase: string | null;
  linearState: string;
  pr: number | null;
  prState: string | null;
}

export interface ClusterHostStatus {
  hostName: string;
  lastHeartbeatISO: string | null;
  liveness: Liveness;
  tickets: ClusterTicketRow[];
}

export interface ClusterBoardPayload {
  generatedAt: string;
  hosts: ClusterHostStatus[];
  unclaimed: ClusterTicketRow[];
}

export function classifyLiveness(lastSeenISO: string | null, now: number): Liveness {
  if (!lastSeenISO) return "offline";
  const age = now - Date.parse(lastSeenISO);
  if (!Number.isFinite(age)) return "offline";
  if (age <= CLUSTER_LIVE_MS) return "live";
  if (age <= CLUSTER_DEGRADED_MS) return "degraded";
  return "offline";
}

// scanHeartbeats — local re-implementation of recovery.mjs::readClusterHeartbeats.
// We cannot import recovery.mjs (heavy daemon graph). Same semantics: most-recent
// ts per host, payload host.name then resource host.name, skip malformed lines.
export function scanHeartbeats(raw: string): Record<string, string> {
  const lastSeen: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line || !line.includes(HEARTBEAT_EVENT)) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const attrs = evt?.attributes as Record<string, unknown> | undefined;
    if (attrs?.["event.name"] !== HEARTBEAT_EVENT) continue;
    const body = evt?.body as Record<string, unknown> | undefined;
    const resource = evt?.resource as Record<string, unknown> | undefined;
    const payload = body?.payload as Record<string, unknown> | undefined;
    const host = (payload?.["host.name"] ?? resource?.["host.name"]) as string | undefined;
    const ts = evt?.ts as string | undefined;
    if (typeof host !== "string" || !host) continue;
    if (typeof ts !== "string" || !ts) continue;
    if (!lastSeen[host] || ts > lastSeen[host]) lastSeen[host] = ts;
  }
  return lastSeen;
}

export interface ActiveTicket { id: string; title: string; linearState: string; }
export interface PrInfo { number: number; state: string; }

export interface AssembleClusterDeps {
  now: number;
  hosts: string[];
  heartbeats: Record<string, string>;
  readClaim: (ticket: string) => Promise<null | { owner_host: string | null; generation: number | null; phase: string | null; claimed_at: string | null }>;
  listActiveTickets: () => Promise<ActiveTicket[]>;
  localHost: string;
  localPhaseFor: (ticket: string) => string | null;
  prGet: (ticket: string) => PrInfo | null;
}

export async function assembleClusterBoard(deps: AssembleClusterDeps): Promise<ClusterBoardPayload> {
  const { now, hosts, heartbeats, readClaim, listActiveTickets, localHost, localPhaseFor, prGet } = deps;
  const tickets = await listActiveTickets();

  const byHost = new Map<string, ClusterTicketRow[]>();
  const ensure = (h: string) => { if (!byHost.has(h)) byHost.set(h, []); return byHost.get(h)!; };
  const unclaimed: ClusterTicketRow[] = [];

  for (const t of tickets) {
    const pr = prGet(t.id);
    const row = (phase: string | null): ClusterTicketRow => ({
      id: t.id, title: t.title, phase, linearState: t.linearState,
      pr: pr?.number ?? null, prState: pr?.state ?? null,
    });
    const claim = await readClaim(t.id);
    if (claim?.owner_host) {
      ensure(claim.owner_host).push(row(claim.phase));
      continue;
    }
    const localPhase = localPhaseFor(t.id);
    if (localPhase) {
      ensure(localHost).push(row(localPhase));
      continue;
    }
    unclaimed.push(row(null));
  }

  // Host union: roster ∪ heartbeat-only ∪ claim owners (already in byHost).
  const allHosts = new Set<string>([...hosts, ...Object.keys(heartbeats), ...byHost.keys()]);
  const hostStatuses: ClusterHostStatus[] = [...allHosts].sort().map((hostName) => {
    const lastHeartbeatISO = heartbeats[hostName] ?? null;
    return {
      hostName,
      lastHeartbeatISO,
      liveness: classifyLiveness(lastHeartbeatISO, now),
      tickets: byHost.get(hostName) ?? [],
    };
  });

  return { generatedAt: new Date(now).toISOString(), hosts: hostStatuses, unclaimed };
}

// ── Production-default wiring ────────────────────────────────────────────────

const HOME = homedir();
const WORKERS_DIR = join(HOME, "catalyst", "execution-core", "workers");

// Terminal phase statuses (mirrors TERMINAL in board-data.mjs — keep in sync).
const TERMINAL_STATUSES = new Set([
  "done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled",
]);

// PHASE_ORDER mirrors board-data.mjs — keep in sync (same drift-guard rationale).
const PHASE_ORDER = [
  "triage", "research", "plan", "implement", "verify",
  "review", "pr", "monitor-merge", "monitor-deploy", "teardown",
];

function localPhaseForDefault(ticket: string): string | null {
  const workerDir = join(WORKERS_DIR, ticket);
  let latestPhase: string | null = null;
  let latestTs = "";
  for (const phase of PHASE_ORDER) {
    const sigPath = join(workerDir, `phase-${phase}.json`);
    let sig: Record<string, unknown>;
    try {
      sig = JSON.parse(readFileSync(sigPath, "utf8")) as Record<string, unknown>;
    } catch { continue; }
    const status = sig?.status as string | undefined;
    const updatedAt = (sig?.updatedAt ?? sig?.startedAt) as string | undefined;
    if (TERMINAL_STATUSES.has(status ?? "")) continue;
    if (!updatedAt || updatedAt > latestTs) {
      latestTs = updatedAt ?? "";
      latestPhase = phase;
    }
  }
  return latestPhase;
}

async function listActiveTicketsDefault(): Promise<ActiveTicket[]> {
  try {
    const { stdout } = await execFileP("linearis", [
      "issues", "list",
      "--state", "started",
      "--format", "json",
    ], { encoding: "utf8", timeout: 15_000 });
    const rows = JSON.parse(stdout) as Array<{ id?: string; identifier?: string; title?: string; state?: { name?: string }; stateName?: string }>;
    return rows.map((r) => ({
      id: r.id ?? r.identifier ?? "",
      title: r.title ?? "",
      linearState: r.state?.name ?? r.stateName ?? "",
    })).filter((r) => r.id);
  } catch { return []; }
}

let _cache: { ts: number; payload: ClusterBoardPayload } | null = null;
const CLUSTER_TTL_MS = 30_000;

export async function getClusterBoard(opts: { prGet?: (t: string) => PrInfo | null } = {}): Promise<ClusterBoardPayload> {
  const now = Date.now();
  if (_cache && now - _cache.ts < CLUSTER_TTL_MS) return _cache.payload;
  let raw = "";
  try { raw = readFileSync(getEventLogPath(), "utf8"); } catch { /* no log yet */ }
  const payload = await assembleClusterBoard({
    now,
    hosts: getClusterHosts(),
    heartbeats: scanHeartbeats(raw),
    readClaim: (t) => readClaimDefault(t),
    listActiveTickets: listActiveTicketsDefault,
    localHost: getHostName(),
    localPhaseFor: localPhaseForDefault,
    prGet: opts.prGet ?? (() => null),
  });
  _cache = { ts: now, payload };
  return payload;
}
