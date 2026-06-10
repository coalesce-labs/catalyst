// utilization-kit.test.ts — units for the OBS-16 UTILIZATION pure logic:
//   1. pathology      — the STARVED/JAMMED/SATURATED/HEALTHY slot decision
//   2. occupancyPct   — slot occupancy % from the AUTOTUNED maxParallel
//   3. occupancyBand  — the calm hero band (idle/partial/full)
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/utilization-kit.test.ts
import { describe, it, expect } from "bun:test";
import type { OtelLogEntry } from "@/lib/types";
import {
  pathology,
  occupancyPct,
  occupancyBand,
  idleBetweenPhases,
  isRateLimitError,
  rateLimitErrors,
  type Pathology,
  type IdleTicketInput,
} from "./utilization-kit";

describe("pathology — the slot failure-mode decision", () => {
  it("JAMMED when free slots AND a waiting queue (dispatcher problem)", () => {
    // The LIVE Mini ground truth (2026-06-10): freeSlots=6, queue=3. The daemon is
    // parked → free slots can't be placed → JAMMED is the correct loud signal.
    expect(pathology(6, 3)).toBe("JAMMED");
  });

  it("the exact live ground-truth case resolves to JAMMED (free 6, queue 3)", () => {
    const live: Pathology = pathology(6, 3);
    expect(live).toBe("JAMMED");
  });

  it("STARVED when free slots but an EMPTY queue (backlog problem)", () => {
    expect(pathology(6, 0)).toBe("STARVED");
    expect(pathology(1, 0)).toBe("STARVED");
  });

  it("SATURATED when there are NO free slots — fully booked, fine", () => {
    // freeSlots === 0 wins even if a queue exists (every slot is busy; the queue is
    // simply waiting for a slot to free — that's healthy back-pressure, not a stall).
    expect(pathology(0, 0)).toBe("SATURATED");
    expect(pathology(0, 3)).toBe("SATURATED");
  });

  it("JAMMED beats STARVED only via the queue (free + queue vs free + no queue)", () => {
    expect(pathology(2, 1)).toBe("JAMMED");
    expect(pathology(2, 0)).toBe("STARVED");
  });

  it("clamps negative/fractional counters before deciding (never mis-classifies)", () => {
    // A bad/negative free count is clamped to 0 → SATURATED, not a crash.
    expect(pathology(-1, 5)).toBe("SATURATED");
    // Fractional queue floors to 0 → STARVED with free slots.
    expect(pathology(3, 0.4)).toBe("STARVED");
    // Fractional queue ≥1 floors to ≥1 → JAMMED.
    expect(pathology(3, 1.9)).toBe("JAMMED");
  });
});

describe("occupancyPct — slot occupancy from the AUTOTUNED maxParallel", () => {
  it("0% when nothing is in flight (the live idle case: 0/6)", () => {
    expect(occupancyPct(0, 6)).toBe(0);
  });

  it("rounds inFlight/maxParallel to a whole percent", () => {
    expect(occupancyPct(3, 6)).toBe(50);
    expect(occupancyPct(1, 6)).toBe(17); // 16.67 → 17
    expect(occupancyPct(2, 6)).toBe(33); // 33.33 → 33
  });

  it("uses the AUTOTUNED maxParallel, not a fixed 6 (autotune raised cap to 8)", () => {
    // If autotune lifted the live cap to 8, 4 busy slots is 50%, NOT 67%.
    expect(occupancyPct(4, 8)).toBe(50);
  });

  it("100% when every slot is busy", () => {
    expect(occupancyPct(6, 6)).toBe(100);
  });

  it("returns 0% (no divide-by-zero) when maxParallel <= 0", () => {
    expect(occupancyPct(3, 0)).toBe(0);
    expect(occupancyPct(0, 0)).toBe(0);
    expect(occupancyPct(3, -1)).toBe(0);
  });

  it("clamps a transient overshoot (inFlight > maxParallel) to 100%", () => {
    // A just-reconciled overshoot must never render >100%.
    expect(occupancyPct(7, 6)).toBe(100);
  });

  it("clamps a negative inFlight to 0%", () => {
    expect(occupancyPct(-2, 6)).toBe(0);
  });
});

describe("occupancyBand — the calm hero band", () => {
  it("idle at 0% (neutral grey — honest, not alarming)", () => {
    expect(occupancyBand(0)).toBe("idle");
  });

  it("partial between 0 and 100", () => {
    expect(occupancyBand(1)).toBe("partial");
    expect(occupancyBand(50)).toBe("partial");
    expect(occupancyBand(99)).toBe("partial");
  });

  it("full at 100%", () => {
    expect(occupancyBand(100)).toBe("full");
  });
});

describe("idleBetweenPhases — the CTL-928 lane derivation (P3)", () => {
  function tk(over: Partial<IdleTicketInput>): IdleTicketInput {
    return {
      id: "CTL-1",
      phase: "research",
      workerStatus: null,
      activeState: null,
      currentPhaseSince: null,
      ...over,
    };
  }

  it("is EMPTY when there are no tickets (the live ground-truth zero)", () => {
    expect(idleBetweenPhases([])).toEqual([]);
  });

  it("includes a ticket with no live worker on an intermediate phase", () => {
    const now = Date.parse("2026-06-10T15:00:00Z");
    const rows = idleBetweenPhases(
      [tk({ id: "CTL-7", phase: "plan", currentPhaseSince: "2026-06-10T14:30:00Z" })],
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("CTL-7");
    expect(rows[0]!.phase).toBe("plan");
    expect(rows[0]!.idleForMs).toBe(30 * 60_000);
  });

  it("EXCLUDES a ticket with a live (non-dead) worker — that's the board 'live' lane", () => {
    const rows = idleBetweenPhases([
      tk({ id: "CTL-8", workerStatus: "running", activeState: "active" }),
    ]);
    expect(rows).toEqual([]);
  });

  it("INCLUDES a dead-worker ticket (in-flight on paper, idle in reality)", () => {
    const rows = idleBetweenPhases([
      tk({ id: "CTL-9", workerStatus: "running", activeState: "dead" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("CTL-9");
  });

  it("EXCLUDES a ticket on the terminal `done` phase (recent-done, not idle)", () => {
    const rows = idleBetweenPhases([tk({ id: "CTL-10", phase: "done" })]);
    expect(rows).toEqual([]);
  });

  it("renders idle-for as null (→ '—') when no honest currentPhaseSince exists", () => {
    const rows = idleBetweenPhases([tk({ id: "CTL-11", currentPhaseSince: null })]);
    expect(rows[0]!.idleForMs).toBeNull();
  });

  it("sorts longest-idle first (the most-stuck row leads)", () => {
    const now = Date.parse("2026-06-10T15:00:00Z");
    const rows = idleBetweenPhases(
      [
        tk({ id: "CTL-A", currentPhaseSince: "2026-06-10T14:50:00Z" }), // 10m
        tk({ id: "CTL-B", currentPhaseSince: "2026-06-10T14:00:00Z" }), // 60m
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["CTL-B", "CTL-A"]);
  });
});

describe("rateLimitErrors — the 429/overload filter (P_err)", () => {
  function err(over: Partial<OtelLogEntry>): OtelLogEntry {
    return { timestamp: "1", line: "claude_code.api_error", labels: {}, ...over };
  }

  it("is EMPTY for no errors (the live healthy zero)", () => {
    expect(rateLimitErrors([])).toEqual([]);
  });

  it("matches a 429 in the error label", () => {
    expect(
      isRateLimitError(err({ labels: { error: "429 rate_limit_error" } })),
    ).toBe(true);
  });

  it("matches a 529 / overloaded in the status_code label", () => {
    expect(isRateLimitError(err({ labels: { status_code: "529" } }))).toBe(true);
    expect(
      isRateLimitError(err({ labels: { error: "Overloaded" } })),
    ).toBe(true);
  });

  it("matches the raw line when labels are bare", () => {
    expect(
      isRateLimitError(err({ line: "request failed: rate limit exceeded" })),
    ).toBe(true);
  });

  it("does NOT match a non-rate-limit error (a 500 / parse error)", () => {
    expect(
      isRateLimitError(err({ labels: { error: "500 internal_server_error" } })),
    ).toBe(false);
  });

  it("filters a mixed set to only the rate-limit rows", () => {
    const out = rateLimitErrors([
      err({ labels: { error: "429 rate_limit_error" } }),
      err({ labels: { error: "500 internal_server_error" } }),
      err({ labels: { error: "overloaded_error" } }),
    ]);
    expect(out).toHaveLength(2);
  });
});
