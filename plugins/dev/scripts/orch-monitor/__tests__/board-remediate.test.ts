// board-remediate.test.ts — CTL-972: verify the three-part fix:
//   1. derivePhaseWithRemediate: ticket.phase='remediate' for active + dead-worker
//   2. PHASE_COLUMNS: remediate column exists between verify and review
//   3. A remediate ticket lands in the remediate board column + list group
//
// All tests are pure (no DOM, no I/O) — same discipline as board-display.test.ts
// and board-current-phase.test.ts.

import { describe, it, expect, test } from "bun:test";
import {
  deriveCurrentPhase,
  derivePhaseWithRemediate,
  PHASE_ORDER,
  REMEDIATE_PHASE,
} from "../lib/board-data.mjs";
import {
  PHASE_COLUMNS,
  ticketColumns,
} from "../ui/src/board/board-display";
import type { BoardTicket } from "../ui/src/board/types";

// ── helpers ─────────────────────────────────────────────────────────────────

type Sig = {
  status: string;
  model?: string | null;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
} | null;

function sigs(): Sig[] {
  return PHASE_ORDER.map(() => null);
}

const idx = (phase: string) => PHASE_ORDER.indexOf(phase);

function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id, title: id, type: "feature", repo: "catalyst", team: "CTL",
    phase: "verify", status: "done", model: null, linearState: "Validate",
    workerStatus: null, activeState: null, working: false, lastActiveMs: null,
    priority: 2, estimate: null, scope: null, project: null, costUSD: null,
    tokens: null, turns: null, phaseCosts: null, phaseSummary: [], pr: null,
    updatedAt: "", ...over,
  };
}

// ── 1. derivePhaseWithRemediate ──────────────────────────────────────────────

describe("derivePhaseWithRemediate — no remediate signal", () => {
  it("returns deriveCurrentPhase result unchanged when remediateSig is null", () => {
    const s = sigs();
    s[idx("verify")] = { status: "running", startedAt: "2026-06-09T10:00:00Z" };
    const cur = deriveCurrentPhase(s);
    const withR = derivePhaseWithRemediate(s, null);
    expect(withR).toEqual(cur);
    expect(withR.phase).toBe("verify");
  });

  it("returns deriveCurrentPhase result unchanged when remediateSig is undefined", () => {
    const s = sigs();
    s[idx("implement")] = { status: "done", updatedAt: "2026-06-09T09:00:00Z" };
    expect(derivePhaseWithRemediate(s, undefined as unknown as null).phase).toBe("implement");
  });
});

describe("derivePhaseWithRemediate — remediate RUNNING (non-terminal)", () => {
  it("returns phase='remediate' when remediate is actively running", () => {
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:00:00Z" };
    const remediateSig = { status: "running", startedAt: "2026-06-09T10:05:00Z", updatedAt: "2026-06-09T10:06:00Z" };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.phase).toBe(REMEDIATE_PHASE);
    expect(result.status).toBe("running");
    expect(result.startedAt).toBe("2026-06-09T10:05:00Z");
  });

  it("remediate running wins even when verify has no terminal status", () => {
    const s = sigs();
    // verify not yet written (null)
    const remediateSig = { status: "running", startedAt: "2026-06-09T10:00:00Z" };
    expect(derivePhaseWithRemediate(s, remediateSig).phase).toBe(REMEDIATE_PHASE);
  });

  it("passes through model from the remediate signal", () => {
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:00:00Z" };
    const remediateSig = { status: "running", model: "claude-opus-4-5", startedAt: "2026-06-09T10:05:00Z" };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.model).toBe("claude-opus-4-5");
  });
});

describe("derivePhaseWithRemediate — remediate TERMINAL (dead-worker case)", () => {
  it("returns phase='remediate' when remediate.updatedAt > verify.updatedAt (dead worker)", () => {
    // CTL-729 scenario: verify.done at T1, remediate.done at T2 > T1.
    // The (dead) remediate worker ran last — board must show 'remediate'.
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:00:00Z" };
    const remediateSig: Sig = {
      status: "done",
      updatedAt: "2026-06-09T10:10:00Z", // remediate ran AFTER verify
    };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.phase).toBe(REMEDIATE_PHASE);
    expect(result.status).toBe("done");
  });

  it("returns phase='remediate' using completedAt when updatedAt is absent", () => {
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:00:00Z" };
    const remediateSig: Sig = {
      status: "done",
      completedAt: "2026-06-09T10:15:00Z", // fallback to completedAt
    };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.phase).toBe(REMEDIATE_PHASE);
  });

  it("returns verify phase when verify ran AFTER remediate (new verify pass started)", () => {
    // verify → remediate → verify again: the new verify.done at T3 > remediate.done at T2
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:20:00Z" }; // latest
    const remediateSig: Sig = {
      status: "done",
      updatedAt: "2026-06-09T10:10:00Z", // remediate was before this verify pass
    };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.phase).toBe("verify");
  });

  it("returns verify when verify is currently RUNNING (regardless of remediate terminal)", () => {
    const s = sigs();
    // verify is running (non-terminal) — deriveCurrentPhase returns verify running
    // and remediateSig is terminal but older, so verify wins
    s[idx("verify")] = { status: "running", updatedAt: "2026-06-09T10:20:00Z" };
    const remediateSig: Sig = {
      status: "done",
      updatedAt: "2026-06-09T10:10:00Z",
    };
    const result = derivePhaseWithRemediate(s, remediateSig);
    // verify is running (non-terminal) → deriveCurrentPhase surfaces it;
    // remediateSig is terminal AND older → no override → verify wins
    expect(result.phase).toBe("verify");
    expect(result.status).toBe("running");
  });

  it("remediate failed surfaces as phase=remediate status=failed (mid-verify-cycle fail)", () => {
    const s = sigs();
    s[idx("verify")] = { status: "done", updatedAt: "2026-06-09T10:00:00Z" };
    const remediateSig: Sig = {
      status: "failed",
      updatedAt: "2026-06-09T10:05:00Z",
    };
    const result = derivePhaseWithRemediate(s, remediateSig);
    expect(result.phase).toBe(REMEDIATE_PHASE);
    expect(result.status).toBe("failed");
  });
});

// ── 2. PHASE_COLUMNS includes remediate between verify and review ─────────────

describe("PHASE_COLUMNS — remediate column exists", () => {
  test("PHASE_COLUMNS contains a 'remediate' column", () => {
    const keys = PHASE_COLUMNS.map((c) => c.key);
    expect(keys).toContain("remediate");
  });

  test("remediate is positioned between verify and review", () => {
    const keys = PHASE_COLUMNS.map((c) => c.key);
    const iVerify = keys.indexOf("verify");
    const iRemediate = keys.indexOf("remediate");
    const iReview = keys.indexOf("review");
    expect(iVerify).toBeGreaterThanOrEqual(0);
    expect(iRemediate).toBeGreaterThanOrEqual(0);
    expect(iReview).toBeGreaterThanOrEqual(0);
    expect(iRemediate).toBeGreaterThan(iVerify);
    expect(iRemediate).toBeLessThan(iReview);
  });

  test("remediate column color is #d98ab2", () => {
    const col = PHASE_COLUMNS.find((c) => c.key === "remediate");
    expect(col?.c).toBe("#d98ab2");
  });

  test("remediate column label is 'Remediate'", () => {
    const col = PHASE_COLUMNS.find((c) => c.key === "remediate");
    expect(col?.label).toBe("Remediate");
  });
});

// ── 3. A remediate ticket lands in the remediate board column + list group ────

describe("ticketColumns — remediate ticket routes to remediate column", () => {
  const remediateTicket = mkTicket("CTL-729", { phase: "remediate", linearState: "Validate" });
  const verifyTicket = mkTicket("CTL-730", { phase: "verify", linearState: "Validate" });

  it("with phase lens, a remediate ticket lands in the 'remediate' column", () => {
    const cols = ticketColumns([remediateTicket, verifyTicket], {
      groupBy: "phase",
      showEmptyColumns: false,
    });
    const remCol = cols.find((c) => c.key === "remediate");
    expect(remCol).toBeTruthy();
    expect(remCol?.items.map((t) => t.id)).toContain("CTL-729");
    // verify ticket stays in verify column, not remediate
    expect(remCol?.items.map((t) => t.id)).not.toContain("CTL-730");
  });

  it("with phase lens, a verify ticket does NOT land in the remediate column", () => {
    const cols = ticketColumns([verifyTicket], {
      groupBy: "phase",
      showEmptyColumns: false,
    });
    const remCol = cols.find((c) => c.key === "remediate");
    // remediate column should be absent (no items + showEmptyColumns=false)
    expect(remCol).toBeUndefined();
  });

  it("with linear lens, a remediate ticket lands in 'Validate' (not a remediate column)", () => {
    const cols = ticketColumns([remediateTicket], {
      groupBy: "linear",
      showEmptyColumns: false,
    });
    const valCol = cols.find((c) => c.key === "Validate");
    expect(valCol?.items.map((t) => t.id)).toContain("CTL-729");
    // no 'remediate' key in linear lens
    expect(cols.find((c) => c.key === "remediate")).toBeUndefined();
  });

  it("showEmptyColumns=true always shows the remediate column (phase lens)", () => {
    const cols = ticketColumns([], {
      groupBy: "phase",
      showEmptyColumns: true,
    });
    expect(cols.map((c) => c.key)).toContain("remediate");
  });
});

// ── 4. REMEDIATE_PHASE constant ───────────────────────────────────────────────

test("REMEDIATE_PHASE export equals 'remediate'", () => {
  expect(REMEDIATE_PHASE).toBe("remediate");
});
