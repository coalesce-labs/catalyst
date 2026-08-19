// stale-needs-human-sweep.test.mjs — CTL-1871 Phase 4 tests.
import { describe, test, expect } from "bun:test";
import {
  classifyStaleNeedsHuman,
  sweepStaleNeedsHuman,
  readSweepMode,
  buildDefectComment,
  STALE_LABEL,
  STALE_SWEEP_EVENT,
} from "./stale-needs-human-sweep.mjs";
import { formatAskComment } from "../execution-core/needs-human-ask.mjs";
import { DEFAULT_IF_SILENT } from "../execution-core/escalation-explanation.mjs";

// ─── classifyStaleNeedsHuman (pure) ─────────────────────────────────────────

const ASK_COMMENT = formatAskComment({
  call_to_action: "Authorize retry or cancel the ticket.",
  default_if_silent: DEFAULT_IF_SILENT,
});

function active(labels = ["needs-human"], comments = []) {
  return { ticket: "CTL-1", state: "in_progress", labels, comments };
}

describe("classifyStaleNeedsHuman", () => {
  test("terminal ticket → flag:false (terminal)", () => {
    const r = classifyStaleNeedsHuman({ ticket: "CTL-1", state: "done", labels: ["needs-human"], comments: [] });
    expect(r.flag).toBe(false);
    expect(r.reason).toBe("terminal");
  });

  test("no needs-human label → flag:false", () => {
    const r = classifyStaleNeedsHuman(active(["in-progress"]));
    expect(r.flag).toBe(false);
    expect(r.reason).toBe("no-needs-human");
  });

  test("already carries stale-needs-human → flag:false (already-flagged)", () => {
    const r = classifyStaleNeedsHuman(active(["needs-human", "stale-needs-human"]));
    expect(r.flag).toBe(false);
    expect(r.reason).toBe("already-flagged");
  });

  test("needs-human + has valid ASK comment → flag:false (has-ask) [named negative control]", () => {
    const r = classifyStaleNeedsHuman(active(["needs-human"], [{ body: ASK_COMMENT }]));
    expect(r.flag).toBe(false);
    expect(r.reason).toBe("has-ask");
  });

  test("needs-human + non-ASK comment → flag:true", () => {
    const r = classifyStaleNeedsHuman(active(["needs-human"], [{ body: "Just a regular comment." }]));
    expect(r.flag).toBe(true);
  });

  test("needs-human + no comments at all → flag:true", () => {
    const r = classifyStaleNeedsHuman(active(["needs-human"], []));
    expect(r.flag).toBe(true);
  });

  test("needs-human + mixed comments (one ASK, one plain) → flag:false (has-ask)", () => {
    const r = classifyStaleNeedsHuman(active(["needs-human"], [
      { body: "A plain comment." },
      { body: ASK_COMMENT },
    ]));
    expect(r.flag).toBe(false);
  });

  test("null descriptor → flag:false (no-needs-human)", () => {
    const r = classifyStaleNeedsHuman(null);
    expect(r.flag).toBe(false);
  });

  test("undefined comments treated as empty array", () => {
    const r = classifyStaleNeedsHuman({ ticket: "CTL-2", state: "todo", labels: ["needs-human"] });
    expect(r.flag).toBe(true);
  });
});

// ─── readSweepMode ───────────────────────────────────────────────────────────

describe("readSweepMode", () => {
  test("defaults to shadow when env is unset", () => {
    expect(readSweepMode({})).toBe("shadow");
  });
  test("off is accepted", () => {
    expect(readSweepMode({ CATALYST_STALE_NEEDS_HUMAN_SWEEP: "off" })).toBe("off");
  });
  test("enforce is accepted", () => {
    expect(readSweepMode({ CATALYST_STALE_NEEDS_HUMAN_SWEEP: "enforce" })).toBe("enforce");
  });
  test("unknown value → shadow", () => {
    expect(readSweepMode({ CATALYST_STALE_NEEDS_HUMAN_SWEEP: "bogus" })).toBe("shadow");
  });
});

// ─── STALE_SWEEP_EVENT constant ──────────────────────────────────────────────

describe("constants", () => {
  test("STALE_LABEL is stale-needs-human", () => {
    expect(STALE_LABEL).toBe("stale-needs-human");
  });
  test("STALE_SWEEP_EVENT matches expected broker name", () => {
    expect(STALE_SWEEP_EVENT).toBe("broker.stale-needs-human.swept");
  });
});

// ─── buildDefectComment ──────────────────────────────────────────────────────

describe("buildDefectComment", () => {
  test("returns a non-empty string", () => {
    const body = buildDefectComment();
    expect(typeof body).toBe("string");
    expect(body.trim()).not.toBe("");
  });

  test("contains the ASK template line", () => {
    const body = buildDefectComment();
    expect(body).toContain("ASK (Ryan):");
    expect(body).toContain("default if silent:");
  });

  test("mentions stale-needs-human", () => {
    expect(buildDefectComment()).toContain("stale-needs-human");
  });
});

// ─── sweepStaleNeedsHuman ────────────────────────────────────────────────────

describe("sweepStaleNeedsHuman", () => {
  const staleDescriptor = {
    ticket: "CTL-S1",
    state: "in_progress",
    labels: ["needs-human"],
    comments: [],
  };
  const freshDescriptor = {
    ticket: "CTL-S2",
    state: "in_progress",
    labels: ["needs-human"],
    comments: [{ body: ASK_COMMENT }],
  };

  test("off mode — returns immediately, touches nothing", () => {
    let getCallCount = 0;
    const result = sweepStaleNeedsHuman({
      getCandidates: () => { getCallCount++; return [staleDescriptor]; },
      mode: "off",
    });
    expect(result.mode).toBe("off");
    expect(result.scanned).toBe(0);
    expect(result.flagged).toBe(0);
    expect(getCallCount).toBe(0);
  });

  test("shadow mode — counts stale but does NOT call applyLabel or postComment", () => {
    let applyCount = 0;
    const result = sweepStaleNeedsHuman({
      getCandidates: () => [staleDescriptor, freshDescriptor],
      applyLabel: () => { applyCount++; return { applied: true }; },
      postComment: () => { applyCount++; return { status: 0 }; },
      mode: "shadow",
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.mode).toBe("shadow");
    expect(result.scanned).toBe(2);
    expect(result.flagged).toBe(1); // only staleDescriptor is stale
    expect(applyCount).toBe(0);
  });

  test("enforce mode — calls applyLabel + postComment for stale tickets", () => {
    const applied = [];
    const posted = [];
    const result = sweepStaleNeedsHuman({
      getCandidates: () => [staleDescriptor, freshDescriptor],
      applyLabel: (t, l) => { applied.push({ t, l }); return { applied: true }; },
      postComment: (t, body) => { posted.push({ t, body }); return { status: 0 }; },
      mode: "enforce",
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.scanned).toBe(2);
    expect(result.flagged).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0].t).toBe("CTL-S1");
    expect(applied[0].l).toBe("stale-needs-human");
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain("stale-needs-human");
  });

  test("fresh ticket (has ASK comment) is NOT flagged — named negative control", () => {
    const applied = [];
    sweepStaleNeedsHuman({
      getCandidates: () => [freshDescriptor],
      applyLabel: (t) => { applied.push(t); return { applied: true }; },
      mode: "enforce",
      log: { info: () => {}, warn: () => {} },
    });
    expect(applied).toHaveLength(0);
  });

  test("enforce mode — applyLabel failure logs warn, does not count as flagged", () => {
    const warned = [];
    const result = sweepStaleNeedsHuman({
      getCandidates: () => [staleDescriptor],
      applyLabel: () => { throw new Error("network"); },
      postComment: () => { throw new Error("network"); },
      mode: "enforce",
      log: { info: () => {}, warn: (...args) => warned.push(args) },
    });
    expect(result.flagged).toBe(0);
    expect(warned.length).toBeGreaterThan(0);
  });

  test("emit is called when flagged > 0 (enforce)", () => {
    const emitted = [];
    sweepStaleNeedsHuman({
      getCandidates: () => [staleDescriptor],
      applyLabel: () => ({ applied: true }),
      postComment: () => ({ status: 0 }),
      emit: (s) => emitted.push(s),
      mode: "enforce",
      log: { info: () => {}, warn: () => {} },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].flagged).toBe(1);
  });

  test("emit NOT called when nothing is flagged", () => {
    const emitted = [];
    sweepStaleNeedsHuman({
      getCandidates: () => [freshDescriptor],
      emit: (s) => emitted.push(s),
      mode: "enforce",
      log: { info: () => {}, warn: () => {} },
    });
    expect(emitted).toHaveLength(0);
  });

  test("getCandidates failure → returns empty summary, does not throw", () => {
    const result = sweepStaleNeedsHuman({
      getCandidates: () => { throw new Error("db error"); },
      mode: "enforce",
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.scanned).toBe(0);
    expect(result.flagged).toBe(0);
  });
});
