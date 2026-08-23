// escalation-site-parity.test.mjs — CTL-2141 Phase 1 guard tests.
//
// Plan §Phase 1 "Tests First (Red)" #2: "For each of the six sites (or a
// representative harness), a stuck ticket with DELEGATE_FIRST unset lands a
// needs-human label via labelNeedsHumanUnlessBeliefOwner. Asserts the
// reverted direct call preserves today's off-mode outcome."
//
// The six CTL-1609 sites are scheduler.mjs:3324 (maybeEscalateDispatchFailures),
// scheduler.mjs:7382/8436/9158 (dependency-cycle, ctl-925-cycle, terminal-sweep —
// all inline blocks inside the un-exported schedulerTick closure), monitor.mjs:1101
// (dispatchTriage's un-exported labelNeedsHuman default), and
// stale-pr-rescue-timer.mjs:475 (defaultEscalate). This file directly drives the
// two EXPORTED, independently-callable sites — maybeEscalateDispatchFailures and
// defaultEscalate — as the representative harness: both are exercised through
// their real production entry point with no internal seam substituted, so a
// regression in the labelNeedsHumanUnlessBeliefOwner rewire fails here.
//
// The other four sites (three schedulerTick-inline blocks + monitor.mjs's
// dispatchTriage default) are covered structurally by
// recovery-judgment-removed.test.mjs's no-dangling-call source scan (proving
// routeStuckTicketToDelegate is gone from all three files) plus their host
// modules' own full test suites (scheduler.test.mjs, monitor.test.mjs), which
// stay green after the revert.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeEscalateDispatchFailures } from "../scheduler.mjs";
import { defaultEscalate } from "../stale-pr-rescue-timer.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "esp-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

describe("CTL-2141 Phase 1 — escalation-site parity (DELEGATE_FIRST unset)", () => {
  test("maybeEscalateDispatchFailures (scheduler.mjs) labels needs-human directly, with no delegate/board-health trace", () => {
    mkdirSync(join(orchDir, "workers", "CTL-2141-A"), { recursive: true });
    const applied = [];
    const events = [];
    const marker = {
      ticket: "CTL-2141-A",
      phase: "research",
      code: 2,
      consecutiveFailures: 3,
    };
    const wrote = maybeEscalateDispatchFailures(orchDir, marker, {
      // env intentionally omitted -> defaults to process.env, which does not
      // set CATALYST_DELEGATE_FIRST in this test process (off/unset, the
      // production default the plan's "byte-identical" claim is about).
      writeStatus: {
        applyLabel: ({ ticket, label }) => {
          applied.push({ ticket, label });
          return { applied: true };
        },
      },
      appendEvent: (e) => events.push(e),
    });

    expect(wrote).toBe(true);
    expect(applied).toEqual([{ ticket: "CTL-2141-A", label: "needs-human" }]);
    // The explanation signal is written by labelNeedsHumanUnlessBeliefOwner's
    // Gap-2 chokepoint (escalation-explanation.mjs) directly — no delegate
    // brief / board-health context object is involved.
    const explanationPath = join(orchDir, "workers", "CTL-2141-A", "phase-recovery-pass.json");
    expect(existsSync(explanationPath)).toBe(true);
    const explanation = JSON.parse(readFileSync(explanationPath, "utf8"));
    expect(explanation.status).toBe("needs-human");
  });

  test("defaultEscalate (stale-pr-rescue-timer.mjs) labels needs-human directly via linearWrite.applyLabel", () => {
    // labelOnce's marker write assumes workers/<ticket>/ already exists (true
    // in production — dispatch always creates it first); the isolated unit
    // harness must create it explicitly.
    mkdirSync(join(orchDir, "workers", "CTL-2141-B"), { recursive: true });
    const labels = [];
    const events = [];
    const result = defaultEscalate(
      "CTL-2141-B",
      { prNumber: 999, reason: "unresolvable-conflict" },
      {
        orchDir,
        linearWrite: {
          applyLabel: (opts) => {
            labels.push(opts);
            return { applied: true };
          },
        },
        multiHost: false,
        env: {},
        appendStandoffEvent: (payload) => {
          events.push(payload);
          return true;
        },
      }
    );

    expect(labels).toEqual([{ ticket: "CTL-2141-B", label: "needs-human" }]);
    expect(result.confirmed).toBe(true);
    // The CTL-1609 delegate `routed` outcome no longer exists — routing
    // through the deleted seam is not observable because it never runs.
    expect(result.routed).toBe(false);
    expect(
      existsSync(
        join(orchDir, "workers", "CTL-2141-B", ".linear-label-needs-human.applied")
      )
    ).toBe(true);
  });
});
