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
import {
  eventLogBasenameFor,
  resolveRotationScheme,
  parseEventLogBasename,
} from "../lib/event-log-paths.mjs";

const CATALYST_DIR = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
const EVENTS_DIR = join(CATALYST_DIR, "events");
const STATE_PATH = join(CATALYST_DIR, "event-mirror", "state.json");
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_SSH_TIMEOUT_S = 10;

// ── Utilities ─────────────────────────────────────────────────────────────────

// CTL-1216: resolved by lib/event-log-paths.mjs, not derived here.
function currentEventFile(): string {
  return eventLogBasenameFor(new Date(), resolveRotationScheme({ env: process.env }));
}

function localEventFilePath(): string {
  return join(EVENTS_DIR, currentEventFile());
}

// pickRemoteFile — WHICH file to tail on a REMOTE host.
//
// ⚠️ This is the mixed-fleet hazard, and it is the reason Phase 3 must land
// before any host flips its scheme. The old code computed the basename LOCALLY
// and applied it to the remote path: a peer writing 2026-W34.jsonl while this
// node is still on `month` would be asked for 2026-08.jsonl — a file that
// exists, that stopped growing, and that therefore returns an empty tail
// forever. The mirror would report the host HEALTHY and fan in nothing. A silent
// zero, which is the failure mode this repo keeps re-learning.
//
// So: ask the remote what it actually has and take the NEWEST log file, ordered
// by the interval its NAME encodes (not lexically — "2026-08.jsonl" and
// "2026-W34.jsonl" do not sort chronologically as strings, and not by mtime,
// which an rsync or a backup can rewrite). Anything unparseable — including the
// CTL-1813 *.legacy.* quarantine files — is skipped.
//
// Fail direction: if listing is unavailable (no listFn injected, ssh failed, or
// the remote returned nothing usable) fall back to the locally-computed name.
// That is exactly today's behaviour, so a listing failure is never WORSE than
// the status quo — it just stops being an improvement.
export function pickRemoteFile(remoteNames: string[] | null, fallback: string): string {
  if (!remoteNames || remoteNames.length === 0) return fallback;
  let best: { name: string; startMs: number } | null = null;
  for (const name of remoteNames) {
    const iv = parseEventLogBasename(name);
    if (!iv) continue;
    if (best === null || iv.startMs > best.startMs) best = { name, startMs: iv.startMs };
  }
  return best === null ? fallback : best.name;
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

/** Lists the remote host's event-log basenames. CTL-1216. Injectable for the
 *  same reason FetchFn is: the transport is swappable (a cloud changefeed drops
 *  in here without touching the dedup core). */
export type ListFn = (host: string) => Promise<string[]>;

function defaultListFn(): ListFn {
  return async (host) => {
    const proc = Bun.spawn(
      ["ssh", "-o", `ConnectTimeout=${DEFAULT_SSH_TIMEOUT_S}`, "-o", "BatchMode=yes",
       host, "ls -1 ~/catalyst/events/ 2>/dev/null || true"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // Unlike the fetch path, a listing failure is NOT fatal: pickRemoteFile
    // falls back to the locally-computed name, which is the pre-CTL-1216
    // behaviour. Returning [] rather than throwing keeps a host that merely
    // cannot be listed from being marked unhealthy.
    if (exitCode !== 0) return [];
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  };
}

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
  /** CTL-1216. Optional: absent means "compute the name locally", i.e. the
   *  pre-CTL-1216 behaviour. */
  listFn?: ListFn;
  localFile?: string;
}

export interface TickResult {
  appended: number;
  byHost: Record<string, { healthy: boolean; linesAppended: number }>;
}

export async function mirrorTick(opts: MirrorTickOpts): Promise<TickResult> {
  const { hosts, state, fetchFn, listFn } = opts;
  const localName = currentEventFile();
  const localFile = opts.localFile ?? localEventFilePath();
  const byHostResult: TickResult["byHost"] = {};
  let totalAppended = 0;

  // Ensure local events dir exists.
  mkdirSync(dirname(localFile), { recursive: true });

  await Promise.all(
    hosts.map(async (host) => {
      const hs = getHostState(state, host);

      // CTL-1216: ask the remote which file it is actually writing, and keep a
      // cursor PER FILE. The old code reset the single cursor to 0 whenever the
      // locally-computed name changed — re-reading the whole new file, and
      // losing our place in the old one while the remote was very likely still
      // appending to it across the boundary.
      let remoteNames: string[] | null = null;
      if (listFn) {
        try {
          remoteNames = await listFn(host);
        } catch {
          remoteNames = null; // listing is best-effort; pickRemoteFile falls back
        }
      }
      const remoteFile = pickRemoteFile(remoteNames, localName);

      // CTL-1812: capture the offset this read STARTS at, and set the cursor
      // ABSOLUTELY from it below. The previous `hs.cursor += bytesRead` was a
      // read-modify-write on shared mutable state, and `tail -c +N` always reads to
      // EOF — so two overlapping ticks each added (EOF - cursor) to the SAME cursor
      // and parked it far past EOF. While parked, `tail -c +N` returns nothing and
      // the mirror goes DARK: events are skipped silently, with no fragment and no
      // error. MEASURED consequence: 341,356 events (15.6% of mini, 13.6% of mini-2)
      // absent from this node's copy, and 200 mid-string fragments produced when the
      // remote later grew past the parked cursor. Setting it absolutely makes the
      // update idempotent — an overlapping tick now computes the SAME endpoint
      // instead of doubling it.
      const startCursor = hs.cursors[remoteFile] ?? 0;
      try {
        const { lines, bytesRead } = await fetchFn(host, startCursor, remoteFile);
        // Dedup is keyed on the LOCAL file we are appending to, not the remote
        // one: the ring exists to stop a line being written to this file twice,
        // and several peers on different schemes all fan into one local file.
        const survivors = filterNewLines(state, lines, localFile);
        if (survivors.length > 0) {
          appendFileSync(localFile, survivors.map(l => l + "\n").join(""));
          totalAppended += survivors.length;
        }
        hs.cursors[remoteFile] = startCursor + bytesRead;
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
  const listFn = defaultListFn();
  const state = loadState();

  console.log("[catalyst-event-mirror] starting (CTL-1654)");

  const tick = async () => {
    const hosts = resolveHosts();
    if (hosts.length === 0) {
      console.log("[catalyst-event-mirror] no hosts configured — sleeping");
      return;
    }
    const result = await mirrorTick({ hosts, state, fetchFn, listFn });
    emitHealthEvent(
      Object.fromEntries(Object.entries(result.byHost).map(([h, v]) => [h, v.healthy]))
    );
    if (result.appended > 0) {
      console.log(`[catalyst-event-mirror] appended ${result.appended} events`);
    }
    persistState(state);
  };

  // CTL-1812: RE-ENTRANCY GUARD. `setInterval(async ...)` does not await the previous
  // callback, so a tick slower than intervalMs — which a catch-up read against a 1 GB
  // remote log reliably is — starts while the last one is still in flight. That was the
  // trigger for the cursor race above. The absolute-cursor fix makes an overlap
  // HARMLESS; this makes it not happen, which also stops us re-reading (and buffering)
  // the same gigabyte twice.
  //
  // A skipped tick costs only latency: the next one reads from the same cursor to EOF,
  // so nothing is missed. That is the "an event means go look" property — the tick is
  // idempotent by observation, so declining to run one cannot lose data.
  let tickInFlight = false;
  let ticksSkipped = 0;
  const guardedTick = async () => {
    if (tickInFlight) {
      ticksSkipped += 1;
      // Silence is a defect: a mirror permanently skipping ticks is a mirror falling
      // behind, and it must be visible rather than inferred from missing events later.
      console.warn(
        `[catalyst-event-mirror] tick still in flight — skipped (${ticksSkipped} since start)`
      );
      return;
    }
    tickInFlight = true;
    try {
      await tick();
    } catch (err) {
      console.error("[catalyst-event-mirror] tick error:", err);
    } finally {
      tickInFlight = false;
    }
  };

  // Run immediately then on interval.
  await guardedTick();
  setInterval(guardedTick, intervalMs);
}
