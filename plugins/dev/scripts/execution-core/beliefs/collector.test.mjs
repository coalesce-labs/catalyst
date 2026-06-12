// collector.test.mjs — CTL-933 belief-store Step 1: the in-daemon fact
// collector. All sources are injected fakes (hermetic — no `claude agents`,
// no real jobs dir, no Linear). The spec §5 CTL-722 fixture is the anchor:
// signal running + agent state=blocked + job tempo=blocked + transcript
// exists=0 must land side by side under one tick row.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { collectTickFacts, __resetBeliefsCollectorForTests } from "./collector.mjs";
import { RULES_SHA } from "./rules.mjs";

const DAY = 86_400_000;
const NOW = 1781030108000; // spec §5 tick: 2026-06-09T18:35:08Z

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl933-collector-"));
  tmps.push(d);
  return d;
}
beforeEach(() => __resetBeliefsCollectorForTests());
afterEach(() => {
  __resetBeliefsCollectorForTests();
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const SID = "5ad5c1ff-1111-2222-3333-444455556666";

// --- spec §5 fixture sources (the CTL-722 wedge, 2026-06-09) ---------------
function wedgeSources() {
  return {
    getAgents: () => [
      {
        sessionId: SID,
        kind: "background",
        status: "idle",
        state: "blocked", // the field the procedural code never read
        cwd: "/work/ctl722",
        name: "worker-CTL-722",
        pid: 4242,
        startedAt: "2026-06-09T08:56:24Z",
      },
    ],
    readSignals: () => [
      {
        ticket: "CTL-722",
        phase: "plan",
        status: "running",
        liveness: { kind: "bg", value: "5ad5c1ff" },
        updatedAt: "2026-06-09T08:56:30Z",
        raw: { generation: 3, startedAt: "2026-06-09T08:56:24Z" },
      },
    ],
    // NOTE (adversarial review): NO assertions inside injected fakes — the
    // collector's per-source try/catch would swallow a failed expect() and the
    // test would pass vacuously. Fakes RECORD (see jobStateCalls below); the
    // test body asserts. Unknown ids get a keyed miss, never a wrong fixture.
    readJobState: (bgJobId) =>
      bgJobId === "5ad5c1ff"
        ? {
            exists: true,
            state: "working",
            tempo: "blocked",
            detail: "stuck on a startup dialog",
            needs: null,
            firstTerminalAt: null,
            cliVersion: "2.1.152",
            createdAtMs: 1780995384000,
            updatedAtMs: 1780995390000,
            mtimeMs: 1780995390000,
          }
        : { exists: false },
    findTranscriptFn: () => null, // f104: transcript never created
  };
}

// `now` CONTRACT (standardized per adversarial review): a FINITE NUMBER of
// epoch-ms, captured ONCE per tick by the caller (spec §2 — `now` is a fact,
// not a function). Never a function. The collector itself reads the clock
// only when `now` is omitted entirely (standalone use), exactly once.
function collect(db, orchDir, overrides = {}) {
  return collectTickFacts({
    orchDir,
    db,
    now: NOW,
    host: "mini",
    env: { CATALYST_BELIEFS_SHADOW: "1" }, // shadow is OPT-IN (default OFF)
    eventLogPath: join(scratch(), "absent.jsonl"),
    linearCache: { get: () => undefined },
    ...wedgeSources(),
    ...overrides,
  });
}

describe("collectTickFacts — spec §5 fixture facts", () => {
  test("writes f101–f104 side by side under one tick row", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // Recording fake — the bg_job_id routing assertion lives HERE in the test
    // body, not inside the fake (per-source try/catch would swallow it there).
    const jobStateCalls = [];
    const baseJobState = wedgeSources().readJobState;
    const res = collect(db, scratch(), {
      readJobState: (bgJobId) => {
        jobStateCalls.push(bgJobId);
        return baseJobState(bgJobId);
      },
    });
    expect(res.ok).toBe(true);
    expect(jobStateCalls).toEqual(["5ad5c1ff"]); // exactly the signal's bg job, once

    const tick = db.query("SELECT * FROM tick").get();
    expect(tick.now_ms).toBe(NOW);
    expect(tick.host).toBe("mini");

    // f101 — obs_signal: CTL-722/plan running, bg_job_id, started 08:56:24Z
    const sig = db.query("SELECT * FROM obs_signal").get();
    expect(sig.tick_id).toBe(tick.tick_id);
    expect(sig.ticket).toBe("CTL-722");
    expect(sig.phase).toBe("plan");
    expect(sig.status).toBe("running");
    expect(sig.bg_job_id).toBe("5ad5c1ff");
    expect(sig.generation).toBe(3);
    expect(sig.started_at_ms).toBe(Date.parse("2026-06-09T08:56:24Z"));
    expect(sig.updated_at_ms).toBe(Date.parse("2026-06-09T08:56:30Z"));

    // f102 — obs_agent: ALL fields including state=blocked
    const agent = db.query("SELECT * FROM obs_agent").get();
    expect(agent.tick_id).toBe(tick.tick_id);
    expect(agent.session_id).toBe(SID);
    expect(agent.short_id).toBe("5ad5c1ff");
    expect(agent.kind).toBe("background");
    expect(agent.status).toBe("idle");
    expect(agent.state).toBe("blocked");
    expect(agent.cwd).toBe("/work/ctl722");
    expect(agent.name).toBe("worker-CTL-722");
    expect(agent.pid).toBe(4242);
    expect(agent.started_at_ms).toBe(Date.parse("2026-06-09T08:56:24Z"));

    // f103 — obs_job: tempo/detail/needs parsed (the 2026-06-09 diagnosis fields)
    const job = db.query("SELECT * FROM obs_job").get();
    expect(job.tick_id).toBe(tick.tick_id);
    expect(job.bg_job_id).toBe("5ad5c1ff");
    expect(job.state).toBe("working");
    expect(job.tempo).toBe("blocked");
    expect(job.detail).toBe("stuck on a startup dialog");
    expect(job.needs).toBe(null);
    expect(job.first_terminal_at).toBe(null);
    expect(job.cli_version).toBe("2.1.152");
    expect(job.exists_flag).toBe(1);

    // f104 — obs_transcript: exists=0 (turn-zero discriminator)
    const tr = db.query("SELECT * FROM obs_transcript").get();
    expect(tr.tick_id).toBe(tick.tick_id);
    expect(tr.session_id).toBe(SID);
    expect(tr.exists_flag).toBe(0);
    expect(tr.mtime_ms).toBe(null);
    db.close();
  });

  test("now contract: a number, captured once by the caller — zero clock reads in the write path (spec §2)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => {
      clockReads += 1;
      return realNow.call(Date);
    };
    try {
      const res = collect(db, scratch(), {
        pruneEveryTicks: 1, // even the prune path must reuse the tick's now
      });
      expect(res.ok).toBe(true);
      expect(clockReads).toBe(0); // caller supplied now → collector NEVER reads the clock
      expect(db.query("SELECT now_ms FROM tick").get().now_ms).toBe(NOW);
    } finally {
      Date.now = realNow;
    }
    db.close();
  });

  test("now contract: omitted → exactly one Date.now() read for the whole tick", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => {
      clockReads += 1;
      return NOW;
    };
    try {
      const res = collect(db, scratch(), { now: undefined, pruneEveryTicks: 1 });
      expect(res.ok).toBe(true);
      expect(clockReads).toBe(1);
      expect(db.query("SELECT now_ms FROM tick").get().now_ms).toBe(NOW);
    } finally {
      Date.now = realNow;
    }
    db.close();
  });

  test("now contract: a function (the old ambiguity) is REJECTED, not silently called", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { now: () => NOW });
    expect(res.ok).toBe(false); // contract violation → collector reports, never throws
    expect(String(res.error)).toMatch(/now/);
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(0);
    db.close();
  });

  test("transcript present → exists=1 with mtime and bytes", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const dir = scratch();
    const transcript = join(dir, `${SID}.jsonl`);
    writeFileSync(transcript, "x".repeat(17));
    const res = collect(db, scratch(), { findTranscriptFn: () => transcript });
    expect(res.ok).toBe(true);
    const tr = db.query("SELECT * FROM obs_transcript").get();
    expect(tr.exists_flag).toBe(1);
    expect(tr.bytes).toBe(17);
    expect(tr.mtime_ms).toBeGreaterThan(0);
    db.close();
  });
});

describe("collectTickFacts — per-phase obs_signal fan-out (CTL-934)", () => {
  // The belief rules join obs_signal(T, P, …) per phase, so the collector must
  // record a row for EVERY workers/<T>/phase-*.json — superseded/terminal
  // siblings included — not just the active-phase projection. Production wires
  // readAllPhaseSignals; here we drive the seam directly.
  test("records one obs_signal row per phase signal, all under one tick; one obs_job per distinct bg job", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const jobStates = {
      aaa1: { exists: true, state: "done", firstTerminalAt: "2026-06-09T01:30:00Z" },
      bbb2: { exists: true, state: "working", tempo: "fast" },
    };
    const res = collect(db, scratch(), {
      readSignals: () => [
        {
          ticket: "CTL-50",
          phase: "research",
          status: "done",
          liveness: { kind: "bg", value: "aaa1" },
          updatedAt: "2026-06-09T01:00:00Z",
          raw: { generation: 1, startedAt: "2026-06-09T00:00:00Z" },
        },
        {
          ticket: "CTL-50",
          phase: "implement",
          status: "running",
          liveness: { kind: "bg", value: "bbb2" },
          updatedAt: "2026-06-09T03:00:00Z",
          raw: { generation: 2, startedAt: "2026-06-09T02:00:00Z" },
        },
      ],
      readJobState: (id) => jobStates[id] ?? { exists: false },
      findTranscriptFn: () => null,
    });
    expect(res.ok).toBe(true);

    const tickIds = db.query("SELECT DISTINCT tick_id FROM obs_signal").all();
    expect(tickIds).toHaveLength(1); // every phase row shares the one tick

    const sigs = db.query("SELECT * FROM obs_signal ORDER BY phase").all();
    expect(sigs.map((s) => s.phase)).toEqual(["implement", "research"]);
    const byPhase = Object.fromEntries(sigs.map((s) => [s.phase, s]));
    expect(byPhase.research.status).toBe("done");
    expect(byPhase.research.bg_job_id).toBe("aaa1");
    expect(byPhase.implement.status).toBe("running");
    expect(byPhase.implement.bg_job_id).toBe("bbb2");

    // obs_job: one per distinct bg job referenced by ANY phase signal — the
    // terminal sibling's job (aaa1) is now observed, which it would not be from
    // the active-phase projection alone.
    const jobs = db.query("SELECT * FROM obs_job ORDER BY bg_job_id").all();
    expect(jobs.map((j) => j.bg_job_id)).toEqual(["aaa1", "bbb2"]);
    expect(jobs.find((j) => j.bg_job_id === "aaa1").first_terminal_at).toBe(
      "2026-06-09T01:30:00Z",
    );

    // obs_linear is still deduped by ticket (one read-back per ticket per tick).
    expect(db.query("SELECT COUNT(*) AS n FROM obs_linear").get().n).toBe(1);
    db.close();
  });
});

describe("collectTickFacts — belief evaluation wired into the tick (CTL-934)", () => {
  // The §5 wedge fixture: collecting the facts must, in the SAME tick/transaction,
  // derive the belief chain (R1 → R4 → R10) — proving rule evaluation runs after
  // fact collection inside the shadow gate.
  test("the wedge fixture derives session_registered → wedged_never_started → wake_diagnostician", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), {
      // age the signal well past never_started_ms relative to NOW
      readSignals: () => [
        {
          ticket: "CTL-722",
          phase: "plan",
          status: "running",
          liveness: { kind: "bg", value: "5ad5c1ff" },
          updatedAt: "2026-06-09T08:56:30Z",
          raw: { generation: 3, startedAt: "2026-06-09T08:56:24Z" },
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.beliefsInserted.R1).toBe(1);
    expect(res.beliefsInserted.R4).toBe(1);

    const tickId = db.query("SELECT tick_id FROM tick").get().tick_id;
    const names = db
      .query("SELECT name FROM belief WHERE tick_id = ? ORDER BY name")
      .all(tickId)
      .map((r) => r.name);
    expect(names).toContain("session_registered");
    expect(names).toContain("wedged_never_started");
    expect(names).toContain("wake_diagnostician");
    expect(names).toContain("free_slots");
    expect(names).not.toContain("turn_started"); // transcript exists=0
    expect(names).not.toContain("worker_dead"); // job state=working

    // beliefs share the facts' tick — same transaction
    const beliefTicks = db.query("SELECT DISTINCT tick_id FROM belief").all();
    expect(beliefTicks).toEqual([{ tick_id: tickId }]);
    db.close();
  });

  test("belief evaluation is gated with the collector — disabled writes neither facts nor beliefs", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { env: {} });
    expect(res.ok).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM belief").get().n).toBe(0);
    db.close();
  });
});

describe("collectTickFacts — source-failure isolation (EVERY source, not just agents)", () => {
  const boom = (what) => () => {
    throw new Error(`${what} exploded`);
  };

  function counts(db) {
    const n = (t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return {
      tick: n("tick"),
      agent: n("obs_agent"),
      signal: n("obs_signal"),
      job: n("obs_job"),
      transcript: n("obs_transcript"),
      heartbeat: n("obs_heartbeat"),
      linear: n("obs_linear"),
    };
  }

  function errorSources(res) {
    return (res.errors ?? []).map((e) => e.source);
  }

  test("getAgents throws → tick survives; signal/job/linear still recorded; error names the source", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { getAgents: boom("claude agents") });
    expect(res.ok).toBe(true); // the tick survived
    const c = counts(db);
    expect(c.tick).toBe(1);
    expect(c.agent).toBe(0);
    // transcripts derive from the agents listing → none; independent sources land
    expect(c.signal).toBe(1);
    expect(c.job).toBe(1);
    expect(c.linear).toBe(1);
    expect(errorSources(res)).toContain("agents");
    db.close();
  });

  test("readSignals throws → agents/transcripts still recorded; signal-derived rows absent", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { readSignals: boom("signal reader") });
    expect(res.ok).toBe(true);
    const c = counts(db);
    expect(c.tick).toBe(1);
    expect(c.signal).toBe(0);
    expect(c.job).toBe(0); // jobs are keyed off signals' bg_job_id
    expect(c.linear).toBe(0); // linear read-backs are keyed off signals' tickets
    expect(c.agent).toBe(1); // independent source landed
    expect(c.transcript).toBe(1); // agents-derived source landed
    expect(errorSources(res)).toContain("signals");
    db.close();
  });

  test("readJobState throws → only obs_job missing; everything else recorded", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { readJobState: boom("job state") });
    expect(res.ok).toBe(true);
    const c = counts(db);
    expect(c).toEqual({ ...c, tick: 1, agent: 1, signal: 1, job: 0, transcript: 1, linear: 1 });
    expect(errorSources(res)).toContain("jobs");
    db.close();
  });

  test("findTranscriptFn throws → only obs_transcript missing (no fabricated exists=0 row)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { findTranscriptFn: boom("transcript resolver") });
    expect(res.ok).toBe(true);
    const c = counts(db);
    // a resolver FAILURE must not be recorded as the fact "transcript absent"
    expect(c).toEqual({ ...c, tick: 1, agent: 1, signal: 1, job: 1, transcript: 0, linear: 1 });
    expect(errorSources(res)).toContain("transcripts");
    db.close();
  });

  test("heartbeat tail fails (event log path is a directory) → other sources recorded", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { eventLogPath: scratch() }); // a dir, not a file
    expect(res.ok).toBe(true);
    const c = counts(db);
    expect(c).toEqual({ ...c, tick: 1, agent: 1, signal: 1, job: 1, transcript: 1, heartbeat: 0, linear: 1 });
    expect(errorSources(res)).toContain("heartbeats");
    db.close();
  });

  test("linearCache.get throws → obs_linear records null state (unreadable this tick); others fine", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { linearCache: { get: boom("linear cache") } });
    expect(res.ok).toBe(true);
    const c = counts(db);
    expect(c).toEqual({ ...c, tick: 1, agent: 1, signal: 1, job: 1, transcript: 1, linear: 1 });
    // schema comment contract: null state = unreadable this tick
    expect(db.query("SELECT state FROM obs_linear").get().state).toBe(null);
    expect(errorSources(res)).toContain("linear");
    db.close();
  });

  test("ALL sources throw at once → the tick row itself still lands", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), {
      getAgents: boom("agents"),
      readSignals: boom("signals"),
      readJobState: boom("jobs"),
      findTranscriptFn: boom("transcripts"),
      eventLogPath: scratch(),
      linearCache: { get: boom("linear") },
    });
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(1);
    expect(errorSources(res)).toEqual(
      expect.arrayContaining(["agents", "signals", "heartbeats"]),
    );
    db.close();
  });

  test("a broken db never throws out of the collector", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    db.close(); // closed handle → every statement throws
    const res = collect(db, scratch());
    expect(res.ok).toBe(false);
  });
});

describe("collectTickFacts — heartbeat tail", () => {
  function hbLine(overrides = {}) {
    return `${JSON.stringify({
      ts: "2026-06-09T18:30:00Z",
      attributes: { "event.name": "worker.heartbeat" },
      resource: { "host.name": "mini" },
      body: {
        payload: {
          ticket: "CTL-722",
          phase: "plan",
          generation: 3,
          kind: "commit",
          epoch: 1781029800000,
          ...overrides,
        },
      },
    })}\n`;
  }

  test("ingests worker.heartbeat events; cursor prevents duplicates", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const log = join(scratch(), "2026-06.jsonl");
    writeFileSync(
      log,
      `${JSON.stringify({ attributes: { "event.name": "node.heartbeat" } })}\n${hbLine()}`,
    );
    const orchDir = scratch();
    collect(db, orchDir, { eventLogPath: log });
    let rows = db.query("SELECT * FROM obs_heartbeat").all();
    expect(rows.length).toBe(1);
    expect(rows[0].ticket).toBe("CTL-722");
    expect(rows[0].phase).toBe("plan");
    expect(rows[0].generation).toBe(3);
    expect(rows[0].host).toBe("mini");
    expect(rows[0].kind).toBe("commit");
    expect(rows[0].ts_ms).toBe(1781029800000);

    // second tick, no new bytes → no duplicate
    collect(db, orchDir, { eventLogPath: log });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_heartbeat").get().n).toBe(1);

    // appended event → exactly one new row
    appendFileSync(log, hbLine({ kind: "test", epoch: 1781029860000 }));
    collect(db, orchDir, { eventLogPath: log });
    rows = db.query("SELECT * FROM obs_heartbeat ORDER BY ts_ms").all();
    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe("test");
    db.close();
  });

  // Adversarial-review finding 1: cursor 0 on a pre-existing fat log (100MB+
  // in production) must NOT slurp the whole file inside the tick transaction.
  test("first-enable on a fat log is tail-capped: bounded read, partial head dropped, cursor lands at EOF", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const log = join(scratch(), "2026-06.jsonl");
    // 3 heartbeat lines; cap sized so only the LAST line (plus a partial head
    // of the middle one) fits in the window → exactly 1 row ingested.
    const l1 = hbLine({ kind: "old-1", epoch: 1781029700000 });
    const l2 = hbLine({ kind: "old-2", epoch: 1781029750000 });
    const l3 = hbLine({ kind: "recent", epoch: 1781029800000 });
    writeFileSync(log, l1 + l2 + l3);
    const cap = Buffer.byteLength(l3) + 10; // window covers l3 + a torn tail of l2
    const orchDir = scratch();
    const res = collect(db, orchDir, { eventLogPath: log, hbTailCapBytes: cap });
    expect(res.ok).toBe(true);
    expect((res.errors ?? []).map((e) => e.source)).not.toContain("heartbeats");
    const rows = db.query("SELECT * FROM obs_heartbeat").all();
    expect(rows.length).toBe(1); // torn l2 head dropped, only complete l3 ingested
    expect(rows[0].kind).toBe("recent");
    // cursor is at EOF: a re-tick ingests nothing, an append ingests exactly it
    collect(db, orchDir, { eventLogPath: log, hbTailCapBytes: cap });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_heartbeat").get().n).toBe(1);
    appendFileSync(log, hbLine({ kind: "new", epoch: 1781029860000 }));
    collect(db, orchDir, { eventLogPath: log, hbTailCapBytes: cap });
    const after = db.query("SELECT kind FROM obs_heartbeat ORDER BY ts_ms").all();
    expect(after.map((r) => r.kind)).toEqual(["recent", "new"]);
    db.close();
  });

  test("capped window with NO complete line still advances the cursor past the torn head", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const log = join(scratch(), "2026-06.jsonl");
    // One long line, NOT newline-terminated, longer than the cap: the capped
    // window contains no newline at all. The cursor must still advance so the
    // blob is never re-read every tick.
    const giant = JSON.stringify({
      attributes: { "event.name": "worker.heartbeat" },
      body: { payload: { ticket: "CTL-1", phase: "plan", epoch: 1, pad: "x".repeat(4000) } },
    });
    writeFileSync(log, giant); // no trailing \n
    const orchDir = scratch();
    collect(db, orchDir, { eventLogPath: log, hbTailCapBytes: 256 });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_heartbeat").get().n).toBe(0);
    const cur = db
      .query("SELECT value_int FROM cfg WHERE key = ?")
      .get(`hb_cursor:${log}`);
    expect(cur.value_int).toBe(Buffer.byteLength(giant)); // skipped, never re-read
    // a real, complete line appended after the blob is picked up next tick
    appendFileSync(log, `\n${hbLine({ kind: "post-blob", epoch: 1781029900000 })}`);
    collect(db, orchDir, { eventLogPath: log, hbTailCapBytes: 1024 });
    const rows = db.query("SELECT kind FROM obs_heartbeat").all();
    expect(rows.map((r) => r.kind)).toEqual(["post-blob"]);
    db.close();
  });

  // Adversarial-review finding 5: a cache handing back a non-bindable value
  // (object, not string) must be contained by the per-source catch — the rest
  // of the tick still commits.
  test("linearCache.get returns a non-bindable object → linear error recorded, tick survives", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), {
      linearCache: { get: () => ({ state: "Plan" }) }, // misshaped: object, not string
    });
    expect(res.ok).toBe(true); // whole tick NOT rolled back
    expect((res.errors ?? []).map((e) => e.source)).toContain("linear");
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_agent").get().n).toBe(1);
    db.close();
  });
});

describe("collectTickFacts — Linear read-backs", () => {
  test("TTL-cache hit records the state; miss records null", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    collect(db, scratch(), {
      linearCache: { get: (t) => (t === "CTL-722" ? "Plan" : undefined) },
    });
    const row = db.query("SELECT * FROM obs_linear").get();
    expect(row.ticket).toBe("CTL-722");
    expect(row.state).toBe("Plan");
    db.close();

    const db2 = openBeliefsDb({ path: join(scratch(), "b2.db") });
    collect(db2, scratch(), { linearCache: { get: () => undefined } });
    expect(db2.query("SELECT state FROM obs_linear").get().state).toBe(null);
    db2.close();
  });

  test("no cache wired → null state row, still one per ticket", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    collect(db, scratch(), { linearCache: undefined });
    const rows = db.query("SELECT * FROM obs_linear").all();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe(null);
    db.close();
  });
});

describe("collectTickFacts — retention", () => {
  test("prunes obs_*/tick at 14d, belief/intent at 90d; provenance ticks survive", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });

    // tick A (100d old) with a belief → belief past 90d: both pruned.
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (1, ?, 'h')", [NOW - 100 * DAY]);
    db.run(
      "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 1, 'x', 's', 'R1', '[]')",
    );
    db.run("INSERT INTO intent (tick_id, kind, subject) VALUES (1, 'kill', 's')");
    // tick B (15d old) with an obs row, no beliefs → obs + tick pruned at 14d.
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (2, ?, 'h')", [NOW - 15 * DAY]);
    db.run(
      "INSERT INTO obs_agent (tick_id, session_id, short_id) VALUES (2, 'sid-b', 'sid-b')",
    );
    // tick C (30d old) with a belief INSIDE the 90d window → belief kept, and
    // its tick row survives the 14d prune as the belief's provenance time-spine.
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (3, ?, 'h')", [NOW - 30 * DAY]);
    db.run(
      "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (3, 1, 'y', 's', 'R1', '[]')",
    );
    // heartbeats are pruned by their own ts_ms (no tick_id column).
    db.run(
      "INSERT INTO obs_heartbeat (ticket, phase, ts_ms) VALUES ('CTL-1', 'plan', ?)",
      [NOW - 15 * DAY],
    );
    db.run(
      "INSERT INTO obs_heartbeat (ticket, phase, ts_ms) VALUES ('CTL-2', 'plan', ?)",
      [NOW - 1 * DAY],
    );

    const res = collect(db, scratch(), { pruneEveryTicks: 1 });
    expect(res.ok).toBe(true);

    const tickIds = db.query("SELECT tick_id FROM tick ORDER BY tick_id").all().map((r) => r.tick_id);
    expect(tickIds).not.toContain(1); // 100d-old tick gone with its belief
    expect(tickIds).not.toContain(2); // 15d-old unreferenced tick gone
    expect(tickIds).toContain(3); // 30d-old tick survives as belief provenance
    expect(db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id=1").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM intent").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id=3").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_agent WHERE tick_id=2").get().n).toBe(0);
    const hb = db.query("SELECT ticket FROM obs_heartbeat").all().map((r) => r.ticket);
    expect(hb).toEqual(["CTL-2"]);
    db.close();
  });

  test("prune runs once per N ticks, not every tick", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (999, ?, 'h')", [NOW - 15 * DAY]);
    const orchDir = scratch();
    collect(db, orchDir, { pruneEveryTicks: 3 }); // tick 1 → prunes (boot prune)
    db.run("INSERT INTO tick (tick_id, now_ms, host) VALUES (998, ?, 'h')", [NOW - 15 * DAY]);
    collect(db, orchDir, { pruneEveryTicks: 3 }); // tick 2 → no prune
    expect(db.query("SELECT COUNT(*) AS n FROM tick WHERE tick_id=998").get().n).toBe(1);
    collect(db, orchDir, { pruneEveryTicks: 3 }); // tick 3 → no prune
    expect(db.query("SELECT COUNT(*) AS n FROM tick WHERE tick_id=998").get().n).toBe(1);
    collect(db, orchDir, { pruneEveryTicks: 3 }); // tick 4 → prunes
    expect(db.query("SELECT COUNT(*) AS n FROM tick WHERE tick_id=998").get().n).toBe(0);
    db.close();
  });
});

describe("collectTickFacts — shadow gate (OPT-IN, default OFF) + db path", () => {
  // Adversarial-review decision: this is a NEW synchronous write on the hot
  // scheduler tick, so shadow mode is opt-in (CATALYST_BELIEFS_SHADOW=1), not
  // default-on as spec §6 sketched. Deviation recorded in the PR body.
  test("default (env unset) is OFF — no db writes at all", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { env: {} });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("disabled");
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(0);
    db.close();
  });

  test("CATALYST_BELIEFS_SHADOW=0 keeps it disabled", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { env: { CATALYST_BELIEFS_SHADOW: "0" } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("disabled");
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(0);
    db.close();
  });

  test("CATALYST_BELIEFS_SHADOW=1 enables the collector", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { env: { CATALYST_BELIEFS_SHADOW: "1" } });
    expect(res.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM tick").get().n).toBe(1);
    db.close();
  });

  test("no injected db → opens the CATALYST_BELIEFS_DB override path", () => {
    const target = join(scratch(), "override-beliefs.db");
    const res = collectTickFacts({
      orchDir: scratch(),
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_DB: target, CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      linearCache: { get: () => undefined },
      ...wedgeSources(),
    });
    expect(res.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe("collectTickFacts — CTL-1063 Phase 4: rules_sha stamping + boot event", () => {
  test("tick row is stamped with RULES_SHA after collectTickFacts", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch());
    expect(res.ok).toBe(true);
    const row = db.query("SELECT rules_sha FROM tick WHERE tick_id = ?").get(res.tickId);
    expect(row.rules_sha).toBe(RULES_SHA);
    db.close();
  });

  test("when rules_sha_last_seen is absent, appendEvent receives rules.version.changed with old_sha=null and new_sha=RULES_SHA", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const events = [];
    const appendEvent = (e) => events.push(e);
    const res = collect(db, scratch(), { appendEvent });
    expect(res.ok).toBe(true);
    const evt = events.find((e) => e["event.name"] === "rules.version.changed");
    expect(evt).toBeTruthy();
    expect(evt.payload.old_sha).toBe(null);
    expect(evt.payload.new_sha).toBe(RULES_SHA);
    db.close();
  });

  test("when rules_sha_last_seen differs from current RULES_SHA, appendEvent fires rules.version.changed", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // Pre-seed a stale sha
    db.run(
      "INSERT OR REPLACE INTO cfg (key, value_text) VALUES ('rules_sha_last_seen', 'deadbeef00000000')",
    );
    const events = [];
    const appendEvent = (e) => events.push(e);
    const res = collect(db, scratch(), { appendEvent });
    expect(res.ok).toBe(true);
    const evt = events.find((e) => e["event.name"] === "rules.version.changed");
    expect(evt).toBeTruthy();
    expect(evt.payload.old_sha).toBe("deadbeef00000000");
    expect(evt.payload.new_sha).toBe(RULES_SHA);
    db.close();
  });

  test("when rules_sha_last_seen equals RULES_SHA, no rules.version.changed event fires", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // Pre-seed the CURRENT sha
    db.run(
      "INSERT OR REPLACE INTO cfg (key, value_text) VALUES ('rules_sha_last_seen', ?)",
      [RULES_SHA],
    );
    const events = [];
    const appendEvent = (e) => events.push(e);
    const res = collect(db, scratch(), { appendEvent });
    expect(res.ok).toBe(true);
    const evt = events.find((e) => e["event.name"] === "rules.version.changed");
    expect(evt).toBeUndefined();
    db.close();
  });

  test("after first emit, cfg.rules_sha_last_seen equals RULES_SHA", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const res = collect(db, scratch(), { appendEvent: () => {} });
    expect(res.ok).toBe(true);
    const row = db
      .query("SELECT value_text FROM cfg WHERE key = 'rules_sha_last_seen'")
      .get();
    expect(row?.value_text).toBe(RULES_SHA);
    db.close();
  });

  test("boot event fires AT MOST ONCE per process — second tick does not re-fire even after reset is NOT called", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const events = [];
    const appendEvent = (e) => events.push(e);
    // Tick 1 — _rulesVersionChecked was reset by beforeEach; event fires
    const orchDir = scratch();
    collect(db, orchDir, { appendEvent });
    const after1 = events.filter((e) => e["event.name"] === "rules.version.changed").length;
    expect(after1).toBe(1);
    // Tick 2 — same module state (_rulesVersionChecked=true); must NOT fire again
    collect(db, orchDir, { appendEvent });
    const after2 = events.filter((e) => e["event.name"] === "rules.version.changed").length;
    expect(after2).toBe(1); // still 1 — no new event on tick 2
    db.close();
  });
});
