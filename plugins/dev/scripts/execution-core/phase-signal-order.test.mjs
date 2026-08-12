// phase-signal-order.test.mjs — CAT-259.
//
// Pins readPhaseSignals' key order, which livePhaseEntries reads as dispatch
// recency. Before CAT-259 the sort keyed on mtimeMs alone, so two signals written
// inside one Linux timer tick (identical mtimeMs) fell back to readdirSync order.
// CI-INCLUDED (registered in .github/workflows/execution-core-tests.yml).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPhaseSignals, livePhaseEntries, deriveAdvancement } from "./scheduler.mjs";

const TICKET = "CTL-5555";
let orchDir;
let workerDir;

function seed(phase, status, mtimeSec) {
  const p = join(workerDir, `phase-${phase}.json`);
  writeFileSync(p, JSON.stringify({ status }));
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cat259-signal-order-"));
  workerDir = join(orchDir, "workers", TICKET);
  mkdirSync(workerDir, { recursive: true });
});
afterEach(() => { try { rmSync(orchDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("readPhaseSignals — key order is total, not filesystem-dependent", () => {
  test("EXACT mtime tie → ordinally-later phase is inserted last (the dispatch the FSM keys off)", () => {
    seed("verify", "done", 1_700_000_000);
    seed("implement", "done", 1_700_000_000);
    const signals = readPhaseSignals(orchDir, TICKET);
    expect(Object.keys(signals)).toEqual(["implement", "verify"]);
    expect(livePhaseEntries(signals).map(([p]) => p)).toEqual(["verify"]);
    expect(deriveAdvancement(signals, { verifyVerdict: "fail", remediateCycleCount: 0 }))
      .toBe("remediate");
    expect(deriveAdvancement(signals, { verifyVerdict: "pass", remediateCycleCount: 0 }))
      .toBe("review");
  });

  test("DISTINCT mtimes still decide: a newer earlier-ordinal phase supersedes an older later one", () => {
    seed("review", "failed", 1_700_000_000);
    seed("implement", "running", 1_700_000_060);
    const signals = readPhaseSignals(orchDir, TICKET);
    expect(Object.keys(signals)).toEqual(["review", "implement"]);
    expect(livePhaseEntries(signals).map(([p]) => p)).toEqual(["implement"]);
  });

  test("a tie involving an UNKNOWN phase does not throw and does not claim latest dispatch", () => {
    seed("recovery-pass", "done", 1_700_000_000);
    seed("implement", "done", 1_700_000_000);
    const signals = readPhaseSignals(orchDir, TICKET);
    expect(Object.keys(signals)).toEqual(["recovery-pass", "implement"]);
    expect(livePhaseEntries(signals).map(([p]) => p).sort())
      .toEqual(["implement", "recovery-pass"].sort());
  });

  test("full pipeline tie → the ordinally-last phase wins", () => {
    for (const p of ["verify", "triage", "implement", "plan", "research"]) {
      seed(p, "done", 1_700_000_000);
    }
    const signals = readPhaseSignals(orchDir, TICKET);
    expect(Object.keys(signals))
      .toEqual(["triage", "research", "plan", "implement", "verify"]);
  });
});
