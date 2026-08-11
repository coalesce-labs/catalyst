// Cross-producer namespace parity test (CTL-1142).
// Asserts that exec-core producer event names never collide with the broker's
// protected namespace, and that any phase-slot in a phase.*.* event is either
// a KNOWN_PHASES entry or a documented exception.
//
// Run: bun test plugins/dev/scripts/broker/namespace-parity.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_PHASES,
  isBrokerProtectedName,
  phaseSlotOf,
  isAllowedPhaseSlot,
  PHASE_EVENT_PATTERN,
} from "./namespace-contract.mjs";

// Resolve exec-core directory relative to this test file.
const EC_DIR = join(fileURLToPath(import.meta.url), "../../execution-core");

// ── Static-constant producers ────────────────────────────────────────────────
// Import exported event-name constants from each exec-core event module and
// verify: (a) none are broker-protected; (b) any that match PHASE_EVENT_PATTERN
// use an allowed phase slot. Extend the list below when a new *-event.mjs is added.

import { HEARTBEAT_EVENT } from "../execution-core/heartbeat-event.mjs";
import {
  DRAIN_CHANGED_EVENT,
  DRAINED_EVENT,
} from "../execution-core/drain-event.mjs";
import {
  FLEET_HEALTH_DEGRADED,
  FLEET_HEALTH_RECOVERED,
} from "../execution-core/fleet-health-event.mjs";
import {
  RATELIMIT_EVENT_SAMPLED,
} from "../execution-core/ratelimit-event.mjs";
import {
  MEMORY_EVENT_SAMPLED,
  MEMORY_EVENT_WARN,
  MEMORY_EVENT_KILLED,
} from "../execution-core/memory-event.mjs";
import { JANITOR_EVENT_TYPES } from "../execution-core/janitor-event-types.mjs";
import { UNSTUCK_SWEEP_EVENT_TYPES } from "../execution-core/unstuck-sweep-event-types.mjs";
import { LINEAR_READ_EVENT } from "../execution-core/linear-read-event.mjs"; // CTL-1403
import { ALERT_BOOT_DEPENDENCY_UNUSABLE } from "../execution-core/dispatch-alert.mjs";

// Inline names that don't have a dedicated exported constant; verified against
// the source file they appear in.
const INLINE_EVENT_NAMES = [
  "node.boot",                        // boot-event.mjs:32
  "monitor.reconcile.failing.team",   // reconcile-health-event.mjs:66 (team is param; prefix is safe)
  "monitor.reconcile.recovered.team", // reconcile-health-event.mjs:66
  "monitor.reconcile.eligible_persist_failure.team", // reconcile-health-event.mjs (CTL-1628 persist-write escalation)
  "monitor.replica.degraded.team", // replica-health-event.mjs (CAT-35)
  "monitor.replica.recovered.team", // replica-health-event.mjs (CAT-35)
  "phase.triage.linear-transition.CTL-1", // triage-transition-event.mjs:53
  "triage.redispatch.capped.CTL-1", // triage-cap-event.mjs
  "linear.state.write.CTL-1",         // linear-state-write-event.mjs:77
  "agent.waiting_on_user",            // wait-event.mjs:buildWaitEnvelope
  "agent.resumed",                    // wait-event.mjs:buildWaitEnvelope
  "fence.claimed.CTL-1",              // CTL-863 fence-event.mjs (exec-core-owned, projected-not-re-emitted)
  "fence.released.CTL-1",             // CTL-863 fence-event.mjs
  "escalation.explanation-absent",    // CTL-1609 label-guard.mjs (warn when explanation omitted)
  "delegate.would-route",             // CTL-1609 delegate-first.mjs (shadow mode — would enqueue)
  "delegate.routed",                  // CTL-1609 delegate-first.mjs (enforce mode — enqueued ok)
  "delegate.route-fallback",          // CTL-1609 delegate-first.mjs (enforce mode — queue full / failed)
  "catalyst.replica.writer_idle",     // CAT-21 cloud-sync.mjs (tokenless writer provisioning gap)
];

// Build the flat list of all static exec-core event names.
const EXEC_CORE_EVENT_NAMES = [
  HEARTBEAT_EVENT,
  DRAIN_CHANGED_EVENT,
  DRAINED_EVENT,
  FLEET_HEALTH_DEGRADED,
  FLEET_HEALTH_RECOVERED, // CTL-1503 — degraded→healthy edge event
  RATELIMIT_EVENT_SAMPLED,
  MEMORY_EVENT_SAMPLED,
  MEMORY_EVENT_WARN,
  MEMORY_EVENT_KILLED,
  ...JANITOR_EVENT_TYPES,
  ...UNSTUCK_SWEEP_EVENT_TYPES,
  LINEAR_READ_EVENT, // CTL-1403 reads-by-source (catalyst.linear.read)
  ALERT_BOOT_DEPENDENCY_UNUSABLE,
  ...INLINE_EVENT_NAMES,
];

describe("exec-core static event names", () => {
  test("none collide with the broker-protected namespace", () => {
    for (const name of EXEC_CORE_EVENT_NAMES) {
      expect(
        isBrokerProtectedName(name),
        `exec-core event "${name}" collides with the broker-protected namespace`
      ).toBe(false);
    }
  });

  test("any phase-pattern match uses an allowed phase slot", () => {
    for (const name of EXEC_CORE_EVENT_NAMES) {
      const slot = phaseSlotOf(name);
      if (slot !== null) {
        expect(
          isAllowedPhaseSlot(slot),
          `exec-core event "${name}" has phase slot "${slot}" not in KNOWN_PHASES or exceptions`
        ).toBe(true);
      }
    }
  });
});

// ── Dynamic phase-slot producers: recovery.mjs ───────────────────────────────
// recovery.mjs builds names as `phase.${phase}.${action}.${ticket}`.
// Most callers pass a runtime ticket phase (always a real pipeline phase).
// Two sites hardcode the phase literal ("dispatch"). Scan the source to find
// every hardcoded literal and assert:
//   (a) each is allowed (isAllowedPhaseSlot)
//   (b) the set of hardcoded literals equals exactly {"dispatch"} — a snapshot
//       that fails loudly if a future emitter introduces a new hardcoded slot.

describe("recovery.mjs dynamic phase-slot producers", () => {
  const recoverySource = readFileSync(join(EC_DIR, "recovery.mjs"), "utf8");

  // Regex captures the literal string in buildEventEnvelope({ ..., phase: "literal", ... }).
  // Runtime-passed `phase` params are identifiers (no quotes), so this regex only
  // matches literal strings — exactly what we want.
  const HARDCODED_SLOT_RE = /buildEventEnvelope\(\{[^}]*?phase:\s*["']([^"']+)["']/gs;

  const hardcodedSlots = new Set();
  for (const m of recoverySource.matchAll(HARDCODED_SLOT_RE)) {
    hardcodedSlots.add(m[1]);
  }

  test("all hardcoded phase slots are allowed", () => {
    for (const slot of hardcodedSlots) {
      expect(
        isAllowedPhaseSlot(slot),
        `recovery.mjs hardcoded phase slot "${slot}" is not in KNOWN_PHASES or exceptions`
      ).toBe(true);
    }
  });

  test('hardcoded phase-slot set equals exactly {"advance","dispatch","scheduler"}', () => {
    // Snapshot guard: fails loudly if a future emitter adds a new hardcoded slot.
    // When that happens: review the new slot, then add it to KNOWN_PHASES or
    // INTENTIONAL_PHASE_SLOT_EXCEPTIONS in namespace-contract.mjs.
    expect([...hardcodedSlots].sort()).toEqual(["advance", "dispatch", "scheduler"]);
  });

  test("phase.dispatch.failed is the only hardcoded slot that matches PHASE_EVENT_PATTERN with a non-KNOWN_PHASES slot", () => {
    // Build a representative dispatch event name and confirm:
    // - it matches PHASE_EVENT_PATTERN (so it IS in the routing namespace)
    // - its slot is "dispatch" (not in KNOWN_PHASES)
    // - but it IS in INTENTIONAL_PHASE_SLOT_EXCEPTIONS
    const dispatchName = "phase.dispatch.failed.CTL-1";
    expect(PHASE_EVENT_PATTERN.test(dispatchName)).toBe(true);
    expect(phaseSlotOf(dispatchName)).toBe("dispatch");
    expect(isAllowedPhaseSlot("dispatch")).toBe(true);
    // "dispatch" is NOT a canonical pipeline phase
    expect(KNOWN_PHASES.includes("dispatch")).toBe(false);
  });
});

// ── CTL-1639: worktree.salvage.* is a NEW, UNPROTECTED prefix ─────────────────
// The salvage primitive emits worktree.salvage.{created,skipped,failed}. These
// must NOT collide with any broker-protected namespace and must NOT be phase
// slots, so shouldSkipEvent ingests them normally (no namespace-contract.mjs edit
// was required to add the family). This guards against a future FORBIDDEN_PREFIXES
// / PROTECTED_EXACT_NAMES change silently swallowing salvage telemetry.
describe("CTL-1639 worktree.salvage.* namespace (unprotected)", () => {
  const SALVAGE_NAMES = [
    "worktree.salvage.created",
    "worktree.salvage.skipped",
    "worktree.salvage.failed",
  ];

  test("no worktree.salvage.* name is broker-protected", () => {
    for (const name of SALVAGE_NAMES) {
      expect(isBrokerProtectedName(name), `${name} must not be broker-protected`).toBe(false);
    }
  });

  test("no worktree.salvage.* name is a phase slot", () => {
    for (const name of SALVAGE_NAMES) {
      expect(phaseSlotOf(name), `${name} must not resolve to a phase slot`).toBeNull();
      expect(PHASE_EVENT_PATTERN.test(name)).toBe(false);
    }
  });
});
