// beliefs/collector.mjs — CTL-933 belief-store Step 1: the in-daemon fact
// collector (spec §6 "Collector", behavior-neutral shadow mode).
//
// Once per scheduler tick it snapshots every observation source the daemon
// already touches into ~/catalyst/beliefs.db (schema.mjs, spec §1):
//   obs_agent      — the cached `claude agents --json` listing, ALL fields
//                    (including .state, the field the procedural code never read)
//   obs_signal     — workers/<T>/phase-*.json via readWorkerSignals
//   obs_job        — ~/.claude/jobs/<id>/state.json, parsed HERE in full
//                    (state/tempo/detail/needs/firstTerminalAt/cliVersion +
//                    timestamps). Deliberately NOT recovery.mjs's statJob —
//                    CTL-932 owns that file and is changing in parallel.
//   obs_transcript — transcript stat via session-recency.mjs's resolver
//   obs_heartbeat  — worker.heartbeat tail of the unified event log, with a
//                    durable byte cursor (cfg row) so rows are never duplicated
//   obs_linear     — Linear state via the daemon's TTL cache when wired; a
//                    null state means "unreadable this tick" (schema contract)
//
// Failure contract: NOTHING here may break the tick. collectTickFacts never
// throws — each SOURCE is individually try/caught (one exploding source still
// lets every other source land under the same tick row), and a broken db
// degrades to { ok:false }. Assertion discipline for tests: never assert
// inside an injected fake — the per-source catch would swallow the failure.
//
// `now` CONTRACT (spec §2, standardized): `now` is a FINITE NUMBER of epoch
// milliseconds captured ONCE per tick by the caller — a fact, not a function.
// Functions are rejected (the pre-review ambiguity). When omitted (standalone
// use) the collector reads Date.now() exactly once; no other clock read exists
// anywhere in the write path, including retention pruning. This is what makes
// any recorded tick replayable byte-for-byte.
//
// Shadow gate: OPT-IN via CATALYST_BELIEFS_SHADOW=1 (default OFF — this is a
// new synchronous write on the hot tick; adversarial-review decision, deviates
// from spec §6's default-on sketch). Write-only: nothing reads beliefs.db.
//
// Retention (spec §6): obs_* and tick rows pruned at 14 days; belief/intent at
// 90 days. A tick older than 14d survives while a belief/intent still cites it
// (provenance time-spine). Prune runs once per PRUNE_EVERY_TICKS ticks (and on
// the first tick after boot), reusing the tick's own `now`.

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import { shortIdFromSessionId } from "../claude-ids.mjs";
import { getAgentsCached } from "../claude-agents.mjs";
import { readAllPhaseSignals } from "../signal-reader.mjs";
import { findTranscript, defaultProjectsDir } from "../session-recency.mjs";
import { getEventLogPath, getHostName, log } from "../config.mjs";

const DAY_MS = 86_400_000;
const OBS_RETENTION_MS = 14 * DAY_MS; // obs_* + tick
const BELIEF_RETENTION_MS = 90 * DAY_MS; // belief + intent
// At the ~5s–60s tick cadence this keeps pruning roughly hourly-or-rarer
// without ever letting a long-lived daemon skip it entirely.
const PRUNE_EVERY_TICKS = 120;

// Module state: one cached db handle for the daemon's lifetime + the prune
// cadence counter. Reset hook below keeps tests hermetic.
let _moduleDb = null;
let _tickCount = 0;

export function __resetBeliefsCollectorForTests() {
  _tickCount = 0;
  if (_moduleDb) {
    try {
      _moduleDb.close();
    } catch {
      /* already closed */
    }
    _moduleDb = null;
  }
}

// toMs — normalize a timestamp field (epoch-ms number | ISO string | absent)
// to epoch ms or null. Parsing, not a clock read.
function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function shortIdOf(value) {
  try {
    return shortIdFromSessionId(value);
  } catch {
    return value == null ? null : String(value);
  }
}

// defaultReadJobState — parse ~/.claude/jobs/<id>/state.json OURSELVES.
// recovery.mjs's statJob parses only {state, firstTerminalAt}; CTL-932 owns
// that file, so the full-schema parse (tempo/detail/needs/cliVersion/
// timestamps) lives here instead of extending it.
export function defaultReadJobState(bgJobId, { jobsDir = join(homedir(), ".claude", "jobs") } = {}) {
  const file = join(jobsDir, bgJobId, "state.json");
  let st;
  try {
    st = statSync(file);
  } catch {
    return { exists: false }; // job dir gone → exists_flag 0
  }
  let parsed = {};
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size);
      const n = readSync(fd, buf, 0, st.size, 0);
      parsed = JSON.parse(buf.toString("utf8", 0, n)) ?? {};
    } finally {
      closeSync(fd);
    }
  } catch {
    parsed = {}; // unreadable/corrupt → record presence with null fields
  }
  return {
    exists: true,
    state: parsed.state ?? null,
    tempo: parsed.tempo ?? null,
    detail: parsed.detail ?? null,
    needs: parsed.needs ?? null,
    firstTerminalAt: parsed.firstTerminalAt ?? null,
    cliVersion: parsed.cliVersion ?? null,
    createdAtMs: toMs(parsed.createdAt ?? parsed.createdAtMs),
    updatedAtMs: toMs(parsed.updatedAt ?? parsed.updatedAtMs),
    mtimeMs: toMs(st.mtimeMs),
  };
}

// HB_TAIL_CAP_BYTES — hard ceiling on how many event-log bytes a single tick
// may read. Without it, the FIRST tick after enabling the shadow (cursor 0)
// would slurp the entire current-month log — 100MB+ on a busy host — inside
// the tick's transaction (adversarial-review finding, 2026-06-09). When the
// gap exceeds the cap we jump the cursor to the last `capBytes` of the file
// and drop the partial head line; older heartbeats are forfeited, recency is
// what the liveness rules need anyway.
const HB_TAIL_CAP_BYTES = 4 * 1024 * 1024;

// tailHeartbeats — append-only ingest of worker.heartbeat events from the
// unified event log, byte-cursored in cfg ('hb_cursor:<path>') so a row is
// recorded exactly once across ticks AND daemon restarts. Only complete
// (newline-terminated) lines are consumed; a partial trailing line waits for
// the next tick. Throws on real failures (caller's per-source catch records).
//
// EVENT-NAME DISPOSITION (adversarial-review finding 2, 2026-06-09): the spec
// (research/2026-06-09-belief-store-step1-datalog.md §1) prescribes
// `worker.heartbeat` verbatim, but as of 2026-06 NO emitter produces it — the
// live stream's only heartbeat is `session.heartbeat` (catalyst-session.sh),
// which carries no `phase` and a null payload, so it cannot satisfy
// obs_heartbeat's NOT NULL ticket+phase columns. obs_heartbeat therefore
// stays EMPTY until the worker.heartbeat emitter lands (CTL-934+ scope).
// Deliberately spec-conformant rather than mis-ingesting session.heartbeat.
function tailHeartbeats(db, eventLogPath, capBytes = HB_TAIL_CAP_BYTES) {
  let st;
  try {
    st = statSync(eventLogPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return; // no log yet — normal, not an error
    throw err;
  }
  if (!st.isFile()) throw new Error(`event log is not a file: ${eventLogPath}`);

  const cursorKey = `hb_cursor:${eventLogPath}`;
  const row = db.query("SELECT value_int FROM cfg WHERE key = ?").get(cursorKey);
  let offset = row?.value_int ?? 0;
  if (offset > st.size) offset = 0; // rotation/truncation → re-read
  let skipPartialHead = false;
  if (st.size - offset > capBytes) {
    offset = st.size - capBytes; // bounded read: tail-cap (first-enable / big gap)
    skipPartialHead = true; // we landed mid-line — drop bytes up to the first newline
  }
  if (st.size <= offset) return;

  const fd = openSync(eventLogPath, "r");
  let buf;
  let read;
  try {
    buf = Buffer.alloc(st.size - offset);
    read = readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  let start = 0;
  if (skipPartialHead) {
    while (start < read && buf[start] !== 0x0a) start += 1;
    start += 1; // first byte after the newline (== read+1 when none found)
  }
  // Byte-accurate cursor: consume only up to the last newline actually read.
  let end = read - 1;
  while (end >= start && buf[end] !== 0x0a) end -= 1;
  if (end < start) {
    // No complete line in the window. If we capped past a giant head, still
    // advance the cursor so those bytes are never re-read next tick.
    if (skipPartialHead) {
      db.run("INSERT OR REPLACE INTO cfg (key, value_int) VALUES (?, ?)", [
        cursorKey,
        offset + Math.min(start, read),
      ]);
    }
    return;
  }

  const insert = db.prepare(
    "INSERT INTO obs_heartbeat (ticket, phase, generation, host, kind, ts_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const line of buf.toString("utf8", start, end + 1).split("\n")) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // foreign/corrupt line — the log is shared, skip quietly
    }
    if (evt?.attributes?.["event.name"] !== "worker.heartbeat") continue;
    const p = evt?.body?.payload ?? {};
    if (!p.ticket || !p.phase) continue; // ticket+phase are NOT NULL
    const tsMs = typeof p.epoch === "number" ? p.epoch : toMs(evt.ts);
    if (tsMs == null) continue;
    insert.run(
      String(p.ticket),
      String(p.phase),
      p.generation ?? null,
      evt?.resource?.["host.name"] ?? p.host ?? null,
      p.kind ?? null,
      tsMs,
    );
  }
  db.run("INSERT OR REPLACE INTO cfg (key, value_int) VALUES (?, ?)", [cursorKey, offset + end + 1]);
}

// pruneRetention — spec §6 retention, driven entirely by the tick's `now`
// (no clock read). Order matters: belief/intent first (90d), then obs_* (14d),
// then tick rows that are old AND no longer cited by any belief/intent.
function pruneRetention(db, now) {
  const obsCutoff = now - OBS_RETENTION_MS;
  const beliefCutoff = now - BELIEF_RETENTION_MS;
  db.run("DELETE FROM belief WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)", [
    beliefCutoff,
  ]);
  db.run("DELETE FROM intent WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)", [
    beliefCutoff,
  ]);
  for (const t of ["obs_agent", "obs_job", "obs_signal", "obs_transcript", "obs_linear"]) {
    db.run(`DELETE FROM ${t} WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)`, [
      obsCutoff,
    ]);
  }
  db.run("DELETE FROM obs_heartbeat WHERE ts_ms < ?", [obsCutoff]); // own time axis
  db.run(
    `DELETE FROM tick WHERE now_ms < ?
       AND tick_id NOT IN (SELECT tick_id FROM belief)
       AND tick_id NOT IN (SELECT tick_id FROM intent)`,
    [obsCutoff],
  );
}

function getModuleDb(env) {
  if (!_moduleDb) _moduleDb = openBeliefsDb({ env });
  return _moduleDb;
}

// collectTickFacts — the hermetic core. All sources injectable; returns
// { ok, tickId, errors } and NEVER throws.
//
//   ok:true        facts committed (errors[] lists any sources that failed)
//   ok:false       skipped ("disabled") or the tick write itself failed
//
// Sources: getAgents(), readSignals(), readJobState(bgJobId),
// findTranscriptFn(sessionId), eventLogPath, linearCache ({get} or undefined).
export function collectTickFacts({
  orchDir, // reserved: identifies the orchestrator; sources close over it
  db: injectedDb,
  now: nowOpt,
  host: hostOpt,
  env = process.env,
  eventLogPath,
  hbTailCapBytes = HB_TAIL_CAP_BYTES,
  pruneEveryTicks = PRUNE_EVERY_TICKS,
  getAgents,
  readSignals,
  readJobState,
  findTranscriptFn,
  linearCache,
} = {}) {
  // Shadow gate FIRST — disabled must cost nothing (no db open, no clock read).
  if ((env.CATALYST_BELIEFS_SHADOW ?? "0") !== "1") {
    return { ok: false, skipped: "disabled" };
  }

  try {
    // `now` contract: finite number, or omitted → ONE Date.now() read.
    let now;
    if (nowOpt === undefined) now = Date.now();
    else if (typeof nowOpt === "number" && Number.isFinite(nowOpt)) now = nowOpt;
    else throw new Error("collectTickFacts: `now` must be a finite epoch-ms number (spec §2)");

    const db = injectedDb ?? getModuleDb(env);
    const host = hostOpt ?? hostname();
    const errors = [];
    const fail = (source, err) => errors.push({ source, error: String(err?.message ?? err) });

    _tickCount += 1;
    const shouldPrune = (_tickCount - 1) % Math.max(1, pruneEveryTicks) === 0;

    db.run("BEGIN");
    try {
      db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
      const tickId = db.query("SELECT last_insert_rowid() AS id").get().id;

      // ── obs_agent — the agents listing, ALL fields ──────────────────────
      let agents = [];
      try {
        agents = getAgents?.() ?? [];
        const ins = db.prepare(
          `INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, cwd, name, pid, started_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const a of agents) {
          const sid = a?.sessionId ?? a?.session_id;
          if (!sid) continue;
          ins.run(
            tickId,
            String(sid),
            shortIdOf(sid),
            a.kind ?? null,
            a.status ?? null,
            a.state ?? null,
            a.cwd ?? null,
            a.name ?? null,
            a.pid ?? null,
            toMs(a.startedAt ?? a.started_at_ms),
          );
        }
      } catch (err) {
        agents = [];
        fail("agents", err);
      }

      // ── obs_transcript — per listed session, via the resolver ──────────
      // A resolver FAILURE is an error, never the fact "transcript absent".
      const insTr = db.prepare(
        "INSERT INTO obs_transcript (tick_id, session_id, exists_flag, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?)",
      );
      for (const a of agents) {
        const sid = a?.sessionId ?? a?.session_id;
        if (!sid) continue;
        try {
          const path = findTranscriptFn?.(String(sid)) ?? null;
          if (!path) {
            insTr.run(tickId, String(sid), 0, null, null);
          } else {
            const st = statSync(path);
            insTr.run(tickId, String(sid), 1, toMs(st.mtimeMs), st.size);
          }
        } catch (err) {
          fail("transcripts", err);
        }
      }

      // ── obs_signal — worker phase signals ───────────────────────────────
      let signals = [];
      try {
        signals = readSignals?.() ?? [];
        const ins = db.prepare(
          `INSERT INTO obs_signal (tick_id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of signals) {
          if (!s?.ticket || s.phase == null) continue; // ticket+phase NOT NULL
          const bgJobId = s.liveness?.kind === "bg" ? (s.liveness.value ?? null) : null;
          ins.run(
            tickId,
            String(s.ticket),
            String(s.phase),
            s.status ?? null,
            bgJobId,
            s.raw?.generation ?? s.generation ?? null,
            toMs(s.raw?.startedAt ?? s.startedAt),
            toMs(s.updatedAt ?? s.raw?.updatedAt),
          );
        }
      } catch (err) {
        signals = [];
        fail("signals", err);
      }

      // ── obs_job — one row per distinct bg job referenced by a signal ────
      try {
        const ins = db.prepare(
          `INSERT INTO obs_job (tick_id, bg_job_id, state, tempo, detail, needs, first_terminal_at, cli_version, created_at_ms, updated_at_ms, mtime_ms, exists_flag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const seen = new Set();
        for (const s of signals) {
          const bgJobId = s.liveness?.kind === "bg" ? s.liveness.value : null;
          if (!bgJobId || seen.has(bgJobId)) continue;
          seen.add(bgJobId);
          const j = readJobState?.(bgJobId) ?? { exists: false };
          if (!j.exists) {
            ins.run(tickId, String(bgJobId), null, null, null, null, null, null, null, null, null, 0);
          } else {
            ins.run(
              tickId,
              String(bgJobId),
              j.state ?? null,
              j.tempo ?? null,
              j.detail ?? null,
              j.needs ?? null,
              j.firstTerminalAt ?? null,
              j.cliVersion ?? null,
              toMs(j.createdAtMs),
              toMs(j.updatedAtMs),
              toMs(j.mtimeMs),
              1,
            );
          }
        }
      } catch (err) {
        fail("jobs", err);
      }

      // ── obs_heartbeat — cursored event-log tail ─────────────────────────
      try {
        if (eventLogPath) tailHeartbeats(db, eventLogPath, hbTailCapBytes);
      } catch (err) {
        fail("heartbeats", err);
      }

      // ── obs_linear — TTL-cache read-backs; null = unreadable this tick ──
      {
        const ins = db.prepare("INSERT INTO obs_linear (tick_id, ticket, state) VALUES (?, ?, ?)");
        const seen = new Set();
        for (const s of signals) {
          if (!s?.ticket || seen.has(s.ticket)) continue;
          seen.add(s.ticket);
          try {
            let state = null;
            if (linearCache?.get) {
              try {
                state = linearCache.get(s.ticket) ?? null;
              } catch (err) {
                fail("linear", err); // noted; the null-state row still records the read-back attempt
                state = null;
              }
            }
            // ins.run INSIDE the per-source catch: a cache returning a
            // non-bindable value must not escape to the whole-tick rollback
            // (adversarial-review finding 5).
            ins.run(tickId, String(s.ticket), state);
          } catch (err) {
            fail("linear", err);
          }
        }
      }

      // ── derive beliefs (CTL-934) — run all four strata over this tick's
      // facts, INSIDE the same transaction so facts + beliefs land atomically.
      // Pure over the recorded facts (no clock read; recency uses tick.now_ms).
      // A rule-evaluation failure is isolated like any other source: the facts
      // already inserted still commit; only the beliefs are missing this tick.
      let beliefsInserted;
      try {
        beliefsInserted = evaluateBeliefs(db, tickId).inserted;
      } catch (err) {
        fail("rules", err);
      }

      if (shouldPrune) pruneRetention(db, now);

      db.run("COMMIT");
      return { ok: true, tickId, errors, beliefsInserted };
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* connection already unusable */
      }
      throw err;
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// collectBeliefsTick — the daemon-facing wrapper: wires the REAL sources the
// scheduler already touches and logs (never throws). This is the only call
// site in scheduler.mjs (kept to ~2 lines there to avoid conflicting with
// parallel work on the tick loop).
export function collectBeliefsTick({ orchDir, linearCache } = {}) {
  if ((process.env.CATALYST_BELIEFS_SHADOW ?? "0") !== "1") {
    return { ok: false, skipped: "disabled" }; // cheap pre-gate: no wiring work at all
  }
  try {
    const res = collectTickFacts({
      orchDir,
      now: Date.now(), // THE single clock capture for this tick's facts (spec §2)
      host: getHostName(),
      eventLogPath: getEventLogPath(),
      getAgents: () => getAgentsCached().agents, // warm snapshot — never blocks the tick
      // CTL-934: record EVERY per-phase signal (not just the active-phase
      // projection) so the belief rules can join obs_signal(T, P, …) for
      // superseded/terminal sibling phases (orphan-takeover, etc.).
      readSignals: () => readAllPhaseSignals(orchDir),
      readJobState: defaultReadJobState,
      findTranscriptFn: (sid) => findTranscript(sid, defaultProjectsDir()),
      linearCache, // the daemon's TTL cache when threaded; else null-state rows
    });
    if (!res.ok && !res.skipped) {
      log.warn({ err: res.error }, "beliefs: collector tick failed (shadow — tick unaffected)");
    } else if (res.errors?.length) {
      log.warn({ errors: res.errors }, "beliefs: some sources failed this tick (shadow)");
    }
    return res;
  } catch (err) {
    // Belt and braces: collectTickFacts never throws, but the wiring above could.
    try {
      log.warn({ err: err?.message }, "beliefs: collector wrapper threw (shadow — tick unaffected)");
    } catch {
      /* even logging must not break the tick */
    }
    return { ok: false, error: String(err?.message ?? err) };
  }
}
