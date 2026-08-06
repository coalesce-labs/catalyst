#!/usr/bin/env bun
// event-mirror/index.ts — CTL-1654: fleet event-mirror daemon.
// Fans each fleet host's ~/catalyst/events/YYYY-MM.jsonl into the LOCAL event file,
// append-only and idempotent by event id, so `catalyst-events tail`/`wait-for`
// on a monitor/developer laptop see fleet-wide events.
//
// Transport seam: fetchLinesFromHost is injected (default = ssh-tail), so a future
// cloud changefeed transport lands as an alternate implementation without touching
// the fan-in / dedup core.

import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  newMirrorState,
  getHostState,
  filterNewLines,
  type MirrorState,
} from "./lib/state.ts";

const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const EVENTS_DIR = join(CATALYST_DIR, "events");
const STATE_PATH = join(CATALYST_DIR, "event-mirror", "state.json");
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_SSH_TIMEOUT_S = 10;

// ── Utilities ─────────────────────────────────────────────────────────────────

function currentMonthFile(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}.jsonl`;
}

function localEventFilePath(): string {
  return join(EVENTS_DIR, currentMonthFile());
}

function loadState(): MirrorState {
  try {
    if (!existsSync(STATE_PATH)) return newMirrorState();
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<MirrorState>;
    const state = newMirrorState();
    if (raw.byHost) state.byHost = raw.byHost as MirrorState["byHost"];
    // seenIds not persisted (memory-only ring, reset on restart or month rollover).
    return state;
  } catch {
    return newMirrorState();
  }
}

function persistState(state: MirrorState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    // Persist byHost cursors only (seenIds is memory-only).
    writeFileSync(STATE_PATH, JSON.stringify({ byHost: state.byHost }, null, 2));
  } catch {
    // Non-fatal: next tick re-reads from cursor 0 (causes dedup via seenIds).
  }
}

// ── Default transport: ssh-tail ───────────────────────────────────────────────

export interface FetchResult {
  lines: string[];
  bytesRead: number;
}

export type FetchFn = (
  host: string,
  cursor: number,
  file: string
) => Promise<FetchResult>;

function defaultFetchFn(): FetchFn {
  return async (host, cursor, file) => {
    const remoteFile = `~/catalyst/events/${file}`;
    // tail -c +N reads from byte N (1-based in tail; cursor is 0-based → +cursor+1).
    const offset = cursor + 1;
    const proc = Bun.spawn(
      ["ssh", "-o", `ConnectTimeout=${DEFAULT_SSH_TIMEOUT_S}`, "-o", "BatchMode=yes",
       host, `tail -c +${offset} ${remoteFile} 2>/dev/null || true`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // CTL-1654 (Codex P2): distinguish a healthy-but-empty tail from a failed SSH.
    // The remote `... 2>/dev/null || true` masks a MISSING/empty remote file (rc 0,
    // empty stdout = a reachable host with nothing new — legitimately healthy). But
    // an ssh connect/auth failure exits non-zero (e.g. 255) BEFORE the remote shell
    // runs, so `|| true` never sees it. Treat any non-zero exit as a fetch failure
    // and throw: mirrorTick's per-host catch then marks the host UNHEALTHY instead of
    // silently reporting it healthy-with-zero-lines (which leaves the local event log
    // blind to that worker while still emitting a healthy tick).
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      const firstLine = stderr.trim().split("\n")[0] ?? "";
      throw new Error(
        `event-mirror: ssh tail of ${host} failed (exit ${exitCode})` +
        (firstLine ? `: ${firstLine.slice(0, 200)}` : "")
      );
    }
    const raw = stdout;
    const lines = raw.split("\n").filter(l => l.trim());
    return { lines, bytesRead: Buffer.byteLength(raw, "utf8") };
  };
}

// ── Health event ──────────────────────────────────────────────────────────────

function emitHealthEvent(byHostHealth: Record<string, boolean>): void {
  const evt = {
    ts: new Date().toISOString(),
    attributes: {
      "event.name": "catalyst.event_mirror.tick",
      "service.name": "catalyst.event-mirror",
    },
    body: {
      payload: { byHost: byHostHealth },
    },
  };
  try {
    const localFile = localEventFilePath();
    mkdirSync(dirname(localFile), { recursive: true });
    appendFileSync(localFile, JSON.stringify(evt) + "\n");
  } catch {
    // Non-fatal: health event loss is not a mirror failure.
  }
}

// ── Core tick ─────────────────────────────────────────────────────────────────

export interface MirrorTickOpts {
  hosts: string[];
  state: MirrorState;
  fetchFn: FetchFn;
  localFile?: string;
}

export interface TickResult {
  appended: number;
  byHost: Record<string, { healthy: boolean; linesAppended: number }>;
}

export async function mirrorTick(opts: MirrorTickOpts): Promise<TickResult> {
  const { hosts, state, fetchFn } = opts;
  const currentFile = currentMonthFile();
  const localFile = opts.localFile ?? localEventFilePath();
  const byHostResult: TickResult["byHost"] = {};
  let totalAppended = 0;

  // Ensure local events dir exists.
  mkdirSync(dirname(localFile), { recursive: true });

  await Promise.all(
    hosts.map(async (host) => {
      const hs = getHostState(state, host);
      // Reset cursor on file rollover (month changed).
      if (hs.currentFile && hs.currentFile !== currentFile) {
        hs.cursor = 0;
      }
      hs.currentFile = currentFile;

      try {
        const { lines, bytesRead } = await fetchFn(host, hs.cursor, currentFile);
        const survivors = filterNewLines(state, lines, currentFile);
        if (survivors.length > 0) {
          appendFileSync(localFile, survivors.map(l => l + "\n").join(""));
          totalAppended += survivors.length;
        }
        hs.cursor += bytesRead;
        hs.healthy = true;
        hs.lastSeenTs = new Date().toISOString();
        byHostResult[host] = { healthy: true, linesAppended: survivors.length };
      } catch {
        hs.healthy = false;
        byHostResult[host] = { healthy: false, linesAppended: 0 };
      }
    })
  );

  return { appended: totalAppended, byHost: byHostResult };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function resolveHosts(): string[] {
  const envHosts = process.env.CATALYST_EVENT_MIRROR_HOSTS;
  if (envHosts) return envHosts.split(",").map(h => h.trim()).filter(Boolean);
  // Fallback: try to read cluster.json roster minus self.
  try {
    // CTL-1654 (Codex P2): honor the canonical Catalyst-dir chain the SAME way
    // execution-core/config.mjs getClusterRepoDir() does — CATALYST_CLUSTER_JSON
    // (an explicit file) ?? CATALYST_CLUSTER_DIR ?? <CATALYST_DIR|~/catalyst>/catalyst-cluster
    // — so an install with a relocated CATALYST_DIR / CATALYST_CLUSTER_DIR reads its
    // real roster instead of a stale ~/catalyst default (or resolving to no hosts and
    // a healthy-looking mirror that never fans in fleet events).
    const clusterDir = process.env.CATALYST_CLUSTER_DIR ??
      join(CATALYST_DIR, "catalyst-cluster");
    const clusterPath = process.env.CATALYST_CLUSTER_JSON ??
      join(clusterDir, "cluster.json");
    if (existsSync(clusterPath)) {
      const cluster = JSON.parse(readFileSync(clusterPath, "utf8")) as { roster?: string[] };
      const selfName = process.env.CATALYST_HOST_NAME ?? hostname();
      return (cluster.roster ?? []).filter(h => h !== selfName);
    }
  } catch { /* fall through */ }
  return [];
}

if (import.meta.main) {
  const intervalMs = parseInt(process.env.CATALYST_EVENT_MIRROR_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10);
  const fetchFn = defaultFetchFn();
  const state = loadState();

  console.log("[catalyst-event-mirror] starting (CTL-1654)");

  const tick = async () => {
    const hosts = resolveHosts();
    if (hosts.length === 0) {
      console.log("[catalyst-event-mirror] no hosts configured — sleeping");
      return;
    }
    const result = await mirrorTick({ hosts, state, fetchFn });
    emitHealthEvent(
      Object.fromEntries(Object.entries(result.byHost).map(([h, v]) => [h, v.healthy]))
    );
    if (result.appended > 0) {
      console.log(`[catalyst-event-mirror] appended ${result.appended} events`);
    }
    persistState(state);
  };

  // Run immediately then on interval.
  await tick().catch(err => console.error("[catalyst-event-mirror] tick error:", err));
  setInterval(async () => {
    await tick().catch(err => console.error("[catalyst-event-mirror] tick error:", err));
  }, intervalMs);
}
