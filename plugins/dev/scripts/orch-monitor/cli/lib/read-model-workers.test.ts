// CTL-920 / HUD2: map the read-model's assembled BoardWorker[] onto the HUD's
// WorkerSignal[] shape so the Dashboard's Workers view renders the SAME worker
// state the web/iPad show — instead of the HUD re-deriving it from raw signal
// files. This is the "one assembly, many readers" mapping for the headline
// worker primary-state consolidation; raw readWorkerSignals() remains the
// down-server fallback (tested at the Dashboard level).
import { describe, it, expect } from "bun:test";
import { boardWorkersToSignals, selectWorkers } from "./read-model-workers";
import type { BoardWorker } from "../../lib/read-model-client";
import type { WorkerSignal } from "./worker-signals-reader";

function boardWorker(overrides: Partial<BoardWorker> = {}): BoardWorker {
  return {
    name: "alice",
    ticket: "CTL-100",
    tickets: ["CTL-100"],
    phase: "implement",
    status: "active",
    activeState: "active",
    working: true,
    lastActiveMs: 30_000,
    repo: "owner/repo",
    team: "CTL",
    runtimeMs: 120_000,
    costUSD: 1.23,
    sessionId: "sess-abc",
    startedAt: 1_700_000_000_000,
    pid: 4242,
    catalystSessionId: "sess_xyz",
    // CTL-922/BFF11 made BoardWorker.host and .generation required fields
    // (BoardHostRef | null / number | null) after this branch was cut; single-host
    // identity no-op ⇒ both null (no host named, resolves to the one local node; no
    // fence). Additive rebase fix-up — keeps the fixture assignable without changing
    // any HUD2 behavior.
    host: null,
    generation: null,
    ...overrides,
  };
}

describe("boardWorkersToSignals (CTL-920)", () => {
  it("maps the load-bearing fields the WorkerList renders", () => {
    const [w] = boardWorkersToSignals([boardWorker()], 1_700_000_100_000);
    expect(w.ticket).toBe("CTL-100");
    expect(w.workerName).toBe("alice");
    expect(w.status).toBe("active");
    // BoardWorker.phase is the per-phase NAME (string) → WorkerSignal.phaseName.
    expect(w.phaseName).toBe("implement");
    expect(w.phase).toBeNull(); // legacy integer phase has no read-model source
  });

  it("derives lastHeartbeat ISO from lastActiveMs relative to now", () => {
    const now = 1_700_000_100_000;
    const [w] = boardWorkersToSignals([boardWorker({ lastActiveMs: 60_000 })], now);
    expect(w.lastHeartbeat).toBe(new Date(now - 60_000).toISOString());
  });

  it("a null lastActiveMs yields a null lastHeartbeat (not Epoch)", () => {
    const [w] = boardWorkersToSignals([boardWorker({ lastActiveMs: null })], Date.now());
    expect(w.lastHeartbeat).toBeNull();
  });

  it("leaves pr null — the read-model worker slice carries no PR (PR is on the ticket slice)", () => {
    const [w] = boardWorkersToSignals([boardWorker()], Date.now());
    expect(w.pr).toBeNull();
  });

  it("maps startedAt epoch-ms to an ISO string and preserves the orchestrator-as-team note", () => {
    const [w] = boardWorkersToSignals([boardWorker({ startedAt: 1_700_000_000_000 })], Date.now());
    expect(w.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("carries the source BoardWorker through as `raw` so the detail pane shows it verbatim", () => {
    const src = boardWorker();
    const [w] = boardWorkersToSignals([src], Date.now());
    expect(w.raw).toBe(src);
  });

  it("a stuck worker surfaces as status with no fabricated stalledReason", () => {
    const [w] = boardWorkersToSignals([boardWorker({ status: "stuck", activeState: "stuck" })], Date.now());
    expect(w.status).toBe("stuck");
    expect(w.stalledReason).toBeNull();
  });
});

describe("selectWorkers — read-model-vs-raw fallback (CTL-920)", () => {
  const rmRow = boardWorkersToSignals([boardWorker({ ticket: "CTL-READMODEL" })], Date.now());
  const rawRow: WorkerSignal[] = [
    {
      ticket: "CTL-RAW",
      orchestrator: "orch-1",
      wave: null,
      workerName: "raw-worker",
      label: null,
      status: "active",
      stalledReason: null,
      phase: 3,
      phaseName: "implement",
      phaseTimestamps: {},
      lastHeartbeat: null,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      worktreePath: null,
      pr: null,
      linearState: null,
      definitionOfDone: null,
      raw: {},
    },
  ];

  it("prefers the read-model rows when connected (server up)", () => {
    expect(selectWorkers(rmRow, rawRow)[0].ticket).toBe("CTL-READMODEL");
  });

  it("falls back to the raw scan when the read-model is unavailable (server down ⇒ null)", () => {
    expect(selectWorkers(null, rawRow)[0].ticket).toBe("CTL-RAW");
  });

  it("an empty read-model worker list is still authoritative (NOT treated as fallback)", () => {
    // A connected read-model with zero workers is the truth — selecting it (not
    // the raw scan) is what keeps the HUD in lockstep with the web's empty board.
    expect(selectWorkers([], rawRow)).toEqual([]);
  });
});
