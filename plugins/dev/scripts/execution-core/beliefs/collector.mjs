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
import { evaluateBeliefs, RULES_SHA } from "./rules.mjs";
import { reconcileIntents, getMaxAttempts } from "./intent.mjs";
import { shortIdFromSessionId } from "../claude-ids.mjs";
import { getAgentsCached } from "../claude-agents.mjs";
import { readAllPhaseSignals } from "../signal-reader.mjs";
import { findTranscript, defaultProjectsDir } from "../session-recency.mjs";
import { getEventLogPath, getHostName, log } from "../config.mjs";
// CTL-966: the SAME procedural readers the scheduler's deriveAdvancement reads,
// captured as facts (obs_verdict / obs_cycle) so the advance_to belief can mirror
// the oracle with zero new I/O semantics — derive-only, no actuation.
import { readVerifyVerdict } from "../work-done-probes.mjs";
import { countRemediateCycles } from "../event-scan.mjs";

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
// CTL-1063 Phase 4: rules.version.changed fires AT MOST ONCE per process (per
// module load). The flag is reset by __resetBeliefsCollectorForTests so tests
// can observe the event from a fresh process state.
let _rulesVersionChecked = false;

export function __resetBeliefsCollectorForTests() {
  _tickCount = 0;
  _rulesVersionChecked = false;
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
export function defaultReadJobState(
  bgJobId,
  { jobsDir = join(homedir(), ".claude", "jobs") } = {}
) {
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
    "INSERT INTO obs_heartbeat (ticket, phase, generation, host, kind, ts_ms) VALUES (?, ?, ?, ?, ?, ?)"
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
      tsMs
    );
  }
  db.run("INSERT OR REPLACE INTO cfg (key, value_int) VALUES (?, ?)", [
    cursorKey,
    offset + end + 1,
  ]);
}

// pruneRetention — spec §6 retention, driven entirely by the tick's `now`
// (no clock read). Order matters: belief/intent/shadow_comparison first (90d),
// then obs_* (14d), then tick rows that are old AND no longer cited by any
// belief/intent/shadow_comparison.
function pruneRetention(db, now) {
  const obsCutoff = now - OBS_RETENTION_MS;
  const beliefCutoff = now - BELIEF_RETENTION_MS;
  db.run("DELETE FROM belief WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)", [
    beliefCutoff,
  ]);
  db.run("DELETE FROM intent WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)", [
    beliefCutoff,
  ]);
  // CTL-935: shadow_comparison is pruned at the 90d belief window (same as
  // belief/intent) so 7-day reports always have full data — NOT the 14d obs window.
  db.run(
    "DELETE FROM shadow_comparison WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)",
    [beliefCutoff]
  );
  for (const t of [
    "obs_agent",
    "obs_job",
    "obs_signal",
    "obs_transcript",
    "obs_linear",
    "obs_relation",
    "obs_verdict",
    "obs_cycle",
  ]) {
    db.run(`DELETE FROM ${t} WHERE tick_id IN (SELECT tick_id FROM tick WHERE now_ms < ?)`, [
      obsCutoff,
    ]);
  }
  db.run("DELETE FROM obs_heartbeat WHERE ts_ms < ?", [obsCutoff]); // own time axis
  // CTL-935 (phase-review remediation): retain a tick cited by any surviving
  // shadow_comparison row as that row's provenance time-spine — mirroring the
  // belief/intent guards. Without this third guard, a quiet tick that wrote a
  // shadow_comparison row but no belief/intent (e.g. the free-slots agree row,
  // which is written every shadow tick even when the R8 belief did not fire) is
  // deleted at the 14d obs window while its shadow_comparison row survives to
  // 90d, orphaning it. report.mjs INNER-JOINs shadow_comparison to tick, so an
  // orphaned row silently drops and disagreements aged 14–90d under-count —
  // biasing the very agreement rates the gate-flip decision reads. Because
  // shadow_comparison is itself pruned at the 90d belief window above, the tick
  // is still reclaimed on the next prune once its rows age out.
  db.run(
    `DELETE FROM tick WHERE now_ms < ?
       AND tick_id NOT IN (SELECT tick_id FROM belief)
       AND tick_id NOT IN (SELECT tick_id FROM intent)
       AND tick_id NOT IN (SELECT tick_id FROM shadow_comparison)`,
    [obsCutoff]
  );
}

function getModuleDb(env) {
  if (!_moduleDb) _moduleDb = openBeliefsDb({ env });
  return _moduleDb;
}

// getBeliefsDb — expose the shared module-level db handle so adjacent modules
// (e.g. diagnostician.mjs CTL-937) can read beliefs without opening a second
// connection. Returns null when the collector has never been initialised
// (CATALYST_BELIEFS_SHADOW=0 path — the diagnostician gates on its own flag
// and should skip when this returns null).
export function getBeliefsDb() {
  return _moduleDb;
}

// getEscalateHumanBelief — CTL-1241: read-only helper that returns the latest
// escalate_human belief for a ticket from the current-tick beliefs.db.
//
// Query: most-recent (ORDER BY tick_id DESC LIMIT 1) row whose
//   name = 'escalate_human' AND subject LIKE '<ticket>/%'
// The '/' boundary ensures 'CTL-1241/x' matches 'CTL-1241' but 'CTL-12410/x'
// does NOT.
//
// Returns { escalate_human: true, why, subject, tickId } or null.
// Never throws — fail-open so a beliefs-disabled or broken daemon is a no-op.
export function getEscalateHumanBelief(db, ticket) {
  if (!db) return null;
  try {
    const row = db
      .query(
        `SELECT subject, value, tick_id FROM belief
         WHERE name = 'escalate_human' AND subject LIKE ?
         ORDER BY tick_id DESC LIMIT 1`
      )
      .get(`${ticket}/%`);
    if (!row) return null;
    let why = null;
    try {
      why = JSON.parse(row.value ?? "{}").why ?? null;
    } catch {
      // malformed JSON → why stays null; still return the belief
    }
    return { escalate_human: true, why, subject: row.subject, tickId: row.tick_id };
  } catch {
    return null; // db closed or query error → fail-open
  }
}

// collectTickFacts — the hermetic core. All sources injectable; returns
// { ok, tickId, errors } and NEVER throws.
//
//   ok:true        facts committed (errors[] lists any sources that failed)
//   ok:false       skipped ("disabled") or the tick write itself failed
//
// Sources: getAgents(), readSignals(), readJobState(bgJobId),
// findTranscriptFn(sessionId), eventLogPath, linearCache ({get} or undefined).
//
// CTL-936 additions:
//   intentsEnforce  — when true, reconcileIntents emits operator events and
//                     suppresses ineffective channels. Default false (shadow).
//   appendIntentEvent — the operator-event seam for intent.ineffective events.
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
  // CTL-936: intent reconciliation
  appendIntentEvent = null,
  // CTL-1063 Phase 4: operator-event seam for rules.version.changed boot event.
  appendEvent = null,
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
      // CTL-1063 Phase 4: stamp rules_sha on every tick row so disagreements can
      // be correlated to the rules version that was active when the tick ran.
      db.run("INSERT INTO tick (now_ms, host, rules_sha) VALUES (?, ?, ?)", [now, host, RULES_SHA]);
      const tickId = db.query("SELECT last_insert_rowid() AS id").get().id;

      // CTL-1063 Phase 4: emit rules.version.changed once per process when the
      // rules sha differs from the last-seen value persisted in cfg.
      if (!_rulesVersionChecked) {
        _rulesVersionChecked = true;
        try {
          const lastSha =
            db.query("SELECT value_text FROM cfg WHERE key = 'rules_sha_last_seen'").get()
              ?.value_text ?? null;
          // CTL-1063 remediate (verify silent-failure collector.mjs:374):
          // couple the last-seen cursor advance to a WIRED appender. When
          // appendEvent is null (pre-wiring boot path, or a unit test that
          // omits it) the cursor must NOT advance — otherwise the one-shot
          // rules.version.changed signal is silently consumed before any
          // observer exists and never fires again. Only once the appender is
          // threaded (collectBeliefsTick → scheduler) does the event emit AND
          // the cursor advance, together.
          if (lastSha !== RULES_SHA && typeof appendEvent === "function") {
            try {
              appendEvent({
                "event.name": "rules.version.changed",
                payload: { old_sha: lastSha, new_sha: RULES_SHA },
              });
            } catch {
              /* operator-event append is best-effort */
            }
            db.run(
              "INSERT OR REPLACE INTO cfg (key, value_text) VALUES ('rules_sha_last_seen', ?)",
              [RULES_SHA]
            );
          }
        } catch {
          /* best-effort — version check must never break the tick */
        }
      }

      // ── obs_agent — the agents listing, ALL fields ──────────────────────
      let agents = [];
      try {
        agents = getAgents?.() ?? [];
        const ins = db.prepare(
          `INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, cwd, name, pid, started_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            toMs(a.startedAt ?? a.started_at_ms)
          );
        }
      } catch (err) {
        agents = [];
        fail("agents", err);
      }

      // ── obs_transcript — per listed session, via the resolver ──────────
      // A resolver FAILURE is an error, never the fact "transcript absent".
      const insTr = db.prepare(
        "INSERT INTO obs_transcript (tick_id, session_id, exists_flag, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?)"
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
            toMs(s.updatedAt ?? s.raw?.updatedAt)
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const seen = new Set();
        for (const s of signals) {
          const bgJobId = s.liveness?.kind === "bg" ? s.liveness.value : null;
          if (!bgJobId || seen.has(bgJobId)) continue;
          seen.add(bgJobId);
          const j = readJobState?.(bgJobId) ?? { exists: false };
          if (!j.exists) {
            ins.run(
              tickId,
              String(bgJobId),
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              0
            );
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
              1
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

      // ── obs_relation — blocking edges from the TTL cache; insert-only ────
      // collectBeliefsTick runs BEFORE schedulerTick refreshes the Linear cache
      // this tick, so relations reflect the previous tick's fetch (within the
      // 60s TTL) and are cold on the very first tick — acceptable, same
      // staleness contract as obs_linear. Cold/stale cache (getRelations returns
      // undefined) → no rows this tick; the null-is-unreadable contract applies.
      //
      // Normalization MATCHES lib/dependency-graph.mjs buildDependencyEdges:
      //   relations.nodes type='blocks'      → (source=ticket, target=peer, 'blocks')
      //   relations.nodes type='blocked_by'  → (source=peer,   target=ticket,'blocks')
      //   relations.nodes type='related'/'duplicate' → (source=ticket, target=peer, type)
      //   inverseRelations.nodes type='blocks'     → (source=peer,   target=ticket,'blocks')
      //   inverseRelations.nodes type='blocked_by' → (source=ticket, target=peer, 'blocks')
      // 'blocked_by' is never stored as a relation_type — always folded into
      // 'blocks' by swapping direction. Nodes with missing peer identifier are
      // skipped. seenRel deduplicates tickets so each ticket's relations are read
      // exactly once per tick. seenEdge deduplicates at the edge level: because
      // relations.nodes and inverseRelations.nodes both surface the same logical
      // edge (symmetric view), the same (src, tgt, type) triple can be produced
      // twice in one tick — seenEdge prevents inserting duplicates within the tick
      // while still re-inserting on subsequent ticks (insert-only-per-tick preserved).
      {
        const insRel = db.prepare(
          "INSERT INTO obs_relation (tick_id, source_ticket, target_ticket, relation_type) VALUES (?, ?, ?, ?)"
        );
        const seenRel = new Set();
        const seenEdge = new Set();
        for (const s of signals) {
          if (!s?.ticket || seenRel.has(s.ticket)) continue;
          seenRel.add(s.ticket);
          try {
            const descriptor = linearCache?.getRelations?.(s.ticket);
            if (descriptor == null) continue; // cold/stale cache → no rows this tick
            const addEdge = (src, tgt, type) => {
              if (!src || !tgt) return; // malformed node — missing peer identifier
              const edgeKey = `${src}\t${tgt}\t${type}`;
              if (seenEdge.has(edgeKey)) return; // within-tick symmetric duplicate
              seenEdge.add(edgeKey);
              insRel.run(tickId, String(src), String(tgt), String(type));
            };
            for (const node of descriptor?.relations?.nodes ?? []) {
              const peer = node?.relatedIssue?.identifier;
              if (!peer) continue;
              if (node.type === "blocks") addEdge(s.ticket, peer, "blocks");
              else if (node.type === "blocked_by") addEdge(peer, s.ticket, "blocks");
              else if (node.type === "related" || node.type === "duplicate")
                addEdge(s.ticket, peer, node.type);
            }
            for (const node of descriptor?.inverseRelations?.nodes ?? []) {
              const peer = node?.issue?.identifier;
              if (!peer) continue;
              if (node.type === "blocks") addEdge(peer, s.ticket, "blocks");
              else if (node.type === "blocked_by") addEdge(s.ticket, peer, "blocks");
            }
          } catch (err) {
            fail("relations", err);
          }
        }
      }

      // ── obs_verdict — the verify verdict per in-flight ticket (CTL-966) ──
      // Parsed from workers/<T>/verify.json by the SAME readVerifyVerdict the
      // scheduler's deriveAdvancement consumes. null/absent verdict → NO ROW
      // (the absent-is-distinct-from-pass contract is preserved: a missing row
      // means the advance_to rule sees no verdict and falls through to the
      // normal verify → review edge, exactly as the oracle does). One row per
      // distinct ticket. Per-source try/catch; orchDir absent → skipped.
      try {
        if (orchDir) {
          const insV = db.prepare(
            "INSERT INTO obs_verdict (tick_id, ticket, verdict) VALUES (?, ?, ?)"
          );
          const seenV = new Set();
          for (const s of signals) {
            if (!s?.ticket || seenV.has(s.ticket)) continue;
            seenV.add(s.ticket);
            const verdict = readVerifyVerdict({ ticket: s.ticket, orchDir });
            if (verdict == null) continue; // null/absent → no row (oracle contract)
            insV.run(tickId, String(s.ticket), String(verdict));
          }
        }
      } catch (err) {
        fail("verdict", err);
      }

      // ── obs_cycle — the event-counted remediate-cycle count (CTL-966) ────
      // Captured via the SAME countRemediateCycles the scheduler's router uses
      // (phase.remediate.complete.<ticket> envelopes off the unified event log).
      // Rides the event-scan module's incremental cursor — no new disk scan
      // beyond the heartbeat tail the collector already drives. One row per
      // distinct ticket; a never-remediated ticket records remediate_count=0 so
      // the cap-boundary comparison (count < cap) is exact. eventLogPath absent
      // → countRemediateCycles falls back to getEventLogPath() (same default the
      // scheduler uses). Per-source try/catch.
      try {
        const insC = db.prepare(
          "INSERT INTO obs_cycle (tick_id, ticket, remediate_count) VALUES (?, ?, ?)"
        );
        const seenC = new Set();
        for (const s of signals) {
          if (!s?.ticket || seenC.has(s.ticket)) continue;
          seenC.add(s.ticket);
          const count = eventLogPath
            ? countRemediateCycles({ ticket: s.ticket, path: eventLogPath })
            : countRemediateCycles({ ticket: s.ticket });
          insC.run(tickId, String(s.ticket), Number.isInteger(count) ? count : 0);
        }
      } catch (err) {
        fail("cycle", err);
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

      // ── CTL-936: reconcile open intents against the world ─────────────────
      // Runs AFTER evaluateBeliefs so R11 (action_ineffective) has already been
      // derived from the PREVIOUS tick's open intents. This tick's reconciliation
      // marks intents satisfied/ineffective so the NEXT tick's R11 sees them.
      // Failure is isolated (shadow contract — never breaks the tick).
      let intentResult;
      try {
        // Build a worldSnapshot from the data already collected this tick.
        // agentsBySubject: ticket/phase → agent entry (or absent → session gone)
        const agentsBySubject = (() => {
          // Build a short_id → agent map from this tick's obs_agent rows.
          const agentByShortId = new Map();
          for (const a of agents) {
            const sid = a?.sessionId ?? a?.session_id;
            if (!sid) continue;
            agentByShortId.set(shortIdOf(sid), {
              session_id: String(sid),
              short_id: shortIdOf(sid),
            });
          }
          // Map each signal's (ticket/phase) → its registered agent entry (or null).
          const m = new Map();
          for (const s of signals) {
            if (!s?.ticket || s.phase == null) continue;
            const bgJobId = s.liveness?.kind === "bg" ? s.liveness.value : null;
            if (!bgJobId) continue;
            const key = `${s.ticket}/${s.phase}`;
            const agent = agentByShortId.get(bgJobId) ?? null;
            if (agent) m.set(key, agent); // present → registered
            // absent from map → key not in m → postcondition "session gone" satisfied
          }
          return m;
        })();

        // linearStateByTicket: ticket → Linear state string (or null)
        const linearStateByTicket = (() => {
          const m = new Map();
          for (const s of signals) {
            if (!s?.ticket || m.has(s.ticket)) continue;
            let state = null;
            if (linearCache?.get) {
              try {
                state = linearCache.get(s.ticket) ?? null;
              } catch {
                state = null;
              }
            }
            m.set(s.ticket, state);
          }
          return m;
        })();

        // signalStatusBySubject: "ticket/phase" → status string, for the
        // unstuck-sweep postcondition (CTL-1064). Built from the SAME signals
        // already in scope — zero extra I/O. Key: only stalled/failed entries
        // matter; everything else returns null → intent retries next tick.
        const signalStatusBySubject = (() => {
          const m = new Map();
          for (const s of signals) {
            if (!s?.ticket || s.phase == null) continue;
            m.set(`${s.ticket}/${s.phase}`, s.status ?? null);
          }
          return m;
        })();

        const maxAttempts = getMaxAttempts(db);
        const intentsEnforce = (env.CATALYST_INTENTS_ENFORCE ?? "0") === "1";
        intentResult = reconcileIntents(
          db,
          tickId,
          { agentsBySubject, linearStateByTicket, signalStatusBySubject },
          {
            maxAttempts,
            enforce: intentsEnforce,
            appendEvent: typeof appendIntentEvent === "function" ? appendIntentEvent : null,
            now,
          }
        );
      } catch (err) {
        fail("intents", err);
      }

      if (shouldPrune) pruneRetention(db, now);

      db.run("COMMIT");
      return { ok: true, tickId, errors, beliefsInserted, intentResult };
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
export function collectBeliefsTick({
  orchDir,
  linearCache,
  appendIntentEvent = null,
  appendEvent = null,
} = {}) {
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
      // CTL-936: operator-event seam for intent.ineffective — threaded from
      // runTick when CATALYST_INTENTS_ENFORCE=1. Null → legacy shadow-only.
      appendIntentEvent: typeof appendIntentEvent === "function" ? appendIntentEvent : null,
      // CTL-1063 remediate (verify high review collector.mjs:734): thread the
      // operator-event appender so the one-shot rules.version.changed signal
      // can actually fire in the live daemon. Mirrors appendIntentEvent —
      // without this the emit (gated on `typeof appendEvent === 'function'`)
      // was dead in production because the wrapper never forwarded it.
      appendEvent: typeof appendEvent === "function" ? appendEvent : null,
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
      log.warn(
        { err: err?.message },
        "beliefs: collector wrapper threw (shadow — tick unaffected)"
      );
    } catch {
      /* even logging must not break the tick */
    }
    return { ok: false, error: String(err?.message ?? err) };
  }
}
