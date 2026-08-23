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
// CTL-1659 — the cloud-sync dep-skew pair, imported from its owning module rather than
// re-typed as a literal below, so a rename cannot leave this contract asserting over a name
// nothing emits (the hand-copied-literal trap the ASSERTED_BY parity suite exists to prevent).
import { DEP_SKEW_RESTART_EVENT, DEP_SKEW_WOULD_RESTART_EVENT } from "../execution-core/cloud-sync-deps.mjs";
// CTL-1889 — the Linear write-proxy trio, imported from its owning module so a
// rename cannot leave a re-typed literal behind that still passes.
import { PROXY_EVENT_NAMES } from "../execution-core/linear-write-proxy.mjs";
// CTL-1786 — the lease-authority shadow observation pair, imported from its owning module so a
// rename cannot leave a re-typed literal behind that still passes.
import { LEASE_EVENT_NAMES } from "../execution-core/lease-authority.mjs";
// CTL-2076 — the registry team-identity mismatch (CAT-52) event, imported from its
// owning module rather than re-typed as a literal (same precedent as CTL-1659/CTL-1889).
import { CONFIG_TEAM_IDENTITY_MISMATCH } from "../execution-core/config-identity-event.mjs";
// CTL-1785 — the entitlement shadow/enforce events (would-shed / shed / restored),
// imported from their owning module so a rename cannot leave this contract asserting
// over a name nothing emits. The `entitlement.` prefix is UNPROTECTED (a dedicated
// test below asserts isBrokerProtectedName is false for each).
import { ENTITLEMENT_EVENT_NAMES } from "../execution-core/entitlement-event.mjs";
// CTL-2056 — the needs-human escalation event, imported from its owning module so a
// rename cannot leave a re-typed literal behind that still passes.
import { ESCALATION_EVENT_TICKET_ESCALATED } from "../execution-core/escalation-event.mjs";
// CTL-2052 — the label retry-exhausted escalation, imported from its owning module
// (not a re-typed literal). The `linear.label.` prefix is UNPROTECTED under the
// namespace contract (a dedicated test below asserts it, alongside the salvage family).
import { LABEL_RETRY_EXHAUSTED_EVENT } from "../execution-core/label-retry-event.mjs";
import { FENCE_STANDOFF_EVENT } from "../execution-core/fence-standoff.mjs"; // CAT-173
// CTL-2011 — the reader-split pair (exec-core env-pin diverges from broker/orch-monitor view),
// imported from their owning module by import rather than re-typed as literals.
import {
  EVENT_READERS_DIVERGED,
  EVENT_READERS_CONVERGED,
} from "../execution-core/github-feed-timer.mjs";
// CAT-60 — the publish-capability preflight blocked/would-block pair, imported from its
// owning module so a rename cannot leave a re-typed literal behind that still passes.
import {
  PUBLISH_PREFLIGHT_BLOCKED,
  PUBLISH_PREFLIGHT_WOULD_BLOCK,
} from "../execution-core/publish-preflight-event.mjs";

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
  "phase.advance.held.CTL-1",         // CTL-755 recovery.mjs defaultAppendPhaseAdvanceHeldEvent
  "phase.advance.applied.CTL-1",      // CTL-1789 recovery.mjs defaultAppendPhaseAdvanceAppliedEvent
  "phase.advance.suppressed-duplicate.CTL-1", // CTL-1805 recovery.mjs defaultAppendPhaseAdvanceSuppressedEvent (idempotency guard)
  "phase.dispatch.claim-lost.CTL-1",  // CTL-1805 phase-agent-dispatch bow-out (audible lost single-flight claim)
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
  "cloud-feed.would-dispatch",        // CTL-1847 cloud-feed-timer.mjs (shadow mode — would dispatch from the feed)
  "recovery.escalation.correlated",   // CAT-170 recovery-reasoning.mjs (enforced member pointer)
  "recovery.escalation.would-correlate", // CAT-170 recovery-reasoning.mjs (shadow group)
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
  DEP_SKEW_RESTART_EVENT, // CTL-1659 cloud-sync.mjs — the writer restarting to load an installed dep fix
  DEP_SKEW_WOULD_RESTART_EVENT, // CTL-1659 — sustained skew that did NOT act (shadow / budget / undurable ledger)
  ...PROXY_EVENT_NAMES, // CTL-1889 linear-write-proxy.mjs — would-write / applied / failed
  ...LEASE_EVENT_NAMES, // CTL-1786 lease-authority.mjs — shadow would-grant / would-refuse
  CONFIG_TEAM_IDENTITY_MISMATCH, // CTL-2076 config-identity-event.mjs — registry team-identity mismatch (CAT-52), boot telemetry
  ...ENTITLEMENT_EVENT_NAMES, // CTL-1785 entitlement-event.mjs — would-shed / shed / restored (v3 bare-name, host-suffixed)
  ESCALATION_EVENT_TICKET_ESCALATED, // CTL-2056 escalation-event.mjs — ticket.escalated (entity=ticket/action=escalated)
  LABEL_RETRY_EXHAUSTED_EVENT, // CTL-2052 label-retry-event.mjs — the "stopped after N and said so" escalation
  FENCE_STANDOFF_EVENT, // CAT-173 fence-standoff.mjs — mutual fence standoff escalation
  EVENT_READERS_DIVERGED, // CTL-2011 github-feed-timer.mjs — exec-core env-pin diverges from broker/orch-monitor view
  EVENT_READERS_CONVERGED, // CTL-2011 github-feed-timer.mjs — readers converged after a prior split
  PUBLISH_PREFLIGHT_BLOCKED, // CAT-60 publish-preflight-event.mjs — denied push capability
  PUBLISH_PREFLIGHT_WOULD_BLOCK, // CAT-60 publish-preflight-event.mjs — shadow mode would-block
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

  // CTL-1785: the entitlement.* prefix is deliberately UNPROTECTED — it must route
  // through shouldSkipEvent normally (no isBrokerProtectedName collision), so the
  // broker's phase-lifecycle router and wait-for subscribers see it like any other
  // exec-core observability event. Assert both the base names and a host-suffixed
  // sample are unprotected.
  test("entitlement.* is unprotected under the namespace contract", () => {
    for (const base of ENTITLEMENT_EVENT_NAMES) {
      expect(isBrokerProtectedName(base), `${base} must be unprotected`).toBe(false);
      expect(
        isBrokerProtectedName(`${base}.mini-2`),
        `${base}.mini-2 (host-suffixed) must be unprotected`
      ).toBe(false);
      // Not a phase-lifecycle event: no phase slot, so the broker never routes it
      // as a terminal phase transition.
      expect(phaseSlotOf(`${base}.mini-2`)).toBe(null);
    }
  });
});

describe("CAT-170 recovery escalation correlation event names", () => {
  const CORRELATION_EVENT_NAMES = [
    "recovery.escalation.correlated",
    "recovery.escalation.would-correlate",
  ];

  test("both names are registered and outside protected namespaces", () => {
    expect(
      INLINE_EVENT_NAMES.filter((name) => CORRELATION_EVENT_NAMES.includes(name))
    ).toEqual(CORRELATION_EVENT_NAMES);

    for (const name of CORRELATION_EVENT_NAMES) {
      expect(name.startsWith("filter.")).toBe(false);
      expect(name.startsWith("broker.daemon")).toBe(false);
      expect(name).not.toBe("session.heartbeat");
      expect(isBrokerProtectedName(name)).toBe(false);
      expect(phaseSlotOf(name)).toBeNull();
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

  // CTL-1789: the new applied-advance event joins phase.advance.held in the
  // "advance" exception slot. The load-bearing property is that its ACTION
  // ("applied") stays OUT of PHASE_EVENT_PATTERN's routing suffix set — if a
  // future edit added it there, router.mjs's tryPhaseLifecycleRoute would start
  // waking orchestrator sessions on every phase advance (a wake storm at ~9
  // events/ticket) and the event would stop being pure audit.
  test("CTL-1789: phase.advance.applied is allowed but creates NO routing match", () => {
    const appliedName = "phase.advance.applied.CTL-1";
    const heldName = "phase.advance.held.CTL-1";
    for (const name of [appliedName, heldName]) {
      // Not broker-protected → shouldSkipEvent ingests it normally.
      expect(isBrokerProtectedName(name), `${name} must not be broker-protected`).toBe(false);
      // Not in the routing namespace → tryPhaseLifecycleRoute returns [].
      expect(PHASE_EVENT_PATTERN.test(name), `${name} must not match the routing pattern`).toBe(
        false
      );
      expect(phaseSlotOf(name), `${name} must not resolve to a routable phase slot`).toBeNull();
    }
    // The slot itself is a documented exception (used by both actions).
    expect(isAllowedPhaseSlot("advance")).toBe(true);
    expect(KNOWN_PHASES.includes("advance")).toBe(false);
  });

  // CTL-1805: the idempotency-guard's two new audit events join the same
  // allowed-but-non-routing posture. `suppressed-duplicate` rides the "advance"
  // exception slot; `claim-lost` rides the pre-existing "dispatch" exception
  // slot. Neither action ("suppressed-duplicate" / "claim-lost") is in
  // PHASE_EVENT_PATTERN's terminal-status alternation, so phaseSlotOf returns
  // null → tryPhaseLifecycleRoute returns [] → pure audit, no wake (identical to
  // the CTL-1789 applied-advance property above). This is load-bearing: an
  // 8-tick-per-window suppression storm must NEVER become a wake storm.
  test("CTL-1805: suppressed-duplicate + claim-lost are allowed but create NO routing match", () => {
    const suppressedName = "phase.advance.suppressed-duplicate.CTL-1";
    const claimLostName = "phase.dispatch.claim-lost.CTL-1";
    for (const name of [suppressedName, claimLostName]) {
      expect(isBrokerProtectedName(name), `${name} must not be broker-protected`).toBe(false);
      expect(PHASE_EVENT_PATTERN.test(name), `${name} must not match the routing pattern`).toBe(
        false
      );
      expect(phaseSlotOf(name), `${name} must not resolve to a routable phase slot`).toBeNull();
    }
    // Both exception slots are documented and non-canonical.
    expect(isAllowedPhaseSlot("advance")).toBe(true);
    expect(isAllowedPhaseSlot("dispatch")).toBe(true);
    expect(KNOWN_PHASES.includes("advance")).toBe(false);
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

// ── CTL-2052: linear.label.retry-exhausted is UNPROTECTED ─────────────────────
// The AC3 escalation rides the `linear.label.` prefix, which must NOT collide with
// any broker-protected namespace and must NOT be a phase slot, so shouldSkipEvent
// ingests it normally and it is available to wait-for / dashboards. Guards against a
// future FORBIDDEN_PREFIXES / PROTECTED_EXACT_NAMES change swallowing it.
describe("CTL-2052 linear.label.retry-exhausted namespace (unprotected)", () => {
  test("it is not broker-protected", () => {
    expect(
      isBrokerProtectedName(LABEL_RETRY_EXHAUSTED_EVENT),
      `${LABEL_RETRY_EXHAUSTED_EVENT} must not be broker-protected`
    ).toBe(false);
  });

  test("it is not a phase slot — the broker never routes it as a terminal transition", () => {
    expect(phaseSlotOf(LABEL_RETRY_EXHAUSTED_EVENT)).toBeNull();
    expect(PHASE_EVENT_PATTERN.test(LABEL_RETRY_EXHAUSTED_EVENT)).toBe(false);
  });
});
