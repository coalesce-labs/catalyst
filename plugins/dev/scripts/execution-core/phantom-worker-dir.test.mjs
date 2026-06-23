// phantom-worker-dir.test.mjs — CTL-1323. A board-health recovery-pass leaves a
// worker dir whose only signal is `phase-recovery-pass.json:done`; bare directory
// existence (listStartedTickets) then strands the ticket from the new-work pull
// forever, and isTicketInFlight counts it as occupying a slot — so the ticket sits
// in Todo with no live worker (the live ADV-1398/1400/1306 wedge). These tests pin
// the phantom-dir fix that lets such a ticket be re-pulled fresh.
//
// CI-INCLUDED (registered in .github/workflows/execution-core-tests.yml). The
// scheduler.test.mjs real-timer suite is excluded from CI, so the wedge coverage
// lives here over the pure exported helpers — the CTL-1290 board-health-seam pattern.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phantom-worker-dir.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPhantomWorkerDir,
  listStartedTickets,
  listInFlightTickets,
  buildGlobalRanking,
} from "./scheduler.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1323-phantom-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// Seed workers/<ticket>/phase-<phase>.json = { status } (the readPhaseSignals shape).
function seedSignal(ticket, phase, status) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ status }));
}

describe("isPhantomWorkerDir (CTL-1323)", () => {
  test("a completed recovery-pass-only dir is phantom", () => {
    expect(isPhantomWorkerDir({ "recovery-pass": "done" })).toBe(true);
  });

  test("'complete' / 'skipped' terminal-success recovery-pass dirs are also phantom", () => {
    expect(isPhantomWorkerDir({ "recovery-pass": "complete" })).toBe(true);
    expect(isPhantomWorkerDir({ "recovery-pass": "skipped" })).toBe(true);
  });

  test("an ACTIVE recovery-pass (dispatched/running) is NOT phantom — it holds a real slot", () => {
    expect(isPhantomWorkerDir({ "recovery-pass": "running" })).toBe(false);
    expect(isPhantomWorkerDir({ "recovery-pass": "dispatched" })).toBe(false);
  });

  test("a PARKED / ESCALATED / PREEMPTED / FAILED recovery-pass is NOT phantom — never re-pulled", () => {
    // These statuses surface a pending operator decision (needs-human / Needs-You) or
    // are resumable (preempted) or hold the slot — re-pulling them would bury that state.
    for (const status of ["needs-human", "needs-input", "turn-cap-exhausted", "preempted", "failed", "stalled", "aborted"]) {
      expect(isPhantomWorkerDir({ "recovery-pass": status })).toBe(false);
    }
  });

  test("ANY real pipeline signal makes it NOT phantom — even a terminal one beside a recovery-pass", () => {
    expect(isPhantomWorkerDir({ implement: "running" })).toBe(false);
    expect(isPhantomWorkerDir({ research: "done" })).toBe(false);
    expect(isPhantomWorkerDir({ "recovery-pass": "done", implement: "failed" })).toBe(false);
    expect(isPhantomWorkerDir({ "recovery-pass": "done", "monitor-deploy": "done" })).toBe(false);
  });

  test("an ancillary phase (remediate) is real pipeline work, not phantom", () => {
    expect(isPhantomWorkerDir({ remediate: "done" })).toBe(false);
  });

  test("an empty / nullish signal set is NOT phantom (conservative)", () => {
    expect(isPhantomWorkerDir({})).toBe(false);
    expect(isPhantomWorkerDir(null)).toBe(false);
    expect(isPhantomWorkerDir(undefined)).toBe(false);
  });
});

describe("listStartedTickets / listInFlightTickets ignore phantom dirs (CTL-1323)", () => {
  test("a recovery-pass-done dir is NEITHER started nor in-flight", () => {
    seedSignal("ADV-1398", "recovery-pass", "done");
    expect(listStartedTickets(orchDir).has("ADV-1398")).toBe(false);
    expect(listInFlightTickets(orchDir).has("ADV-1398")).toBe(false);
  });

  test("a real in-flight dir is BOTH started and in-flight (regression guard)", () => {
    seedSignal("CTL-1", "implement", "running");
    expect(listStartedTickets(orchDir).has("CTL-1")).toBe(true);
    expect(listInFlightTickets(orchDir).has("CTL-1")).toBe(true);
  });

  test("an ACTIVE recovery-pass dir is still counted — no premature re-pull/double-dispatch", () => {
    seedSignal("ADV-9", "recovery-pass", "running");
    expect(listStartedTickets(orchDir).has("ADV-9")).toBe(true);
  });

  test("a needs-human ESCALATED recovery-pass dir is still started (held, not re-pulled)", () => {
    seedSignal("ADV-esc", "recovery-pass", "needs-human");
    expect(listStartedTickets(orchDir).has("ADV-esc")).toBe(true);
  });

  test("an empty worker dir (no phase signals yet) is started but NOT in-flight — conservative, not re-pulled", () => {
    mkdirSync(join(orchDir, "workers", "CTL-fresh"), { recursive: true });
    expect(listStartedTickets(orchDir).has("CTL-fresh")).toBe(true);
    expect(listInFlightTickets(orchDir).has("CTL-fresh")).toBe(false);
  });
});

describe("buildGlobalRanking re-pulls a phantom-wedged eligible ticket (CTL-1323)", () => {
  test("ADV-1398 (recovery-pass:done) eligible → exactly ONE fresh new-work descriptor (no dup)", () => {
    seedSignal("ADV-1398", "recovery-pass", "done");
    const eligible = [{ identifier: "ADV-1398", priority: 2, createdAt: "2026-06-23T10:00:00Z" }];
    const ranking = buildGlobalRanking(orchDir, eligible);
    const adv = ranking.filter((d) => d.identifier === "ADV-1398");
    expect(adv).toHaveLength(1); // not double-listed as in-flight AND eligible
    expect(adv[0].inFlight).toBe(false); // re-pulled as FRESH new work — the unstick
  });

  test("a real in-flight ticket stays EXCLUDED from the new-work pull", () => {
    seedSignal("CTL-7", "implement", "running");
    const eligible = [{ identifier: "CTL-7", priority: 2, createdAt: "2026-06-23T10:00:00Z" }];
    const ranking = buildGlobalRanking(orchDir, eligible);
    const c7 = ranking.filter((d) => d.identifier === "CTL-7");
    expect(c7).toHaveLength(1);
    expect(c7[0].inFlight).toBe(true); // listed as in-flight, NOT re-pulled as new work
  });

  test("an ACTIVE recovery-pass:running eligible ticket is held (inFlight:true), not re-pulled", () => {
    seedSignal("ADV-run", "recovery-pass", "running");
    const eligible = [{ identifier: "ADV-run", priority: 2, createdAt: "2026-06-23T10:00:00Z" }];
    const adv = buildGlobalRanking(orchDir, eligible).filter((d) => d.identifier === "ADV-run");
    expect(adv).toHaveLength(1);
    expect(adv[0].inFlight).toBe(true);
  });

  test("a needs-human ESCALATED recovery-pass eligible ticket is held (inFlight:true), NOT re-pulled — escalation preserved", () => {
    seedSignal("ADV-esc", "recovery-pass", "needs-human");
    const eligible = [{ identifier: "ADV-esc", priority: 2, createdAt: "2026-06-23T10:00:00Z" }];
    const adv = buildGlobalRanking(orchDir, eligible).filter((d) => d.identifier === "ADV-esc");
    expect(adv).toHaveLength(1);
    expect(adv[0].inFlight).toBe(true); // the pending Needs-You signal is not buried by a fresh re-pull
  });
});
