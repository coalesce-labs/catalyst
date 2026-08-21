// recovery-judgment-removed.test.mjs — CTL-2141 Phase 1 guard tests.
//
// CTL-2141 deleted the recovery-pass / board-health JUDGMENT layer: Pass 0r
// (reasoningRecoveryPass, fed by buildRecoveryItems/escalateExhaustedIntents/
// enqueueRecoveryItemDelegate) and the holistic board-health act loop
// (holisticBoardHealthAct, invoked via the `boardHealth.act` seam). Both were
// deactivated at their scheduler.mjs call sites; the MECHANICAL passes (0a
// phantom-sweep, 0w watchdog, 0j stall-janitor, 0u unstuck-sweep,
// reclaimDeadWorkIfPossible) and the shared escalation chokepoint
// (labelNeedsHumanUnlessBeliefOwner) stay.
//
// This is a "refactoring-flavored TDD" guard test (Testing Strategy, plan
// §Testing Strategy): it encodes the DESIRED END STATE — the judgment loops
// are gone, not merely gated — so a future re-introduction of either loop
// (or a routeStuckTicketToDelegate call site creeping back in) fails loudly
// here instead of silently reappearing.
//
// Two complementary techniques, because the loops were DELETED (not just
// flag-gated), so there is no runtime seam left to spy on for Pass 0r:
//   1. A functional test: a real schedulerTick, with a stuck ticket AND an
//      injected `boardHealth.act` spy AND `recoveryPass: { mode: "enforce" }`
//      (both historically the "make the judgment layer run" knobs) — assert
//      the spy is never called and no `.recovery-intents` ledger is written,
//      while the ticket still receives its needs-human label directly.
//   2. Source-scan guards: read the edited files' text and assert the deleted
//      call sites do not exist. This is the same technique the plan's own
//      "no-dangling-import guard" (Phase 2+) and this repo's
//      broker/namespace-parity.test.mjs already use for exactly this reason —
//      a grep-shaped assertion is the only thing that can fail loudly when a
//      whole function body (not just a branch) is the thing under test.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { schedulerTick } from "../scheduler.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXEC_CORE_DIR = join(__dirname, "..");

function readSource(relPath) {
  return readFileSync(join(EXEC_CORE_DIR, relPath), "utf8");
}

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cjr-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "cjr-cat-"));
  process.env.CATALYST_DIR = catalystDir;
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeSignal(ticket, phase, status) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, status }));
}

describe("CTL-2141 Phase 1 — runTick does not invoke the judgment loops", () => {
  test("a stuck ticket still lands needs-human directly; the board-health act seam and the recovery-pass mode are both inert", () => {
    // CTL-764: a terminal (non-terminal-Linear-state, i.e. still-open) stalled
    // ticket is exactly the shape that used to feed BOTH judgment loops (Pass
    // 0r's rSigs filter and the board-health act's candidate cohort).
    writeSignal("CTL-2141-STUCK", "implement", "failed");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));

    const applied = [];
    const boardHealthActSpy = { calls: 0 };
    const recoveryPassInvokeSpy = { calls: 0 };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: ({ ticket, label }) => {
          applied.push({ ticket, label });
          return { applied: true };
        },
        removeLabel: () => ({ removed: false }),
      },
      env: {},
      // Historically the "make the holistic board-health judgment loop run"
      // knob (CTL-1290/CTL-1300). The call site was deleted in this ticket —
      // this act spy must never fire regardless of mode.
      boardHealth: {
        mode: "enforce",
        getBoard: () => ({}),
        act: (...args) => {
          boardHealthActSpy.calls += 1;
          return { dispatched: false };
        },
      },
      // Historically the "make Pass 0r run" knob (CTL-1176). schedulerTick no
      // longer destructures a `recoveryPass` option at all post-deletion — an
      // unused key is harmless, and its presence here proves the option can't
      // resurrect the pass even if a caller still threads it.
      recoveryPass: {
        mode: "enforce",
        invokeRecoveryPass: (...args) => {
          recoveryPassInvokeSpy.calls += 1;
          return { dispatched: true };
        },
      },
    });

    // The board-health holistic act loop never ran.
    expect(boardHealthActSpy.calls).toBe(0);
    // Nothing invoked a recovery-pass dispatch.
    expect(recoveryPassInvokeSpy.calls).toBe(0);
    // No recovery-intent ledger was ever created — Pass 0r's recordIntent
    // write is the thing that would have created this directory.
    expect(existsSync(join(orchDir, ".recovery-intents"))).toBe(false);
    // The stuck ticket still got escalated — via the direct Phase-1
    // chokepoint (labelNeedsHumanUnlessBeliefOwner → labelOnce →
    // writeStatus.applyLabel), not via a delegate/board-health path.
    expect(applied).toContainEqual({ ticket: "CTL-2141-STUCK", label: "needs-human" });
  });
});

describe("CTL-2141 Phase 1 — no-dangling-call guard (judgment loops)", () => {
  // Function-call regex: the identifier immediately followed by "(". This
  // deliberately does NOT match the still-present `import { X } from "..."`
  // lines (Phase 1 explicitly keeps the delegate-first import — Phase 2 drops
  // it once every call site is gone), only actual invocations.
  const callSites = [
    ["reasoningRecoveryPass", "scheduler.mjs"],
    ["buildRecoveryItems", "scheduler.mjs"],
    ["enqueueRecoveryItemDelegate", "scheduler.mjs"],
    ["escalateExhaustedIntents", "scheduler.mjs"],
    ["holisticBoardHealthAct", "scheduler.mjs"],
  ];

  for (const [fn, file] of callSites) {
    test(`${file} contains no ${fn}(...) call`, () => {
      const src = readSource(file);
      const callPattern = new RegExp(`${fn}\\(`);
      expect(callPattern.test(src)).toBe(false);
    });
  }

  test("scheduler.mjs no longer exports holisticBoardHealthAct", () => {
    const src = readSource("scheduler.mjs");
    expect(/export\s+function\s+holisticBoardHealthAct/.test(src)).toBe(false);
  });

  // The six CTL-1609 escalation sites (scheduler.mjs ×4, monitor.mjs,
  // stale-pr-rescue-timer.mjs) — Phase 1 reverted every CALL to
  // routeStuckTicketToDelegate(...); Phase 2 (delegate cluster deletion)
  // then dropped the now-fully-dead import in all three files too.
  const sixSiteFiles = ["scheduler.mjs", "monitor.mjs", "stale-pr-rescue-timer.mjs"];
  for (const file of sixSiteFiles) {
    test(`${file} contains no routeStuckTicketToDelegate(...) call or import`, () => {
      const src = readSource(file);
      expect(/routeStuckTicketToDelegate\(/.test(src)).toBe(false);
      expect(/import\s*\{\s*routeStuckTicketToDelegate\s*\}/.test(src)).toBe(false);
    });
  }
});
