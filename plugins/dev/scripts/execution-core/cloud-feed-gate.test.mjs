// cloud-feed-gate.test.mjs — CTL-1847.
//
// The gate decides which producer may drive dispatch. Its failure modes are
// asymmetric and both are severe: suppress too much and the fleet stops
// dispatching entirely; suppress too little and every edge dispatches twice.
// So the matrix is pinned exhaustively rather than sampled.

import { describe, expect, test } from "bun:test";
import {
  CLOUD_FEED_MODES,
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
const feedEvent = (name, payload = {}) => ({
  ts: "2026-08-16T20:00:00Z",
  attributes: { "event.name": name, "linear.issue.identifier": payload.ticket ?? "CTL-1" },
  body: { message: name, payload: { source: "cloud-feed", ticket: "CTL-1", ...payload } },
});

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

  test("NOT ready ⇒ the feed still cannot dispatch (no double-dispatch in the gap)", () => {
    const v = decideDispatch(feedEvent("linear.issue.state_changed"), {
      mode: "enforce",
      isReady: () => false,
    });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("enforce-not-armed");
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
    // ...and the feed correspondingly cannot dispatch on an unwired gate.
    expect(decideDispatch(feedEvent("linear.issue.state_changed"), { mode: "enforce" }).suppress).toBe(true);
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
      body: { payload: { source: "cloud-feed", toState: "Done" } },
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
