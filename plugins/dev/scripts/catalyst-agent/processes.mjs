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
// PS PARSING IS CROSS-PLATFORM (CTL-812 review). The `comm` column is rendered
// differently per OS: macOS clamps it to a fixed 16-char, space-padded width (and
// truncates deep paths, e.g. /usr/libexec/logd → /usr/libexec/log); Linux renders
// comm at its natural width with a single space before args. splitCommArgs handles
// both (keyed on process.platform, injectable), and deriveCommand heals a
// macOS-truncated comm from the full argv[0] carried in the args column while
// still deferring to comm when argv[0] was rewritten (a login shell's `-zsh`).
//
// CONTRACT (host.process.sampled, entity=host, ONE event per top-N process):
//   attributes (dot-form, low-cardinality):
//     process.command  basename of the executable, lowercased (healed from argv[0]
//                      when comm was truncated; see deriveCommand)
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
import { homedir } from "node:os";
import { shortHostname } from "./emit.mjs";
import { buildAgentEnvelope, emitEnvelope, drainPending } from "./emit.mjs";
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
 * splitCommArgs — split the variable tail (everything after the 4 numeric ps
 * fields) into { comm, args }. Cross-platform (CTL-812 review): the fixed 16-char
 * comm column is a macOS-only rendering; Linux `ps -o comm=,args=` renders comm at
 * its NATURAL width with a single space before args.
 *
 *   darwin → comm occupies a fixed COMM_COLUMN_WIDTH (16) space-padded column,
 *            then args runs to EOL. A line shorter than the column (a comm-only
 *            line, no args spec matched) is all comm. Slicing at 16 is correct.
 *   other  → comm is the FIRST whitespace-delimited token (its natural width);
 *            args is the remainder after the single separating space. comm has no
 *            embedded spaces (it is one executable path token), so this is exact.
 *
 * `platform` is injectable so both renderings are unit-testable on one host.
 * Pure; never throws.
 *
 * @param {string} tail
 * @param {string} [platform]  defaults to process.platform
 * @returns {{comm: string, args: string}}
 */
export function splitCommArgs(tail, platform = process.platform) {
  if (platform === "darwin") {
    // Fixed-width comm column (space-padded to 16) then args to EOL.
    const comm = tail.slice(0, COMM_COLUMN_WIDTH).trim();
    const args = tail.slice(COMM_COLUMN_WIDTH).trim();
    return { comm, args };
  }
  // Linux / other: comm is the first token (natural width); args is the rest.
  const idx = tail.indexOf(" ");
  if (idx === -1) return { comm: tail.trim(), args: "" };
  return { comm: tail.slice(0, idx).trim(), args: tail.slice(idx + 1).trim() };
}

/**
 * deriveCommand — pick the low-cardinality command name (basename, lowercased)
 * from comm + the full args column. CTL-812 review:
 *   - macOS truncates the comm column to 16 chars, so a deep path is cut BEFORE
 *     basename is taken (`/usr/libexec/logd` → `/usr/libexec/log` → `log`, losing
 *     the trailing 'd'; `/System/Library/PrivateFrameworks/…` → `/System/Library/`
 *     → `library`). The args column carries the FULL, untruncated argv[0] path, so
 *     when comm is a prefix of argv[0] we know comm was truncated and basename of
 *     argv[0] is the correct, complete command name.
 *   - BUT argv[0] is sometimes rewritten and is NOT the executable path: a login
 *     shell's argv[0] is `-zsh` while comm is `/bin/zsh`. There comm is the
 *     authority and basename(comm) → `zsh` is right. The "comm is a prefix of
 *     argv[0]" guard rejects the rewritten case (`/bin/zsh` is not a prefix of
 *     `-zsh`), so comm wins exactly when it should.
 *
 * Pure; returns null only when nothing usable is present.
 *
 * @param {string} comm   the (possibly truncated) comm value
 * @param {string} args   the full command line (argv[0] … is its head)
 * @returns {string|null}
 */
export function deriveCommand(comm, args) {
  const argv0 = (args || "").split(/\s+/)[0] || "";
  // comm truncated (macOS deep path): argv0 is the full path that comm prefixes.
  if (comm && argv0 && argv0.startsWith(comm) && argv0.length > comm.length) {
    return basename(argv0).toLowerCase() || null;
  }
  // Otherwise comm is authoritative (covers the rewritten-argv0 login-shell case).
  return basename(comm).toLowerCase() || null;
}

/**
 * parsePsLines — parse `ps -axo pid=,ppid=,pcpu=,rss=,comm=,args=` output into
 * row objects. Pure; never throws on a malformed line (it is skipped).
 *
 * The tail after the 4 numeric fields is `comm` + a separator + `args` (full, may
 * contain spaces); see splitCommArgs for the per-platform column layout. The
 * `command` is the basename (lowercased) of the executable, derived by
 * deriveCommand so a macOS-truncated comm is healed from the full argv[0] in args
 * while a rewritten argv[0] (`-zsh`) still defers to comm. `args` is the full
 * command line, kept for body.payload only. A comm-only line (no args) keeps the
 * whole tail as comm.
 *
 * @param {string[]} lines      raw ps lines (a trailing blank line is fine)
 * @param {object}  [opts]
 * @param {string}  [opts.platform]  comm-column rendering; defaults to process.platform
 * @returns {{pid:number, ppid:number, cpu_pct:number, rss_kb:number, command:string, args:string}[]}
 */
export function parsePsLines(lines = [], { platform = process.platform } = {}) {
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
    const { comm, args } = splitCommArgs(tail, platform);

    // The contract's low-cardinality command name (basename, lowercased),
    // healed from argv[0] when comm was truncated (see deriveCommand).
    const command = deriveCommand(comm, args);

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
 * ASYNC so the OTLP transport can be drained before resolving: the default emit
 * returns the pending OTLP POST promise per envelope, and sampleProcesses awaits
 * all of them before returning. Without this drain the `--once` / launchd path
 * would exit while POSTs are still in flight, dropping telemetry every tick
 * (CTL-812 review). The eventlog transport is synchronous (appendFileSync), so
 * eventlog-mode ticks resolve with nothing to await.
 *
 * All seams injected; defaults run the real ps / filesystem / emit.
 *
 * @param {object} [opts]
 * @param {Function} [opts.psLines=defaultPsLines]            () => string[]
 * @param {Function} [opts.readWorkerMap=defaultReadWorkerMap] () => Map<pid,{ticket,phase,bg_job_id}>
 * @param {number}   [opts.topN]                              default from config (10)
 * @param {Function} [opts.emit=defaultEmit]                  (envelope) => Promise|void; a returned promise is drained
 * @param {Function} [opts.now]                               injectable ISO-timestamp fn
 * @param {string}   [opts.platform]                          ps comm-column rendering (defaults to process.platform)
 * @returns {Promise<object[]>} the emitted envelopes (after the OTLP drain)
 */
export async function sampleProcesses({
  psLines = defaultPsLines,
  readWorkerMap = defaultReadWorkerMap,
  topN = readAgentConfig().topN,
  emit = defaultEmit,
  now,
  platform = process.platform,
} = {}) {
  let rows;
  try {
    rows = parsePsLines(psLines(), { platform });
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

  const host = shortHostname();
  const top = rankTopN(rows, topN);
  const envelopes = [];
  // OTLP POST promises returned by emit, drained before we resolve so the
  // --once path never exits with a request still in flight (CTL-812 review).
  const pending = [];

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
      // emit may return a pending OTLP POST promise (otlp/both mode); collect it
      // so it is drained below rather than abandoned on process.exit().
      const posted = emit(envelope);
      if (posted && typeof posted.then === "function") pending.push(posted);
    } catch (err) {
      log.warn({ err: err?.message }, "processes: emit failed");
    }
  }

  // Drain any in-flight OTLP POSTs before resolving (no-op in eventlog mode).
  await drainPending(pending);
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
// shared emitEnvelope() helper (eventlog / otlp / both). Returns the pending OTLP
// POST promise (or null) so sampleProcesses can drain it before resolving in the
// --once path. Best-effort; never throws.
function defaultEmit(envelope) {
  return emitEnvelope(envelope, readAgentConfig());
}
