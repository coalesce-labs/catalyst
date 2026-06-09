// CTL-914 (DETAIL3): the pure worker-detail logic — diagnostics math, signal
// field extraction, this-run phase timestamps, scalar fallbacks, death-freeze.
// React-free, so the load-bearing Gherkin invariants (liveness colour, the
// literal 90s stale-bg gate, signal-served model, never-fabricate) are proven
// here without a DOM.
import { describe, it, expect } from "bun:test";
import {
  deriveLiveness,
  deriveStaleBgGate,
  STALE_BG_GATE_MS,
  readPhaseSignalFields,
  resolveHeaderModel,
  readRunPhaseTimestamps,
  readWorkerScalars,
  isWorkerAlive,
} from "../ui/src/board/worker-detail-data";
import type { BoardWorker } from "../ui/src/board/types";

function worker(over: Partial<BoardWorker> = {}): BoardWorker {
  return {
    name: "CTL-845:2",
    ticket: "CTL-845",
    tickets: ["CTL-845"],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: Date.now(),
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 842_000,
    costUSD: 0.84,
    sessionId: "11111111-2222-3333-4444-555555555555",
    ...over,
  };
}

describe("deriveLiveness (green→yellow→red off now − lastActiveMs)", () => {
  const NOW = 10_000_000;
  it("green when idle under 45s", () => {
    const s = deriveLiveness(NOW - 12_000, NOW);
    expect(s.level).toBe("green");
    expect(s.idleMs).toBe(12_000);
  });
  it("yellow between 45s and 30m", () => {
    expect(deriveLiveness(NOW - 120_000, NOW).level).toBe("yellow");
  });
  it("red beyond 30m", () => {
    expect(deriveLiveness(NOW - 2_000_000, NOW).level).toBe("red");
  });
  it("unknown when lastActiveMs is absent (never fabricated)", () => {
    expect(deriveLiveness(null, NOW)).toEqual({ level: "unknown", idleMs: null });
    expect(deriveLiveness(undefined, NOW).level).toBe("unknown");
  });
  it("clamps a future lastActiveMs to 0 idle (green, never negative)", () => {
    const s = deriveLiveness(NOW + 5_000, NOW);
    expect(s.idleMs).toBe(0);
    expect(s.level).toBe("green");
  });
});

describe("deriveStaleBgGate (idle vs the literal 90s daemon revive threshold)", () => {
  const NOW = 10_000_000;
  it("uses the daemon ghost-grace literal (90s)", () => {
    expect(STALE_BG_GATE_MS).toBe(90_000);
  });
  it("not tripped under 90s idle", () => {
    const g = deriveStaleBgGate(NOW - 30_000, NOW);
    expect(g.thresholdMs).toBe(90_000);
    expect(g.tripped).toBe(false);
    expect(g.idleMs).toBe(30_000);
  });
  it("tripped at/over 90s idle (the daemon would revive)", () => {
    expect(deriveStaleBgGate(NOW - 90_000, NOW).tripped).toBe(true);
    expect(deriveStaleBgGate(NOW - 120_000, NOW).tripped).toBe(true);
  });
  it("never claims tripped without data", () => {
    const g = deriveStaleBgGate(null, NOW);
    expect(g.idleMs).toBeNull();
    expect(g.tripped).toBe(false);
  });
});

describe("readPhaseSignalFields (verbatim signal → header rows)", () => {
  it("extracts model/bg_job_id/attempt/generation/timestamps/status", () => {
    const f = readPhaseSignalFields({
      model: "claude-opus-4-8[1m]",
      bg_job_id: "7f3a91",
      attempt: 2,
      generation: 1,
      startedAt: "2026-06-08T14:00:00Z",
      completedAt: null,
      status: "running",
    });
    expect(f.model).toBe("claude-opus-4-8[1m]");
    expect(f.bgJobId).toBe("7f3a91");
    expect(f.attempt).toBe(2);
    expect(f.generation).toBe(1);
    expect(f.startedAt).toBe("2026-06-08T14:00:00Z");
    expect(f.completedAt).toBeNull();
    expect(f.status).toBe("running");
  });
  it("a null signal (404) yields all-null — every row dims, none faked", () => {
    const f = readPhaseSignalFields(null);
    expect(f.model).toBeNull();
    expect(f.bgJobId).toBeNull();
    expect(f.attempt).toBeNull();
    expect(f.generation).toBeNull();
  });
  it("tolerates the alt camelCase / `gen` key spellings", () => {
    const f = readPhaseSignalFields({ bgJobId: "abc", gen: 3 });
    expect(f.bgJobId).toBe("abc");
    expect(f.generation).toBe(3);
  });
});

describe("resolveHeaderModel (SIGNAL-served, dims until the fetch lands)", () => {
  it("uses the signal model", () => {
    expect(
      resolveHeaderModel(readPhaseSignalFields({ model: "opus-4-8" }), worker()),
    ).toBe("opus-4-8");
  });
  it("dims (null) when no signal — BoardWorker carries no model", () => {
    expect(resolveHeaderModel(null, worker())).toBeNull();
  });
});

describe("readRunPhaseTimestamps (THIS run's phases only — the IA cut)", () => {
  it("surfaces the single bound phase from the signal's started/completed", () => {
    const ts = readRunPhaseTimestamps(
      { startedAt: "2026-06-08T14:00:00Z", completedAt: "2026-06-08T14:14:00Z" },
      "implement",
    );
    expect(ts).toHaveLength(1);
    expect(ts[0].phase).toBe("implement");
    expect(ts[0].current).toBe(true);
    expect(ts[0].startedAt).toBe("2026-06-08T14:00:00Z");
  });
  it("surfaces a signal-carried phaseTimestamps map, marking the current phase", () => {
    const ts = readRunPhaseTimestamps(
      { phaseTimestamps: { triage: "t1", research: "t2", implement: "t3" } },
      "implement",
    );
    expect(ts.map((t) => t.phase)).toEqual(["triage", "research", "implement"]);
    expect(ts.find((t) => t.phase === "implement")!.current).toBe(true);
    expect(ts.find((t) => t.phase === "triage")!.current).toBe(false);
  });
  it("a null signal still yields the bound phase (page is never empty)", () => {
    const ts = readRunPhaseTimestamps(null, "verify");
    expect(ts).toHaveLength(1);
    expect(ts[0].phase).toBe("verify");
    expect(ts[0].startedAt).toBeNull();
  });
});

describe("readWorkerScalars (resident fallbacks)", () => {
  it("reads cost/runtime/sessionId/catalystSessionId off the BoardWorker", () => {
    const s = readWorkerScalars(worker({ catalystSessionId: "sess_abc" }));
    expect(s.costUSD).toBe(0.84);
    expect(s.runtimeMs).toBe(842_000);
    expect(s.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(s.catalystSessionId).toBe("sess_abc");
  });
  it("an undefined worker (cold-link) yields all-null", () => {
    const s = readWorkerScalars(undefined);
    expect(s.costUSD).toBeNull();
    expect(s.sessionId).toBeNull();
  });
});

describe("isWorkerAlive (ring grey on death, status flip, zero reflow)", () => {
  it("alive iff working && activeState active (the title-dot rule)", () => {
    expect(isWorkerAlive(worker({ working: true, activeState: "active" }))).toBe(true);
    expect(isWorkerAlive(worker({ working: false, activeState: "active" }))).toBe(false);
    expect(isWorkerAlive(worker({ working: true, activeState: "stuck" }))).toBe(false);
    expect(isWorkerAlive(worker({ working: true, activeState: null }))).toBe(false);
  });
  it("a dead (undefined) worker is not alive", () => {
    expect(isWorkerAlive(undefined)).toBe(false);
  });
});
