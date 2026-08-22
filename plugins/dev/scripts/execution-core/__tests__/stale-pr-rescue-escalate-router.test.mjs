// stale-pr-rescue-escalate-router.test.mjs — CTL-2000 Phase 4. The stalled-PR
// sweep's defaultEscalate routed through the escalation router behind the
// CATALYST_STEWARD_ESCALATION flag: shadow (default) is byte-identical to today
// plus a would-route-steward log; enforce pages the concierge INSTEAD of
// applying needs-human. Run from execution-core/ under `bun test`.
//
// NOTE: the real Linear transport is an OBJECT with an `.applyLabel` method
// (labelOnce calls writeStatus.applyLabel(...)), not a bare function — the
// bare-fn form in the plan sketch never lands a label. Every case here uses a
// real temp orchDir + injected event/comms sinks so nothing touches the fleet.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEscalate } from "../stale-pr-rescue-timer.mjs";

function tmpOrch() {
  return mkdtempSync(join(tmpdir(), "ctl2000-esc-"));
}
const okTransport = (calls) => ({ applyLabel: () => { calls.push(1); return { applied: true }; } });

test("shadow (default): byte-identical to today — still labels, logs would-route-steward", () => {
  const orchDir = tmpOrch();
  const events = [];
  const calls = [];
  try {
    const out = defaultEscalate("CTL-1", { reason: "conflict", prNumber: 9 }, {
      orchDir,
      linearWrite: okTransport(calls),
      env: { CATALYST_STEWARD_ESCALATION: "shadow" },
      appendDelegateEvent: (e) => events.push(e),
      resolveSteward: () => null,
    });
    expect(out.confirmed).toBe(true); // unchanged contract — the escalation lands
    // ⛔ CTL-2159: was toHaveLength(1). The escalation publishes through the
    // classifier now; `confirmed` (asserted above) is the contract the rescue
    // latch reads, and no Linear label is written on any path.
    expect(calls).toHaveLength(0);
    expect(events.some((e) => e.type?.includes("would-route-steward"))).toBe(true);
  } finally {
    rmSync(orchDir, { recursive: true, force: true });
  }
});

test("shadow is byte-identical to off (same {confirmed,routed,reason}), off logs nothing", () => {
  const base = { reason: "conflict", prNumber: 9 };
  const call = (mode) => {
    const orchDir = tmpOrch();
    const events = [];
    try {
      const out = defaultEscalate("CTL-1", base, {
        orchDir,
        linearWrite: okTransport([]),
        env: { CATALYST_STEWARD_ESCALATION: mode },
        appendDelegateEvent: (e) => events.push(e),
        resolveSteward: () => null,
      });
      return { out, events };
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  };
  const off = call("off");
  const shadow = call("shadow");
  expect(shadow.out).toEqual(off.out); // identical routing outcome
  expect(off.events).toHaveLength(0); // off logs no would-route event
  expect(shadow.events.some((e) => e.type?.includes("would-route-steward"))).toBe(true);
});

test("enforce with no steward: pages the concierge, does NOT apply needs-human", () => {
  const orchDir = tmpOrch();
  const calls = [];
  const posted = [];
  try {
    const out = defaultEscalate("CTL-1", { reason: "conflict", prNumber: 9 }, {
      orchDir,
      linearWrite: okTransport(calls),
      env: { CATALYST_STEWARD_ESCALATION: "enforce" },
      appendDelegateEvent: () => {},
      resolveSteward: () => null,
      postConciergePage: (p) => { posted.push(p); return true; },
    });
    expect(calls).toHaveLength(0); // needs-human label NEVER applied
    expect(out.escalatedTo).toBe("concierge");
    expect(out.confirmed).toBe(false); // a page is a handoff, not a confirmed escalation
    expect(posted).toHaveLength(1); // the concierge was paged
  } finally {
    rmSync(orchDir, { recursive: true, force: true });
  }
});

test("enforce emits an observable routed-to-concierge event on the log", () => {
  const orchDir = tmpOrch();
  const events = [];
  try {
    defaultEscalate("CTL-1", { reason: "conflict", prNumber: 9 }, {
      orchDir,
      linearWrite: okTransport([]),
      env: { CATALYST_STEWARD_ESCALATION: "enforce" },
      appendDelegateEvent: (e) => events.push(e),
      resolveSteward: () => null,
      postConciergePage: () => true,
    });
    expect(events.some((e) => e.type === "phase.rescue.routed-to-concierge")).toBe(true);
  } finally {
    rmSync(orchDir, { recursive: true, force: true });
  }
});

test("enforce with a matched steward pages the steward, not the concierge, and applies no label", () => {
  const orchDir = tmpOrch();
  const calls = [];
  const posted = [];
  try {
    const out = defaultEscalate("CTL-1", { reason: "conflict", prNumber: 9 }, {
      orchDir,
      linearWrite: okTransport(calls),
      env: { CATALYST_STEWARD_ESCALATION: "enforce" },
      appendDelegateEvent: () => {},
      resolveSteward: () => ({ role: "steward-x", scope: "CTL-1" }), // CTL-1974 forward-compat
      postConciergePage: (p) => { posted.push(p); return true; },
    });
    expect(calls).toHaveLength(0);
    expect(out.escalatedTo).toBe("steward");
    expect(out.confirmed).toBe(false);
    // Codex P2: the resolved steward target MUST be threaded to the page function
    // so defaultPostConciergePage can deliver TO the steward instead of hardcoding
    // the concierge — otherwise the event claims a steward route the message never took.
    expect(posted).toHaveLength(1);
    expect(posted[0].target?.target).toBe("steward");
    expect(posted[0].target?.steward?.role).toBe("steward-x");
  } finally {
    rmSync(orchDir, { recursive: true, force: true });
  }
});
