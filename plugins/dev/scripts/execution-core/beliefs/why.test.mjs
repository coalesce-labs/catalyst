// why.test.mjs — CTL-934 `catalyst why <ticket>` (§5 recursive-CTE trace).
// The CTL-722 fixture is collected end-to-end (collector → rules), then traced:
// the output must show the belief, the rule, and each source fact with its
// timestamp and raw values (the Gherkin "trace a belief to its evidence").
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { collectTickFacts, __resetBeliefsCollectorForTests } from "./collector.mjs";
import { traceTicket, renderTrace, latestTickForTicket, main } from "./why.mjs";

const NOW = 1781030108000; // 2026-06-09T18:35:08Z
const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl934-why-"));
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

// Collect the §5 CTL-722 wedge into a fresh db, return the db handle.
function collectWedge(dbPath) {
  const db = openBeliefsDb({ path: dbPath });
  const res = collectTickFacts({
    orchDir: scratch(),
    db,
    now: NOW,
    host: "mini",
    env: { CATALYST_BELIEFS_SHADOW: "1" },
    eventLogPath: join(scratch(), "absent.jsonl"),
    linearCache: { get: () => undefined },
    getAgents: () => [
      {
        sessionId: SID,
        kind: "background",
        status: "idle",
        state: "blocked",
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
    readJobState: (id) =>
      id === "5ad5c1ff"
        ? {
            exists: true,
            state: "working",
            tempo: "blocked",
            detail: "stuck on a startup dialog",
            firstTerminalAt: null,
            mtimeMs: 1780995390000,
          }
        : { exists: false },
    findTranscriptFn: () => null, // transcript never created
  });
  expect(res.ok).toBe(true);
  return db;
}

describe("traceTicket — structured belief→rule→facts chain", () => {
  test("latestTickForTicket finds the tick that mentions the ticket", () => {
    const db = collectWedge(join(scratch(), "b.db"));
    const t = latestTickForTicket(db, "CTL-722");
    expect(t).toBeGreaterThan(0);
    expect(latestTickForTicket(db, "CTL-999")).toBe(null);
    db.close();
  });

  test("trace includes wedged_never_started ← R4 ← session_registered ← {signal, agent}", () => {
    const db = collectWedge(join(scratch(), "b.db"));
    const trace = traceTicket(db, "CTL-722");
    const names = trace.beliefs.map((b) => b.name);
    expect(names).toContain("wedged_never_started");
    expect(names).toContain("session_registered");
    expect(names).toContain("wake_diagnostician");

    const wns = trace.beliefs.find((b) => b.name === "wedged_never_started");
    expect(wns.rule_id).toBe("R4");
    // its sources include the session_registered belief and the signal fact + tick
    const srcKinds = wns.sources.map((s) => `${s.kind}:${s.table}`);
    expect(srcKinds).toContain("belief:belief");
    expect(srcKinds).toContain("fact:obs_signal");
    expect(srcKinds).toContain("fact:tick");

    // session_registered traces down to the raw signal + agent facts
    const sr = trace.beliefs.find((b) => b.name === "session_registered");
    const srTables = sr.sources.map((s) => s.table).sort();
    expect(srTables).toEqual(["obs_agent", "obs_signal"]);
    db.close();
  });
});

describe("renderTrace / main — human-readable output (the Gherkin trace)", () => {
  test("output shows the belief, the rule, and each source fact with timestamp + raw values", () => {
    const db = collectWedge(join(scratch(), "b.db"));
    const text = renderTrace(traceTicket(db, "CTL-722"));
    db.close();

    // the belief and its rule id
    expect(text).toContain("wedged_never_started(CTL-722/plan)");
    expect(text).toContain("rule R4");
    // the rule that did NOT fire is absent; the one that did is present
    expect(text).toContain("session_registered(CTL-722/plan)");
    expect(text).toContain("[rule R1");

    // each source fact with raw values
    expect(text).toContain("signal CTL-722/plan status=running bg=5ad5c1ff");
    expect(text).toContain("agent short=5ad5c1ff");
    expect(text).toContain("state=blocked"); // the field the procedural code never read

    // a timestamp on a fact (ISO-rendered from epoch ms)
    expect(text).toContain("2026-06-09T08:56"); // signal started/updated
  });

  test("main() prints the trace and exits 0; unknown ticket exits 1; --json emits structure", () => {
    const dbPath = join(scratch(), "b.db");
    collectWedge(dbPath).close();
    const env = { CATALYST_BELIEFS_DB: dbPath };

    let printed = "";
    const out = (s) => (printed += s + "\n");
    const code = main(["CTL-722"], { env, out });
    expect(code).toBe(0);
    expect(printed).toContain("wedged_never_started(CTL-722/plan)");

    printed = "";
    const codeMiss = main(["CTL-999"], { env, out });
    expect(codeMiss).toBe(1);
    expect(printed).toContain("no beliefs recorded for CTL-999");

    printed = "";
    main(["CTL-722", "--json"], { env, out });
    const parsed = JSON.parse(printed);
    expect(parsed.ticket).toBe("CTL-722");
    expect(parsed.beliefs.some((b) => b.rule_id === "R4")).toBe(true);

    printed = "";
    const codeUsage = main([], { env, out });
    expect(codeUsage).toBe(2);
    expect(printed).toContain("usage: catalyst why");
  });

  test("the §5 deliverable: free_slots belief reports BOTH bounds in the trace too", () => {
    const db = collectWedge(join(scratch(), "b.db"));
    // free_slots is host-scoped — pass an explicit tick to fold it in.
    const tickId = latestTickForTicket(db, "CTL-722");
    // it lives under host:mini, so query directly to assert the trace renders it
    const fs = db.query("SELECT value FROM belief WHERE name='free_slots' AND tick_id=?").get(tickId);
    expect(JSON.parse(fs.value)).toMatchObject({ by_lease: 6, by_session_cap: 9 });
    db.close();
  });
});
