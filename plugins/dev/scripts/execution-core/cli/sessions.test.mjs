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
  parseSessionArgs,
} from "./sessions.mjs";
import { ArgError } from "./args.mjs";

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
      lastSeen: () => 7000,
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
      "kind",
      "orchestratorId",
      "ticket",
      "phase",
      "attempt",
      "classification",
      "signalStatus",
      "linearState",
      "elapsedMs",
      "lastSeenMs",
      "rssKb",
    ]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.shortId).toBe("11111111");
    expect(row.classification).toBe("IDLE");
    expect(row.kind).toBe("background");
    expect(row.elapsedMs).toBe(4000);
    expect(row.lastSeenMs).toBe(7000);
    expect(row.rssKb).toBe(81920);
    expect(row.linearState).toBe("Implement");
  });

  it("populates lastSeenMs from the injected lastSeen fn (keyed by sessionId)", async () => {
    const seen = [];
    const rows = await buildRows({
      agents,
      signalsByBgJobId,
      psLines,
      cwdExists: () => true,
      lastSeen: (sessionId, { now }) => {
        seen.push({ sessionId, now });
        return 12345;
      },
      now: 5000,
    });
    expect(rows[0].lastSeenMs).toBe(12345);
    expect(seen).toEqual([
      { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", now: 5000 },
    ]);
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

  it("rounds lastSeenMs to an integer (devex finding #5 — no float noise)", async () => {
    const rows = await buildRows({
      agents,
      signalsByBgJobId,
      psLines,
      cwdExists: () => true,
      lastSeen: () => 5531440.273925781,
      now: 5000,
    });
    expect(rows[0].lastSeenMs).toBe(5531440);
    expect(Number.isInteger(rows[0].lastSeenMs)).toBe(true);
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

describe("runPrune — interactive-session protection (CRITICAL)", () => {
  const interactiveOrphan = () => [
    {
      sessionId: "33333333-aaaa-bbbb-cccc-dddddddddddd",
      shortId: "33333333",
      classification: "ORPHAN", // in the default prune set
      kind: "interactive",
      cwd: "/wt/CTL-3",
    },
  ];

  it("EXCLUDES an interactive row by default even when its class is prunable", async () => {
    const emitted = [];
    const logged = [];
    await runPrune({
      rows: interactiveOrphan(),
      emit: (e, f) => emitted.push({ e, f }),
      log: (m) => logged.push(m),
      yes: true,
    });
    expect(emitted.length).toBe(0);
    expect(logged.some((m) => /\[protected: interactive\]/.test(m))).toBe(true);
  });

  it("INCLUDES an interactive row with includeInteractive:true", async () => {
    const emitted = [];
    await runPrune({
      rows: interactiveOrphan(),
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
      includeInteractive: true,
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].f.bgJobId).toBe("33333333");
  });

  it("protects interactive rows in dry-run too (plan reflects a real prune)", async () => {
    const emitted = [];
    const logged = [];
    await runPrune({
      rows: interactiveOrphan(),
      emit: (e, f) => emitted.push({ e, f }),
      log: (m) => logged.push(m),
      // no --yes ⇒ dry-run
    });
    expect(emitted.length).toBe(0);
    expect(logged.some((m) => /\[protected: interactive\]/.test(m))).toBe(true);
  });
});

describe("runPrune — recency protection (transcript touched within minIdleMs)", () => {
  const recencyRow = (lastSeenMs) => ({
    sessionId: "44444444-aaaa-bbbb-cccc-dddddddddddd",
    shortId: "44444444",
    classification: "ORPHAN",
    kind: "background",
    lastSeenMs,
    cwd: "/wt/CTL-4",
  });

  it("EXCLUDES a row whose lastSeenMs < minIdleMs (recently active)", async () => {
    const emitted = [];
    const logged = [];
    await runPrune({
      rows: [recencyRow(5000)], // 5s ago < 15m default
      emit: (e, f) => emitted.push({ e, f }),
      log: (m) => logged.push(m),
      yes: true,
    });
    expect(emitted.length).toBe(0);
    expect(logged.some((m) => /\[protected: recently active, last_seen 5s\]/.test(m))).toBe(true);
  });

  it("INCLUDES a row whose lastSeenMs >= minIdleMs (idle long enough)", async () => {
    const emitted = [];
    await runPrune({
      rows: [recencyRow(20 * 60 * 1000)], // 20m ago >= 15m default
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].f.bgJobId).toBe("44444444");
  });

  it("INCLUDES a row whose lastSeenMs is null (unknown recency is not protective)", async () => {
    const emitted = [];
    await runPrune({
      rows: [recencyRow(null)],
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(1);
  });

  it("respects a custom minIdleMs threshold", async () => {
    const emitted = [];
    await runPrune({
      rows: [recencyRow(20 * 60 * 1000)], // 20m
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
      minIdleMs: 30 * 60 * 1000, // raise bar to 30m ⇒ 20m is now "recent"
    });
    expect(emitted.length).toBe(0);
  });
});

describe("runPrune — structured rows for --json (inspectable destructive plan)", () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  beforeEach(() => {
    process.env.CLAUDE_CODE_SESSION_ID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  });

  const mixedRows = () => [
    // self → skipped self-session
    {
      sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
      shortId: "11111111",
      classification: "ORPHAN",
      ticket: "CTL-1",
      phase: "implement",
      cwd: "/wt/CTL-1",
    },
    // interactive → skipped interactive
    {
      sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd",
      shortId: "22222222",
      classification: "ORPHAN",
      kind: "interactive",
      ticket: "CTL-2",
      phase: "research",
      cwd: "/wt/CTL-2",
    },
    // recently active → skipped recently-active
    {
      sessionId: "33333333-aaaa-bbbb-cccc-dddddddddddd",
      shortId: "33333333",
      classification: "ORPHAN",
      kind: "background",
      lastSeenMs: 5000,
      ticket: "CTL-3",
      phase: "plan",
      cwd: "/wt/CTL-3",
    },
    // reapable → planned
    {
      sessionId: "44444444-aaaa-bbbb-cccc-dddddddddddd",
      shortId: "44444444",
      classification: "ORPHAN",
      kind: "background",
      ticket: "CTL-4",
      phase: "verify",
      cwd: "/wt/CTL-4",
    },
  ];

  it("returns documented planned rows for reapable sessions", async () => {
    const { plannedRows } = await runPrune({ rows: mixedRows(), emit: () => {} });
    expect(plannedRows).toEqual([
      {
        shortId: "44444444",
        classification: "ORPHAN",
        ticket: "CTL-4",
        phase: "verify",
        cwd: "/wt/CTL-4",
      },
    ]);
  });

  it("records skipped rows with the correct machine reasons", async () => {
    const { skippedRows } = await runPrune({ rows: mixedRows(), emit: () => {} });
    expect(skippedRows).toContainEqual({ shortId: "11111111", reason: "self-session" });
    expect(skippedRows).toContainEqual({ shortId: "22222222", reason: "interactive" });
    expect(skippedRows).toContainEqual({ shortId: "33333333", reason: "recently-active" });
  });

  it("records not-in-category for an excluded classification", async () => {
    const { skippedRows } = await runPrune({
      rows: [
        {
          sessionId: "55555555-aaaa-bbbb-cccc-dddddddddddd",
          shortId: "55555555",
          classification: "KEEP",
          kind: "background",
          cwd: "/wt/CTL-5",
        },
      ],
      emit: () => {},
    });
    expect(skippedRows).toContainEqual({ shortId: "55555555", reason: "not-in-category" });
  });

  it("emitted is 0 in dry-run; dryRun-derived plan still lists the row", async () => {
    const emitted = [];
    const result = await runPrune({
      rows: mixedRows(),
      emit: (e, f) => emitted.push({ e, f }),
      // no --yes ⇒ dry-run
    });
    expect(result.emitted).toBe(0);
    expect(emitted.length).toBe(0);
    expect(result.plannedRows.length).toBe(1);
  });

  it("emits live (emitted reflects count) when --yes and not dry-run", async () => {
    const emitted = [];
    const result = await runPrune({
      rows: mixedRows(),
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(result.emitted).toBe(1);
    expect(emitted.length).toBe(1);
  });

  it("suppresses human log lines when json:true (clean JSON stream)", async () => {
    const logged = [];
    await runPrune({ rows: mixedRows(), emit: () => {}, log: (m) => logged.push(m), json: true });
    expect(logged.length).toBe(0);
  });
});

describe("parseSessionArgs (strict shared parser + option mapping)", () => {
  it("parses flags and values", () => {
    expect(parseSessionArgs(["--json", "--ticket", "CTL-1", "--max", "20", "--yes"])).toEqual({
      json: true,
      ticket: "CTL-1",
      max: 20,
      yes: true,
    });
  });

  it("parses --dry-run and --include-idle booleans (mapped to camelCase)", () => {
    expect(parseSessionArgs(["--dry-run", "--include-idle"])).toEqual({
      dryRun: true,
      includeIdle: true,
    });
  });

  it("parses --categories as a comma list", () => {
    expect(parseSessionArgs(["--categories", "DONE,ORPHAN"]).categories).toEqual([
      "DONE",
      "ORPHAN",
    ]);
  });

  it("parses --include-interactive boolean", () => {
    expect(parseSessionArgs(["--include-interactive"])).toEqual({ includeInteractive: true });
  });

  it("maps --min-idle-seconds 60 → minIdleMs 60000 (×1000)", () => {
    expect(parseSessionArgs(["--min-idle-seconds", "60"])).toEqual({ minIdleMs: 60000 });
  });

  it("THROWS ArgError on an unknown flag (devex finding #1 — no silent exit 0)", () => {
    expect(() => parseSessionArgs(["--include-interactiv"])).toThrow(ArgError);
    expect(() => parseSessionArgs(["--bogus"])).toThrow(/unknown flag: --bogus/);
  });

  it("THROWS ArgError on --min-idle-seconds abc (devex finding #2 — no silent NaN)", () => {
    expect(() => parseSessionArgs(["--min-idle-seconds", "abc"])).toThrow(ArgError);
    expect(() => parseSessionArgs(["--min-idle-seconds", "abc"])).toThrow(/expects a number/);
  });
});
