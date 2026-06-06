// processes.mjs — catalyst-agent Domain 3: process attribution (CTL-812).
//
// Once per tick, snapshot every process (`ps -axo pid=,ppid=,pcpu=,rss=,comm=,
// args=`), rank the top-N by RSS, attribute each to a Catalyst worker (ticket /
// phase) by joining against the execution-core worker-signal files, and emit one
// host.process.sampled envelope per ranked process per the telemetry contract.
//
// SELF-CONTAINED: zero npm deps, node:* builtins only; runs under both node>=18
// and bun. The standalone agent does NOT import from execution-core — the
// ps-parse, worker-map scan, and ancestry walk are re-implemented here (mirroring
// execution-core/cli/sessions.mjs's parsePsSnapshot + signal-reader.mjs's
// defensive JSON read) so this file has no cross-package coupling.
//
// CONTRACT (host.process.sampled, entity=host, ONE event per top-N process):
//   attributes (dot-form, low-cardinality):
//     process.command  basename(comm) lowercased
//     process.cpu_pct  pcpu (percent-of-one-core; may exceed 100)
//     process.rss_mb   resident set size in MB (ps reports KB)
//     process.ticket?  only when the process (or an ancestor) maps to a worker
//     process.phase?   ditto
//   body.payload (high-cardinality — kept OUT of attributes to protect label
//   cardinality): pid, ppid, args (full command line), bg_job_id.
//   event.label = hostname.
//
// All I/O is injected (psLines, readWorkerMap, emit, now) so sampleProcesses is
// fully unit-testable with no real ps, no real filesystem, no real clock.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { buildAgentEnvelope, emitEnvelope } from "./emit.mjs";
import { readAgentConfig, log } from "./config.mjs";

export const PROCESS_EVENT_SAMPLED = "host.process.sampled";

// macOS `ps` renders the intermediate `comm` column at a FIXED width, space-
// padded, when a later column (`args`) follows it. 16 is that documented width
// (`/System/Library/` etc. clamp to exactly 16 chars). The trailing `args`
// column is the full, untruncated command line and runs to end-of-line — which
// is why `args=` MUST be last in the ps spec: it is the only field allowed to
// contain spaces past the fixed columns.
const COMM_COLUMN_WIDTH = 16;

// The 4 leading numeric fields (pid ppid pcpu rss) are whitespace-free, so a
// single regex peels them off; group 5 is the variable tail (comm + args).
const LEADING_FIELDS = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

/**
 * parsePsLines — parse `ps -axo pid=,ppid=,pcpu=,rss=,comm=,args=` output into
 * row objects. Pure; never throws on a malformed line (it is skipped).
 *
 * The tail after the 4 numeric fields is `comm`(fixed-width, space-padded) + a
 * separator + `args`(full, may contain spaces). `command` is `basename(comm)`
 * lowercased per the telemetry contract: comm is the executable path, so its
 * basename is the low-cardinality command name (e.g. `node`, `claude`, `zsh`)
 * — and it is the right source even when argv[0] is rewritten (a login shell's
 * argv[0] is `-zsh`, whose basename is the misleading `-zsh`; comm stays
 * `/bin/zsh`). `args` is the full command line, kept for the body.payload only.
 * When there is no args column (a comm-only line) the whole tail is comm.
 *
 * @param {string[]} lines  raw ps lines (a trailing blank line is fine)
 * @returns {{pid:number, ppid:number, cpu_pct:number, rss_kb:number, command:string, args:string}[]}
 */
export function parsePsLines(lines = []) {
  const rows = [];
  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+$/, ""); // rstrip only — leading pad is significant for the fields regex
    if (!line.trim()) continue;
    const m = LEADING_FIELDS.exec(line);
    if (!m) continue;

    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cpu_pct = Number(m[3]);
    const rss_kb = Number(m[4]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

    const tail = m[5];
    // comm occupies the first COMM_COLUMN_WIDTH chars (space-padded); args is
    // the remainder. When the line is shorter than the column (no args column at
    // all, e.g. a comm-only line) the whole tail is comm and args is "".
    const comm = tail.slice(0, COMM_COLUMN_WIDTH).trim();
    const args = tail.slice(COMM_COLUMN_WIDTH).trim();

    // basename(comm) lowercased — the contract's low-cardinality command name.
    const command = basename(comm).toLowerCase() || null;

    rows.push({
      pid,
      ppid,
      cpu_pct: Number.isFinite(cpu_pct) ? cpu_pct : null,
      rss_kb: Number.isFinite(rss_kb) ? rss_kb : null,
      command,
      args: args || comm, // payload-only; keep the fullest command line we have
    });
  }
  return rows;
}

/**
 * rankTopN — return the N rows with the largest RSS, descending. Ties broken by
 * CPU descending (a busy process is the more interesting one to surface). Pure.
 *
 * @param {object[]} rows  parsed ps rows
 * @param {number} topN    how many to keep (already floored to >= 1 by config)
 */
export function rankTopN(rows, topN) {
  const n = Math.max(1, Math.floor(Number(topN) || 1));
  return [...rows]
    .sort((a, b) => {
      const rssDelta = (b.rss_kb ?? 0) - (a.rss_kb ?? 0);
      if (rssDelta !== 0) return rssDelta;
      return (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0);
    })
    .slice(0, n);
}

/**
 * attributeRow — resolve a row's owning worker by walking the ppid chain: the
 * row itself, then its parent, grandparent, … up to MAX_CHAIN hops. A `claude
 * --bg` worker spawns node / claude / MCP children whose PIDs are NOT in the
 * worker map; walking ancestors lets those descendants inherit the worker's
 * ticket/phase. Returns the matched worker entry ({ticket, phase, bg_job_id})
 * or null. Pure given `byPid` (pid→row) and `workerMap` (pid→entry).
 */
const MAX_CHAIN = 20;
export function attributeRow(row, byPid, workerMap) {
  let pid = row?.pid;
  const seen = new Set();
  for (let hops = 0; hops < MAX_CHAIN; hops++) {
    if (pid == null || seen.has(pid)) break; // null parent or a cycle → stop
    seen.add(pid);
    const hit = workerMap.get(pid);
    if (hit) return hit;
    const parent = byPid.get(pid);
    if (!parent) break;
    pid = parent.ppid;
    if (pid === 0) break; // reached init/launchd — no worker above here
  }
  return null;
}

/**
 * sampleProcesses — Domain 3 tick. Snapshot processes, rank top-N by RSS,
 * attribute each to a worker, and emit one host.process.sampled per ranked row.
 * Returns the array of envelopes emitted (handy for tests / callers).
 *
 * All seams injected; defaults run the real ps / filesystem / emit.
 *
 * @param {object} [opts]
 * @param {Function} [opts.psLines=defaultPsLines]            () => string[]
 * @param {Function} [opts.readWorkerMap=defaultReadWorkerMap] () => Map<pid,{ticket,phase,bg_job_id}>
 * @param {number}   [opts.topN]                              default from config (10)
 * @param {Function} [opts.emit=defaultEmit]                  (envelope) => void
 * @param {Function} [opts.now]                               injectable ISO-timestamp fn
 * @returns {object[]} the emitted envelopes
 */
export function sampleProcesses({
  psLines = defaultPsLines,
  readWorkerMap = defaultReadWorkerMap,
  topN = readAgentConfig().topN,
  emit = defaultEmit,
  now,
} = {}) {
  let rows;
  try {
    rows = parsePsLines(psLines());
  } catch (err) {
    log.warn({ err: err?.message }, "processes: ps snapshot failed");
    return [];
  }

  // pid→row index for the ancestry walk, and the (defensive, never-throw) worker map.
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let workerMap;
  try {
    workerMap = readWorkerMap() ?? new Map();
  } catch (err) {
    log.warn({ err: err?.message }, "processes: worker map read failed");
    workerMap = new Map();
  }

  const host = hostname();
  const top = rankTopN(rows, topN);
  const envelopes = [];

  for (const row of top) {
    const worker = attributeRow(row, byPid, workerMap);
    const envelope = buildAgentEnvelope(
      PROCESS_EVENT_SAMPLED,
      {
        entity: "host",
        label: host,
        // Dot-form value attributes; ticket/phase included ONLY when matched
        // (the put() pattern in buildAgentEnvelope drops null/undefined).
        attrs: {
          "process.command": row.command,
          "process.cpu_pct": row.cpu_pct,
          "process.rss_mb": row.rss_kb == null ? null : Math.round(row.rss_kb / 1024),
          "process.ticket": worker?.ticket ?? null,
          "process.phase": worker?.phase ?? null,
        },
        // High-cardinality fields stay in the payload, never as labels.
        payload: {
          pid: row.pid,
          ppid: row.ppid,
          args: row.args,
          bg_job_id: worker?.bg_job_id ?? null,
        },
      },
      { now },
    );
    envelopes.push(envelope);
    try {
      emit(envelope);
    } catch (err) {
      log.warn({ err: err?.message }, "processes: emit failed");
    }
  }

  return envelopes;
}

// --- Defaults (the real-I/O seams; replaced wholesale in tests) ---

// defaultPsLines — the real process snapshot. `args=` is LAST because it is the
// only field permitted to contain spaces (see parsePsLines). Best-effort: any
// ps failure yields [] so the tick degrades to "no processes" instead of
// throwing.
function defaultPsLines() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024, // generous: a busy host can have thousands of procs
    });
    return out.split("\n");
  } catch (err) {
    log.warn({ err: err?.message }, "processes: ps exec failed");
    return [];
  }
}

// catalystDir — own copy (the standalone agent does not import execution-core).
// CATALYST_DIR override is honored so tests redirect the worker-map scan.
function catalystDir() {
  return process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
}

/**
 * defaultReadWorkerMap — scan ${CATALYST_DIR}/execution-core/workers/<TICKET>/
 * for JSON signal files and build a pid→{ticket, phase, bg_job_id} map. The
 * execution-core worker signals carry pid (flat oneshot) and/or bg_job_id +
 * phase (nested phase-agent); only signals with a numeric `pid` join here (the
 * ps snapshot is keyed by pid). Fully defensive: a missing workers dir, an
 * unreadable subdir, or a malformed JSON file is skipped — NEVER throws.
 *
 * @param {string} [root]  override the workers root (defaults under CATALYST_DIR)
 * @returns {Map<number, {ticket:?string, phase:?string, bg_job_id:?string}>}
 */
export function defaultReadWorkerMap(root = join(catalystDir(), "execution-core", "workers")) {
  const map = new Map();
  let tickets;
  try {
    tickets = readdirSync(root, { withFileTypes: true });
  } catch {
    return map; // no workers dir yet → empty map → everything unattributed
  }

  for (const entry of tickets) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue; // unreadable subdir → skip
    }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue; // malformed signal → skip (defensive parse)
      }
      const pid = Number(raw?.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue; // only pid-bearing signals join
      // First writer wins per pid; a later signal for the same pid does not
      // clobber an earlier mapping (signals for one worker are consistent).
      if (map.has(pid)) continue;
      map.set(pid, {
        ticket: raw.ticket ?? entry.name ?? null,
        phase: raw.phase == null ? null : String(raw.phase),
        bg_job_id: raw.bg_job_id ?? null,
      });
    }
  }
  return map;
}

// defaultEmit — route one envelope through the configured transport(s) via the
// shared emitEnvelope() helper (eventlog / otlp / both). Best-effort; never throws.
function defaultEmit(envelope) {
  emitEnvelope(envelope, readAgentConfig());
}
