// cloud-feed-gate.test.mjs — CTL-1847.
//
// The gate decides which producer may drive dispatch. Its failure modes are
// asymmetric and both are severe: suppress too much and the fleet stops
// dispatching entirely; suppress too little and every edge dispatches twice.
// So the matrix is pinned exhaustively rather than sampled.

import { describe, expect, test } from "bun:test";
import {
  CLOUD_FEED_MODES,
  INTERNAL_SOURCES,
  SOURCE_INTERNAL,
  DISPATCH_CLASS_NAMES,
  SOURCE_CLOUD_FEED,
  SOURCE_OTHER,
  SOURCE_WEBHOOK,
  decideDispatch,
  echoProbesFor,
  isDispatchClass,
  sourceOf,
  ticketOf,
} from "./cloud-feed-gate.mjs";

/** A feed-produced event: stamped `source: "cloud-feed"` by linear-feed-event.mjs. */
// Feed events carry the emission-time authority stamp (round 6). Tests that
// want a dispatchable feed event must say so, exactly as the producer does.
const feedEvent = (name, payload = {}) => ({
  ts: "2026-08-16T20:00:00Z",
  attributes: { "event.name": name, "linear.issue.identifier": payload.ticket ?? "CTL-1" },
  body: { message: name, payload: { source: "cloud-feed", ticket: "CTL-1", feedAuthority: true, ...payload } },
});

/** A feed event emitted by a sweep that was NOT armed. */
const unarmedFeedEvent = (name, payload = {}) =>
  feedEvent(name, { ...payload, feedAuthority: false });

/** A smee-produced event: carries a webhook delivery id, no `source`. */
const smeeEvent = (name, payload = {}) => ({
  ts: "2026-08-16T20:00:00Z",
  attributes: {
    "event.name": name,
    "linear.issue.identifier": payload.ticket ?? "CTL-1",
    "webhook.delivery.id": "d-123",
  },
  body: { message: name, payload: { ticket: "CTL-1", ...payload } },
});

describe("sourceOf", () => {
  test("identifies the feed POSITIVELY, by its own stamp", () => {
    expect(sourceOf(feedEvent("linear.issue.state_changed"))).toBe(SOURCE_CLOUD_FEED);
  });

  test("identifies smee by the webhook delivery id", () => {
    expect(sourceOf(smeeEvent("linear.issue.state_changed"))).toBe(SOURCE_WEBHOOK);
  });

  test("an unknown producer is `other`, NOT cloud-feed", () => {
    // The whole point of identifying the feed positively: a third producer must
    // not inherit dispatch authority by resembling one.
    const mystery = {
      attributes: { "event.name": "linear.issue.state_changed" },
      body: { payload: { ticket: "CTL-1" } },
    };
    expect(sourceOf(mystery)).toBe(SOURCE_OTHER);
  });

  test("a payload claiming a DIFFERENT source is not the feed", () => {
    const spoof = feedEvent("linear.issue.state_changed");
    spoof.body.payload.source = "cloud-feed-v2";
    expect(sourceOf(spoof)).toBe(SOURCE_OTHER);
  });
});

describe("isDispatchClass", () => {
  test.each(DISPATCH_CLASS_NAMES)("%s is dispatch-class", (name) => {
    expect(isDispatchClass(feedEvent(name))).toBe(true);
  });

  test("names the monitor has no handler for are NOT dispatch-class", () => {
    // Measured in the parity harness as SMEE_UNHANDLED_NAMES: the webhook path
    // emits these and nothing consumes them. Gating them would put entries in
    // the capture file that were never going to dispatch anyway.
    for (const n of [
      "linear.issue.priority_changed",
      "linear.issue.assignee_changed",
      "linear.issue.created",
      "linear.issue.removed",
      "github.pull_request.opened",
    ]) {
      expect(isDispatchClass(smeeEvent(n))).toBe(false);
    }
  });
});

describe("decideDispatch — off mode (the default)", () => {
  test("webhook events dispatch, exactly as before CTL-1847", () => {
    for (const n of DISPATCH_CLASS_NAMES) {
      const v = decideDispatch(smeeEvent(n), { mode: "off" });
      expect(v.suppress).toBe(false);
      expect(v.reason).toBe("webhook-authoritative");
    }
  });

  test("a feed event that somehow reaches the log is SUPPRESSED, not dispatched", () => {
    // Defence in depth: a stale enforce-mode producer surviving a rollback must
    // not keep dispatching. This is the shape of a rollback that doesn't roll back.
    const v = decideDispatch(feedEvent("linear.issue.state_changed"), { mode: "off" });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-not-authoritative");
  });
});

describe("decideDispatch — shadow mode", () => {
  test("smee still drives every dispatch", () => {
    const v = decideDispatch(smeeEvent("linear.issue.state_changed"), { mode: "shadow" });
    expect(v.suppress).toBe(false);
  });

  test("the feed still cannot dispatch", () => {
    const v = decideDispatch(feedEvent("linear.comment.created"), { mode: "shadow" });
    expect(v.suppress).toBe(true);
  });
});

describe("decideDispatch — enforce mode", () => {
  test("the feed becomes authoritative", () => {
    for (const n of DISPATCH_CLASS_NAMES) {
      const v = decideDispatch(feedEvent(n), { mode: "enforce", isReady: () => true });
      expect(v.suppress).toBe(false);
      expect(v.reason).toBe("feed-authoritative");
    }
  });

  test("smee's copies are CAPTURED, not dispatched", () => {
    for (const n of DISPATCH_CLASS_NAMES) {
      const v = decideDispatch(smeeEvent(n), { mode: "enforce", isReady: () => true });
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe("smee-captured");
    }
  });

  test("an unknown producer is captured too — it cannot inherit the feed's authority", () => {
    const mystery = {
      attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "CTL-1" },
      body: { payload: { ticket: "CTL-1" } },
    };
    const v = decideDispatch(mystery, { mode: "enforce", isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.source).toBe(SOURCE_OTHER);
  });

  test("NEGATIVE CONTROL: non-dispatch-class events are never gated in any mode", () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      const v = decideDispatch(smeeEvent("github.pull_request.opened"), { mode });
      expect(v.suppress).toBe(false);
      expect(v.reason).toBe("not-dispatch-class");
    }
  });
});

describe("decideDispatch — enforce is not armed until the producer is ready (Codex P1)", () => {
  const ready = () => true;

  test("NOT ready ⇒ smee keeps dispatching (enforce degrades to shadow routing)", () => {
    // The failure this prevents: on an unseeded host the gate would suppress
    // smee while runDiffSweep's first tick only seeds and emits nothing —
    // issue changes absorbed into the baseline, comments lost permanently.
    const v = decideDispatch(smeeEvent("linear.issue.state_changed"), {
      mode: "enforce",
      isReady: () => false,
    });
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("enforce-not-armed");
  });

  // ⛔ CTL-1901. This test previously asserted the DEFECT: a feed event already
  // stamped authoritative by an armed sweep was expected to be suppressed once
  // readiness went false. Its twin had already been captured under the older
  // ready=true and the sweep's cursor had advanced past the edge, so the edge
  // reached NEITHER path. The stamp is now sufficient on its own.
  test("NOT ready ⇒ a STAMPED feed event still dispatches (the stamp is not revocable)", () => {
    const v = decideDispatch(feedEvent("linear.issue.state_changed"), {
      mode: "enforce",
      isReady: () => false,
    });
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("feed-authoritative");
  });

  test("NOT ready ⇒ an UNSTAMPED feed event still cannot dispatch", () => {
    // The other half of the same boundary: readiness going false must not GRANT
    // authority either. Without this, the test above would pass against a gate
    // that simply stopped suppressing the feed.
    const v = decideDispatch(unarmedFeedEvent("linear.issue.state_changed"), {
      mode: "enforce",
      isReady: () => false,
    });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-emitted-while-unarmed");
  });

  test("ready ⇒ enforce behaves as enforce", () => {
    expect(decideDispatch(feedEvent("linear.issue.state_changed"), { mode: "enforce", isReady: ready }).suppress).toBe(false);
    expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode: "enforce", isReady: ready }).suppress).toBe(true);
  });

  test("an ABSENT probe is treated as NOT ready — a wiring mistake gets the safe half", () => {
    // Deliberately passes NO isReady key at all, and separately an explicit null.
    const noKey = decideDispatch(smeeEvent("linear.issue.state_changed"), { mode: "enforce" });
    expect(noKey.reason).toBe("enforce-not-armed");
    expect(noKey.suppress).toBe(false);
    expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode: "enforce", isReady: null }).suppress).toBe(false);
    // ...and an UNSTAMPED feed event correspondingly cannot dispatch on an
    // unwired gate. (A stamped one still can, and must: an unwired readiness
    // probe is a caller mistake, and CTL-1901's rule is that it can only ever
    // cost a duplicate — never a loss. See the exactly-once scenario below.)
    expect(decideDispatch(unarmedFeedEvent("linear.issue.state_changed"), { mode: "enforce" }).suppress).toBe(true);
  });

  test("a THROWING probe is NOT ready", () => {
    const v = decideDispatch(smeeEvent("linear.issue.state_changed"), {
      mode: "enforce",
      isReady: () => { throw new Error("boom"); },
    });
    expect(v.suppress).toBe(false);
  });

  test("readiness does not affect off/shadow at all", () => {
    for (const mode of ["off", "shadow"]) {
      expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode, isReady: () => false }).suppress).toBe(false);
      expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode, isReady: ready }).suppress).toBe(false);
    }
  });
});

describe("internal synthetic sources bypass the gate (Codex P1 round 3)", () => {
  // buildResumeEvent (orch-monitor/lib/respond-ticket.mjs) emits a synthetic
  // linear.comment.created that is the SOLE trigger resuming a held worker and
  // is never written to Linear — so the feed can never produce a replacement.
  // Capturing it left the worker parked forever while the endpoint said
  // "resuming".
  const resumeEvent = () => ({
    attributes: { "event.name": "linear.comment.created", "linear.issue.identifier": "CTL-5" },
    body: { payload: { ticket: "CTL-5", source: "orch-monitor/respond", body: "go on" } },
  });

  test("the allow-list is an EXPLICIT named set, not an inference", () => {
    expect([...INTERNAL_SOURCES]).toEqual(["orch-monitor/respond"]);
  });

  test("a resume event is never suppressed, in ANY mode", () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      const v = decideDispatch(resumeEvent(), { mode, isReady: () => true });
      expect(v.suppress).toBe(false);
      expect(v.reason).toBe("internal-source-no-replacement");
      expect(v.source).toBe(SOURCE_INTERNAL);
    }
  });

  test("⛔ CONTROL: an UNKNOWN source is still captured in enforce", () => {
    // The exemption must be the named list, not "anything with a source field".
    const unknown = {
      attributes: { "event.name": "linear.comment.created", "linear.issue.identifier": "CTL-6" },
      body: { payload: { ticket: "CTL-6", source: "some-future-producer" } },
    };
    const v = decideDispatch(unknown, { mode: "enforce", isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("smee-captured");
  });

  test("CONTROL: a near-miss source string is not exempted", () => {
    for (const src of ["orch-monitor/respond ", "orch-monitor", "ORCH-MONITOR/RESPOND", "respond"]) {
      const e = {
        attributes: { "event.name": "linear.comment.created", "linear.issue.identifier": "CTL-7" },
        body: { payload: { ticket: "CTL-7", source: src } },
      };
      expect(decideDispatch(e, { mode: "enforce", isReady: () => true }).suppress).toBe(true);
    }
  });

  test("the internal exemption does not let it through when it is NOT dispatch-class", () => {
    const e = {
      attributes: { "event.name": "github.pull_request.opened" },
      body: { payload: { source: "orch-monitor/respond" } },
    };
    expect(decideDispatch(e, { mode: "enforce", isReady: () => true }).reason).toBe("not-dispatch-class");
  });
});

describe("decideDispatch — mode degradation", () => {
  test.each([undefined, null, "", "ENFORCE", "enforce ", "on", "1", "true", 42, {}])(
    "an unrecognized mode (%p) degrades to OFF, never to enforce",
    (mode) => {
      // The safety direction: a typo in a daemon env var must not silently cut a
      // host over to an unproven dispatch source.
      expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode }).suppress).toBe(false);
      expect(decideDispatch(feedEvent("linear.issue.state_changed"), { mode }).suppress).toBe(true);
    },
  );

  test("the mode set is exactly the three house modes", () => {
    expect([...CLOUD_FEED_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });
});

describe("echo suppression (CTL-1891 ring)", () => {
  const stateEvent = () =>
    feedEvent("linear.issue.state_changed", { ticket: "CTL-1", toState: "In Progress" });

  test("a matching echo suppresses dispatch", () => {
    const isEcho = (ticket, field, value) =>
      ticket === "CTL-1" && field === "state" && value === "In Progress";
    const v = decideDispatch(stateEvent(), { mode: "enforce", isEcho, isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("own-write-echo");
  });

  test("NEGATIVE CONTROL: a non-matching ring does NOT suppress", () => {
    // Without this the suppression test above would pass against a ring that
    // always returns true, proving nothing.
    const isEcho = () => false;
    expect(decideDispatch(stateEvent(), { mode: "enforce", isEcho, isReady: () => true }).suppress).toBe(false);
  });

  test("no ring at all ⇒ nothing is an echo (the pre-ring behaviour)", () => {
    expect(decideDispatch(stateEvent(), { mode: "enforce", isReady: () => true }).suppress).toBe(false);
    expect(decideDispatch(stateEvent(), { mode: "enforce", isEcho: null, isReady: () => true }).suppress).toBe(false);
  });

  test("a THROWING ring fails OPEN — dispatch proceeds, nothing is swallowed", () => {
    const isEcho = () => {
      throw new Error("ring exploded");
    };
    expect(decideDispatch(stateEvent(), { mode: "enforce", isEcho, isReady: () => true }).suppress).toBe(false);
  });

  test("the ring is never consulted outside enforce", () => {
    let consulted = 0;
    const isEcho = () => {
      consulted += 1;
      return true;
    };
    decideDispatch(stateEvent(), { mode: "off", isEcho });
    decideDispatch(stateEvent(), { mode: "shadow", isEcho });
    // off/shadow must be byte-identical to today, and today has no ring.
    expect(consulted).toBe(0);
  });

  test("the ring is not consulted for smee events even in enforce", () => {
    // They are captured on source alone; probing would spend tokens recorded
    // for the feed's copy of the same write and let a real echo through later.
    let consulted = 0;
    const isEcho = () => {
      consulted += 1;
      return false;
    };
    decideDispatch(smeeEvent("linear.issue.state_changed", { toState: "Done" }), {
      mode: "enforce",
      isEcho,
      isReady: () => true,
    });
    expect(consulted).toBe(0);
  });
});

describe("echoProbesFor", () => {
  test("a state edge probes `state` only", () => {
    const probes = echoProbesFor(
      feedEvent("linear.issue.state_changed", { toState: "Done", updatedFromKeys: ["state"] }),
    );
    expect(probes).toEqual([{ field: "state", value: "Done" }]);
  });

  test("a comment probes `comment` with its body", () => {
    const probes = echoProbesFor(feedEvent("linear.comment.created", { body: "hello" }));
    expect(probes).toEqual([{ field: "comment", value: "hello" }]);
  });

  test("only fields the event REPORTS as changed are probed", () => {
    // isEcho consumes a token on a hit, so probing an unchanged field would
    // spend a token recorded for a different write.
    const probes = echoProbesFor(
      feedEvent("linear.issue.updated", {
        updatedFromKeys: ["assigneeId"],
        toAssigneeId: "u-1",
        toLabels: ["bug"], // present in the payload but NOT listed as changed
        toState: "Todo",
      }),
    );
    expect(probes).toEqual([{ field: "assignee", value: "u-1" }]);
  });

  test("an event with nothing checkable yields no probes (⇒ not an echo)", () => {
    expect(echoProbesFor(feedEvent("linear.issue.updated", { updatedFromKeys: [] }))).toEqual([]);
    expect(echoProbesFor({})).toEqual([]);
    expect(echoProbesFor(null)).toEqual([]);
  });

  test("a comment with an empty body yields no probe", () => {
    expect(echoProbesFor(feedEvent("linear.comment.created", { body: "" }))).toEqual([]);
  });
});

describe("ticketOf", () => {
  test("prefers the attribute, falls back to the payload", () => {
    expect(ticketOf(feedEvent("linear.comment.created"))).toBe("CTL-1");
    expect(
      ticketOf({ attributes: {}, body: { payload: { ticket: "CTC-9" } } }),
    ).toBe("CTC-9");
  });

  test("returns null when there is no ticket — never a partial key", () => {
    expect(ticketOf({ attributes: {}, body: { payload: {} } })).toBe(null);
    expect(ticketOf(null)).toBe(null);
  });

  test("an event with no ticket is never suppressed as an echo", () => {
    // A null ticket cannot form a ring key; suppressing on a partial key would
    // silently drop a real edge.
    const noTicket = {
      attributes: { "event.name": "linear.issue.state_changed" },
      body: { payload: { source: "cloud-feed", toState: "Done", feedAuthority: true } },
    };
    const isEcho = () => true; // a ring that says yes to everything
    expect(decideDispatch(noTicket, { mode: "enforce", isEcho, isReady: () => true }).suppress).toBe(false);
  });
});

describe("malformed input", () => {
  test.each([null, undefined, {}, { attributes: null }, { body: "nope" }, 42, "string"])(
    "never throws on %p",
    (event) => {
      for (const mode of ["off", "shadow", "enforce"]) {
        expect(() => decideDispatch(event, { mode })).not.toThrow();
      }
    },
  );
});

// ── CTL-1847 (Codex P1 round 6): authority is stamped, not read later ────────
describe("⛔ the emission stamp decides, not a mutable flag", () => {
  const armed = () => true;

  test("an UNSTAMPED feed event never dispatches, even fully armed", () => {
    // The race this closes: a webhook copy dispatches while readiness is false,
    // the sweep synchronously appends its feed twin, `ready` flips before the
    // event loop runs the log watcher, and the queued twin then dispatches AGAIN
    // under the new value. Reading a flag at consumption time cannot see which
    // sweep produced the line; the line itself can.
    const noStamp = {
      attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "CTL-1" },
      body: { payload: { source: "cloud-feed", ticket: "CTL-1" } },
    };
    const v = decideDispatch(noStamp, { mode: "enforce", isReady: armed });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-emitted-while-unarmed");
  });

  test("a feed event stamped FALSE never dispatches, even fully armed", () => {
    const v = decideDispatch(unarmedFeedEvent("linear.issue.state_changed"), { mode: "enforce", isReady: armed });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-emitted-while-unarmed");
  });

  test("NEGATIVE CONTROL: a feed event stamped TRUE does dispatch", () => {
    // Without this the two above would pass against a gate that suppresses
    // everything.
    const v = decideDispatch(feedEvent("linear.issue.state_changed"), { mode: "enforce", isReady: armed });
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("feed-authoritative");
  });

  test("⭐ the transition is safe in BOTH directions — never two dispatches, never zero", () => {
    // Sweep N (unarmed): smee dispatches, its feed twin is stamped false.
    const twin = unarmedFeedEvent("linear.issue.state_changed");
    const smeeCopy = smeeEvent("linear.issue.state_changed");
    expect(decideDispatch(smeeCopy, { mode: "enforce", isReady: () => false }).suppress).toBe(false); // smee delivers
    // ...and the twin stays suppressed even after readiness flips mid-flight.
    expect(decideDispatch(twin, { mode: "enforce", isReady: armed }).suppress).toBe(true);

    // Sweep N+1 (armed): the feed delivers and smee's copy is captured.
    expect(decideDispatch(feedEvent("linear.issue.state_changed"), { mode: "enforce", isReady: armed }).suppress).toBe(false);
    expect(decideDispatch(smeeEvent("linear.issue.state_changed"), { mode: "enforce", isReady: armed }).suppress).toBe(true);
  });

  test("the stamp is ignored outside enforce", () => {
    for (const mode of ["off", "shadow"]) {
      // Feed events are suppressed on source alone; the stamp changes nothing.
      expect(decideDispatch(feedEvent("linear.issue.updated"), { mode }).suppress).toBe(true);
      expect(decideDispatch(unarmedFeedEvent("linear.issue.updated"), { mode }).suppress).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-1901 — a mid-sweep readiness drop must not strand an already-stamped edge.
//
// Counted as DELIVERIES, not as per-event verdicts. Both earlier attempts at
// this boundary passed their own per-event assertions while the edge as a whole
// reached zero handlers; the only assertion that catches that is "how many times
// did this ONE edge get delivered".
// ─────────────────────────────────────────────────────────────────────────────
describe("CTL-1901 — exactly-once delivery across a readiness transition", () => {
  const armed = () => true;
  const unarmed = () => false;

  /** Deliveries for one edge = the copies the gate did NOT suppress. */
  const deliveries = (copies) =>
    copies.filter(({ event, isReady }) => !decideDispatch(event, { mode: "enforce", isReady }).suppress).length;

  test("ACCEPTANCE: armed sweep emits A, the sweep then fails and un-arms — A still dispatches, its twin stays captured, exactly ONE delivery", () => {
    // The exact sequence from the ticket:
    //   1. an armed sweep stamps event A authoritative
    //   2. A's webhook twin is consumed while readiness is still true → captured
    //   3. a later row in that same sweep fails, readiness flips false
    //   4. only THEN does the log tail reach A
    // Before the fix the armed check ran first, so step 4 suppressed A — and
    // step 2 had already captured the twin, and the sweep's successful prefix
    // had advanced the cursor, so there was no retry. Zero deliveries.
    const A = feedEvent("linear.issue.state_changed");
    const twin = smeeEvent("linear.issue.state_changed");

    expect(
      deliveries([
        { event: twin, isReady: armed }, // consumed while still armed → captured
        { event: A, isReady: unarmed }, // consumed after the drop
      ])
    ).toBe(1);

    // ...and it is specifically the FEED copy that delivered.
    expect(decideDispatch(A, { mode: "enforce", isReady: unarmed }).reason).toBe("feed-authoritative");
    expect(decideDispatch(twin, { mode: "enforce", isReady: armed }).reason).toBe("smee-captured");
  });

  test("NEGATIVE CONTROL: an UNSTAMPED event under the same sequence is still suppressed", () => {
    // Without this, the acceptance test above would pass against a gate that had
    // simply stopped suppressing the feed altogether.
    const A = unarmedFeedEvent("linear.issue.state_changed");
    const twin = smeeEvent("linear.issue.state_changed");

    // The twin dispatched (it was consumed while unarmed), the feed copy did not.
    expect(deliveries([{ event: twin, isReady: unarmed }, { event: A, isReady: unarmed }])).toBe(1);
    expect(decideDispatch(A, { mode: "enforce", isReady: unarmed }).reason).toBe("feed-emitted-while-unarmed");
  });

  test("the steady states are still exactly-once in both postures", () => {
    // Fully armed: feed delivers, smee captured.
    expect(
      deliveries([
        { event: smeeEvent("linear.issue.state_changed"), isReady: armed },
        { event: feedEvent("linear.issue.state_changed"), isReady: armed },
      ])
    ).toBe(1);

    // Fully unarmed: smee delivers, the feed's copy is stamped false by the
    // unarmed sweep that produced it.
    expect(
      deliveries([
        { event: smeeEvent("linear.issue.state_changed"), isReady: unarmed },
        { event: unarmedFeedEvent("linear.issue.state_changed"), isReady: unarmed },
      ])
    ).toBe(1);
  });

  test("across a RE-ARM the edge is delivered exactly once", () => {
    // The mirror of the acceptance case. An edge occurring while unarmed: its
    // twin dispatches (readiness false at consumption) and its feed copy is
    // emitted by the recovering tick, which stamps with the value carried INTO
    // that tick — still false. One delivery, via smee.
    expect(
      deliveries([
        { event: smeeEvent("linear.comment.created"), isReady: unarmed },
        { event: unarmedFeedEvent("linear.comment.created"), isReady: armed }, // consumed after the re-arm
      ])
    ).toBe(1);
  });

  test("readiness is consulted for the SMEE side only", () => {
    // The asymmetry stated as a property: flipping readiness changes the smee
    // verdict and never the feed verdict.
    const A = feedEvent("linear.issue.updated");
    expect(decideDispatch(A, { mode: "enforce", isReady: armed }).suppress).toBe(
      decideDispatch(A, { mode: "enforce", isReady: unarmed }).suppress
    );

    const twin = smeeEvent("linear.issue.updated");
    expect(decideDispatch(twin, { mode: "enforce", isReady: armed }).suppress).not.toBe(
      decideDispatch(twin, { mode: "enforce", isReady: unarmed }).suppress
    );
  });

  test("an unknown producer is still captured while armed, and never inherits the stamp", () => {
    // `other` must not be able to buy authority by carrying a feedAuthority key.
    const mystery = {
      attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "CTL-1" },
      body: { payload: { ticket: "CTL-1", feedAuthority: true } },
    };
    expect(decideDispatch(mystery, { mode: "enforce", isReady: armed }).suppress).toBe(true);
    expect(decideDispatch(mystery, { mode: "enforce", isReady: armed }).reason).toBe("smee-captured");
  });
});
