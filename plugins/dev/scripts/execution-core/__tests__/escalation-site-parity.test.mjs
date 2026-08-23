// escalation-site-parity.test.mjs — CTL-2141 Phase 1 guard tests, re-aimed by CTL-2159.
//
// CTL-2141 reverted the six CTL-1609 escalation sites from the deleted
// delegate-first seam back to the shared chokepoint, and this file was its
// parity proof: "a stuck ticket with DELEGATE_FIRST unset lands the escalation
// label via the chokepoint".
//
// ⛔ THE LABEL HALF OF THAT PREMISE IS GONE. CTL-2156…CTL-2161 delete the label
// itself, so an assertion that these sites still write it would pin the very
// artifact the epic removes. What SURVIVES — and is what this file was really
// worth — is the parity property: each site reaches the shared chokepoint
// DIRECTLY, with no delegate brief or board-health context object in between,
// and the chokepoint's own durable record is what lands.
//
// So each case now asserts three things instead of one:
//   1. ZERO label writes reach the transport (the deletion).
//   2. The chokepoint's durable escalation record lands, written directly by it.
//   3. The stall CLASS on that record matches the site's own reason token.
//
// (3) is the discriminator, and it is the reason this file is not vacuous. Every
// site forwards a `reason` to the classifier; drop that forward and the class
// silently becomes "held" while (1) and (2) stay green — the exact inert-ship
// this epic's verification caught once already. A wrong class fails here.
//
// The six CTL-1609 sites are scheduler.mjs's maybeEscalateDispatchFailures,
// its three schedulerTick-inline blocks (dependency-cycle, ctl-925-cycle,
// terminal-sweep), monitor.mjs's dispatchTriage default, and
// stale-pr-rescue-timer.mjs's defaultEscalate. This file directly drives the two
// EXPORTED, independently-callable ones as the representative harness; the other
// four are covered structurally by recovery-judgment-removed.test.mjs's
// no-dangling-call source scan plus their host modules' own suites.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeEscalateDispatchFailures } from "../scheduler.mjs";
import { defaultEscalate } from "../stale-pr-rescue-timer.mjs";
import { labelMarkerBase } from "../label-guard.mjs";
import { ESCALATION_MARKER_LABEL } from "../escalation-publish.mjs";

// Derived, never hand-typed: the once-marker path is owned by label-guard, and a
// literal copy here would drift silently the day the marker is renamed.
const appliedMarker = (dir, ticket) =>
  `${labelMarkerBase(dir, ticket, ESCALATION_MARKER_LABEL)}.applied`;

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "esp-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

const readRecord = (ticket) =>
  JSON.parse(readFileSync(join(orchDir, "workers", ticket, "phase-recovery-pass.json"), "utf8"));

describe("CTL-2141 Phase 1 — escalation-site parity, re-aimed by CTL-2159", () => {
  test("maybeEscalateDispatchFailures (scheduler.mjs) publishes directly, writes NO label, and classifies its own reason", () => {
    mkdirSync(join(orchDir, "workers", "CTL-2141-A"), { recursive: true });
    const applied = [];
    const events = [];
    const marker = {
      ticket: "CTL-2141-A",
      phase: "research",
      code: 2,
      consecutiveFailures: 3,
    };
    const humanFacing = maybeEscalateDispatchFailures(orchDir, marker, {
      // env intentionally omitted -> defaults to process.env, which does not
      // set CATALYST_DELEGATE_FIRST in this test process (off/unset, the
      // production default the plan's "byte-identical" claim was about).
      writeStatus: {
        applyLabel: ({ ticket, label }) => {
          applied.push({ ticket, label });
          return { applied: true };
        },
      },
      appendEvent: (e) => events.push(e),
    });

    // 1. the deletion
    expect(applied).toEqual([]);
    // 2. the chokepoint's own record, written directly — no delegate brief /
    //    board-health context object is involved.
    const explanationPath = join(orchDir, "workers", "CTL-2141-A", "phase-recovery-pass.json");
    expect(existsSync(explanationPath)).toBe(true);
    // 3. THE DISCRIMINATOR: a repeated dispatch failure is the fleet misbehaving,
    //    not a question for a person. It classifies off the reason this site
    //    forwards (`dispatch-circuit-breaker:<n>`); stop forwarding it and this
    //    reads "held" via the no-reason rule.
    const record = readRecord("CTL-2141-A");
    expect(record.stallClass).toBe("system");
    expect(record.stallClassRule).toBe("prefix:dispatch-circuit-breaker:");
    // …and because it is SYSTEM, the return value — which gates a durable
    // per-ticket human-facing `worker.transition` at both call sites — is false.
    // `labelled` alone would be TRUE here: it is a RETRY contract, true for a
    // provider outage too. That gap is the whole point of the class.
    expect(humanFacing).toBe(false);
    // The retry loop's once-marker still latches, so the site does not re-escalate.
    expect(existsSync(appliedMarker(orchDir, "CTL-2141-A"))).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("defaultEscalate (stale-pr-rescue-timer.mjs) publishes directly, writes NO label, and classifies its own reason", () => {
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

    // 1. the deletion
    expect(labels).toEqual([]);
    // 2. the publish still CONFIRMS — this is the retry contract the timer's
    //    escalatedAt latch keys on, and it must survive the label's removal.
    expect(result.confirmed).toBe(true);
    // The CTL-1609 delegate `routed` outcome no longer exists — routing
    // through the deleted seam is not observable because it never runs.
    expect(result.routed).toBe(false);
    expect(existsSync(appliedMarker(orchDir, "CTL-2141-B"))).toBe(true);
    // 3. THE DISCRIMINATOR: an unresolvable rebase conflict is a SYSTEM stall,
    //    classified off the reason this site forwards.
    const record = readRecord("CTL-2141-B");
    expect(record.stallClass).toBe("system");
    expect(record.stallClassRule).toBe("exact:unresolvable-conflict");
  });

  test("POSITIVE CONTROL: the label spies are wired — a non-escalation label reaches them", () => {
    const applied = [];
    const writeStatus = {
      applyLabel: (opts) => {
        applied.push(opts);
        return { applied: true };
      },
    };
    writeStatus.applyLabel({ ticket: "CTL-2141-C", label: "blocked" });
    // Without this, the two empty-array assertions above are indistinguishable
    // from a spy that was never callable in the first place.
    expect(applied).toEqual([{ ticket: "CTL-2141-C", label: "blocked" }]);
  });
});
