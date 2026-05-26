// sessions.test.mjs — Phase 5 of CTL-649. Unit tests for the operator-facing
// `catalyst-execution-core sessions {list,show,prune}` audit CLI.
//
// The classifier and RSS-attribution are pure functions (no I/O). buildRows
// and runPrune accept injected dependencies so the suite never shells out to
// `claude` / `ps` / the event log.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  classifyRow,
  applyDuplicates,
  parsePsSnapshot,
  rssTotalForPid,
  parseSessionName,
  buildRows,
  buildLiveSessionsByWorktree,
  runPrune,
  parseArgs,
} from "./sessions.mjs";

describe("classifyRow (priority chain DONE → ORPHAN → IDLE → UNKNOWN → KEEP)", () => {
  it("DONE wins over ORPHAN, IDLE, KEEP", () => {
    expect(
      classifyRow({ worker: { status: "done" }, cwdExists: false, session: { status: "idle" } })
    ).toBe("DONE");
  });

  it("ORPHAN when cwd missing and not DONE", () => {
    expect(
      classifyRow({ worker: { status: "running" }, cwdExists: false, session: { status: "idle" } })
    ).toBe("ORPHAN");
  });

  it("IDLE when cwd present, session idle, worker present and not done", () => {
    expect(
      classifyRow({ worker: { status: "running" }, cwdExists: true, session: { status: "idle" } })
    ).toBe("IDLE");
  });

  it("UNKNOWN when no worker signal indexed (even if session idle)", () => {
    expect(classifyRow({ worker: null, cwdExists: true, session: { status: "idle" } })).toBe(
      "UNKNOWN"
    );
  });

  it("KEEP when session busy, worktree intact, worker running", () => {
    expect(
      classifyRow({ worker: { status: "running" }, cwdExists: true, session: { status: "busy" } })
    ).toBe("KEEP");
  });

  it("KEEP when session status is null (not idle) and worktree intact", () => {
    expect(
      classifyRow({ worker: { status: "running" }, cwdExists: true, session: { status: null } })
    ).toBe("KEEP");
  });

  it("terminal worker statuses besides 'done' also classify DONE", () => {
    for (const status of ["failed", "stalled", "skipped", "turn-cap-exhausted"]) {
      expect(
        classifyRow({ worker: { status }, cwdExists: true, session: { status: "idle" } })
      ).toBe("DONE");
    }
  });
});

describe("applyDuplicates (mark older same-ticket|phase as DUPLICATE)", () => {
  it("marks the older entry DUPLICATE, keeps the newest", () => {
    const rows = [
      { ticket: "CTL-1", phase: "implement", startedAt: 1000, classification: "KEEP" },
      { ticket: "CTL-1", phase: "implement", startedAt: 2000, classification: "KEEP" },
    ];
    const out = applyDuplicates(rows);
    expect(out.find((r) => r.startedAt === 1000).classification).toBe("DUPLICATE");
    expect(out.find((r) => r.startedAt === 2000).classification).toBe("KEEP");
  });

  it("does not group across distinct ticket|phase pairs", () => {
    const rows = [
      { ticket: "CTL-1", phase: "implement", startedAt: 1000, classification: "KEEP" },
      { ticket: "CTL-1", phase: "research", startedAt: 2000, classification: "KEEP" },
      { ticket: "CTL-2", phase: "implement", startedAt: 3000, classification: "KEEP" },
    ];
    const out = applyDuplicates(rows);
    expect(out.every((r) => r.classification === "KEEP")).toBe(true);
  });

  it("never demotes a DONE/ORPHAN row to DUPLICATE", () => {
    const rows = [
      { ticket: "CTL-1", phase: "implement", startedAt: 1000, classification: "ORPHAN" },
      { ticket: "CTL-1", phase: "implement", startedAt: 2000, classification: "KEEP" },
    ];
    const out = applyDuplicates(rows);
    expect(out.find((r) => r.startedAt === 1000).classification).toBe("ORPHAN");
    expect(out.find((r) => r.startedAt === 2000).classification).toBe("KEEP");
  });
});

describe("RSS attribution (single ps snapshot, ancestor walk)", () => {
  const snapshot = parsePsSnapshot([
    "100   1 102400", // PID PPID RSS-KB  (root, ppid=1)
    "200 100  51200", // child of 100
    "300 200  30720", // grandchild via 200
    "201 100  20480", // child of 100
  ]);

  it("sums root + all descendants rss", () => {
    expect(rssTotalForPid(snapshot, 100)).toBe(102400 + 51200 + 30720 + 20480);
  });

  it("sums a subtree from a non-root pid", () => {
    expect(rssTotalForPid(snapshot, 200)).toBe(51200 + 30720);
  });

  it("returns 0 for an unknown pid", () => {
    expect(rssTotalForPid(snapshot, 999)).toBe(0);
  });

  it("tolerates blank/malformed lines", () => {
    const s = parsePsSnapshot(["", "  ", "100 1 1000", "garbage line here"]);
    expect(rssTotalForPid(s, 100)).toBe(1000);
  });
});

describe("parseSessionName (structured --name from Phase 1)", () => {
  it("parses o-<orchId>:<ticket>:<phase>:<attempt>", () => {
    expect(parseSessionName("o-adv-1103-1088:CTL-649:implement:1")).toEqual({
      orchestratorId: "o-adv-1103-1088",
      ticket: "CTL-649",
      phase: "implement",
      attempt: 1,
    });
  });

  it("returns null for a legacy prompt-derived name", () => {
    expect(parseSessionName("phase monitor merge")).toBeNull();
  });

  it("returns null for null/empty", () => {
    expect(parseSessionName(null)).toBeNull();
    expect(parseSessionName("")).toBeNull();
  });
});

describe("buildRows (joins agents + worker signals + rss, injected deps)", () => {
  const agents = () => [
    {
      pid: 100,
      cwd: "/wt/CTL-1",
      kind: "background",
      startedAt: 1000,
      sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
      name: "o-test:CTL-1:implement:1",
      status: "idle",
    },
  ];
  const signalsByBgJobId = new Map([
    [
      "11111111",
      {
        status: "running",
        ticket: "CTL-1",
        phase: "implement",
        orchestratorId: "o-test",
        worktreePath: "/wt/CTL-1",
      },
    ],
  ]);
  const psLines = ["100 1 81920"];

  it("produces a row with the full public schema", async () => {
    const rows = await buildRows({
      agents,
      signalsByBgJobId,
      psLines,
      cwdExists: () => true,
      linearStateFor: () => "Implement",
      now: 5000,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    for (const key of [
      "sessionId",
      "shortId",
      "pid",
      "name",
      "cwd",
      "orchestratorId",
      "ticket",
      "phase",
      "attempt",
      "classification",
      "signalStatus",
      "linearState",
      "elapsedMs",
      "rssKb",
    ]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.shortId).toBe("11111111");
    expect(row.classification).toBe("IDLE");
    expect(row.elapsedMs).toBe(4000);
    expect(row.rssKb).toBe(81920);
    expect(row.linearState).toBe("Implement");
  });

  it("classifies ORPHAN when cwd is missing", async () => {
    const rows = await buildRows({
      agents,
      signalsByBgJobId,
      psLines,
      cwdExists: () => false,
      now: 5000,
    });
    expect(rows[0].classification).toBe("ORPHAN");
  });

  it("falls back to name-parsing for ticket/phase when no worker signal", async () => {
    const rows = await buildRows({
      agents,
      signalsByBgJobId: new Map(),
      psLines,
      cwdExists: () => true,
      now: 5000,
    });
    expect(rows[0].ticket).toBe("CTL-1");
    expect(rows[0].phase).toBe("implement");
    expect(rows[0].classification).toBe("UNKNOWN");
  });
});

describe("buildLiveSessionsByWorktree (export consumed by Phase 6)", () => {
  it("groups rows by cwd", () => {
    const rows = [
      { cwd: "/wt/CTL-1", shortId: "a" },
      { cwd: "/wt/CTL-1", shortId: "b" },
      { cwd: "/wt/CTL-2", shortId: "c" },
    ];
    const map = buildLiveSessionsByWorktree(rows);
    expect(map.get("/wt/CTL-1").length).toBe(2);
    expect(map.get("/wt/CTL-2").length).toBe(1);
  });
});

describe("runPrune — self-protection (CRITICAL)", () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  beforeEach(() => {
    process.env.CLAUDE_CODE_SESSION_ID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  });

  it("refuses to prune the controlling session even if classified ORPHAN", async () => {
    const emitted = [];
    await runPrune({
      rows: [
        {
          sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
          shortId: "11111111",
          classification: "ORPHAN",
          cwd: "/wt/CTL-1",
        },
        {
          sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd",
          shortId: "22222222",
          classification: "ORPHAN",
          cwd: "/wt/CTL-2",
        },
      ],
      emit: (event, fields) => emitted.push({ event, fields }),
      yes: true,
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].fields.bgJobId).toBe("22222222");
  });

  it("logs a visible skip-self warning", async () => {
    const logged = [];
    await runPrune({
      rows: [
        {
          sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
          shortId: "11111111",
          classification: "ORPHAN",
        },
      ],
      emit: () => {},
      log: (m) => logged.push(m),
      yes: true,
    });
    expect(logged.some((m) => /skipping self/i.test(m))).toBe(true);
  });

  it("skips self BEFORE the category filter — a self KEEP still logs skip-self", async () => {
    // The self-guard must short-circuit ahead of the `active.has(classification)`
    // check; otherwise a refactor that reordered the two `continue`s could let a
    // self-session slip through whenever its class is excluded.
    const logged = [];
    const emitted = [];
    await runPrune({
      rows: [
        {
          sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
          shortId: "11111111",
          classification: "KEEP", // NOT in the default prune set
        },
      ],
      emit: (event, fields) => emitted.push({ event, fields }),
      log: (m) => logged.push(m),
      yes: true,
    });
    expect(emitted.length).toBe(0);
    expect(logged.some((m) => /skipping self/i.test(m))).toBe(true);
  });
});

describe("runPrune — dry-run default, categories, --max", () => {
  const pruneable = (n, cls = "ORPHAN") =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `${String(i).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
      shortId: String(i).padStart(8, "0"),
      classification: cls,
      cwd: `/wt/CTL-${i}`,
    }));

  it("dry-run is the default — nothing emitted without --yes", async () => {
    const emitted = [];
    await runPrune({ rows: pruneable(5), emit: (e, f) => emitted.push({ e, f }) });
    expect(emitted.length).toBe(0);
  });

  it("--max caps the number of emitted reaps", async () => {
    const emitted = [];
    await runPrune({
      rows: pruneable(100),
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
      max: 20,
    });
    expect(emitted.length).toBe(20);
  });

  it("default categories exclude IDLE unless --include-idle", async () => {
    const emitted = [];
    await runPrune({
      rows: pruneable(3, "IDLE"),
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(0);
    const emitted2 = [];
    await runPrune({
      rows: pruneable(3, "IDLE"),
      emit: (e, f) => emitted2.push({ e, f }),
      yes: true,
      includeIdle: true,
    });
    expect(emitted2.length).toBe(3);
  });

  it("default categories exclude KEEP/UNKNOWN", async () => {
    const emitted = [];
    await runPrune({
      rows: [...pruneable(2, "KEEP"), ...pruneable(2, "UNKNOWN")],
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(0);
  });

  it("emits phase.abort.reap-requested with the short id", async () => {
    const emitted = [];
    await runPrune({ rows: pruneable(1), emit: (e, f) => emitted.push({ e, f }), yes: true });
    expect(emitted[0].e).toBe("phase.abort.reap-requested");
    expect(emitted[0].f.bgJobId).toBe("00000000");
  });

  it("explicit --categories overrides the default set", async () => {
    const emitted = [];
    await runPrune({
      rows: [...pruneable(2, "DONE"), ...pruneable(2, "ORPHAN")],
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
      categories: ["DONE"],
    });
    expect(emitted.length).toBe(2);
  });
});

describe("parseArgs", () => {
  it("parses flags and values", () => {
    expect(parseArgs(["--json", "--ticket", "CTL-1", "--max", "20", "--yes"])).toEqual({
      json: true,
      ticket: "CTL-1",
      max: 20,
      yes: true,
    });
  });

  it("parses --dry-run and --include-idle booleans", () => {
    expect(parseArgs(["--dry-run", "--include-idle"])).toEqual({
      dryRun: true,
      includeIdle: true,
    });
  });

  it("parses --categories as a comma list", () => {
    expect(parseArgs(["--categories", "DONE,ORPHAN"]).categories).toEqual(["DONE", "ORPHAN"]);
  });
});
