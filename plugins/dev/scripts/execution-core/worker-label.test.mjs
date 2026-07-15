// worker-label.test.mjs — CTL-1481 stampWorkerLabel: the best-effort
// `worker:<host>` visibility-projection stamp on a cluster claim-win. Every
// test injects fakes for readLabelNodes/applyLabel/removeLabel so nothing
// shells out to linearis. Run:
//   cd plugins/dev/scripts/execution-core && bun test worker-label.test.mjs

import { describe, test, expect } from "bun:test";
import { WORKER_LABEL_PREFIX, stampWorkerLabel } from "./worker-label.mjs";

// recorder — minimal call-collecting fake; mirrors label-guard.test.mjs's
// recorder / recovery.test.mjs convention. `impl` may be a function (invoked
// per call) or a plain value (returned every call).
function recorder(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return typeof impl === "function" ? impl(...args) : impl;
  };
  fn.calls = [];
  return fn;
}

describe("WORKER_LABEL_PREFIX", () => {
  test("is the shared 'worker:' namespace prefix", () => {
    expect(WORKER_LABEL_PREFIX).toBe("worker:");
  });
});

describe("stampWorkerLabel — steady state", () => {
  test("ticket already carries worker:<hostName> and nothing else — zero writes, stamped:true", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:mini" }] });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(readLabelNodes.calls.length).toBe(1);
    expect(applyLabel.calls.length).toBe(0);
    expect(removeLabel.calls.length).toBe(0);
  });
});

describe("stampWorkerLabel — unlabeled ticket", () => {
  test("no worker:* label present — exactly one apply, no removes", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [] });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(removeLabel.calls.length).toBe(0);
    expect(applyLabel.calls.length).toBe(1);
    expect(applyLabel.calls[0][0]).toEqual({ ticket: "CTL-1", label: "worker:mini" });
  });
});

describe("stampWorkerLabel — swap from a foreign host", () => {
  test("worker:other present — removes worker:other THEN applies worker:mini, in that order", () => {
    const order = [];
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const removeLabel = recorder((ticket, label) => {
      order.push(`remove:${label}`);
      return { removed: true };
    });
    const applyLabel = recorder(({ label }) => {
      order.push(`apply:${label}`);
      return { applied: true };
    });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["mini", "other"], readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(order).toEqual(["remove:worker:other", "apply:worker:mini"]);
    expect(removeLabel.calls[0]).toEqual(["CTL-1", "worker:other"]);
  });

  test("non-worker labels (e.g. a customer/component label) are never touched", () => {
    const readLabelNodes = recorder({
      ok: true,
      nodes: [{ id: "l1", name: "worker:other" }, { id: "l2", name: "bug" }],
    });
    const removeLabel = recorder({ removed: true });
    const applyLabel = recorder({ applied: true });

    stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });

    expect(removeLabel.calls.length).toBe(1);
    expect(removeLabel.calls[0][1]).toBe("worker:other");
    expect(removeLabel.calls.some((c) => c[1] === "bug")).toBe(false);
  });
});

describe("stampWorkerLabel — read failure", () => {
  test("readLabelNodes reports !ok — no writes attempted, stamped:false", () => {
    const readLabelNodes = recorder({ ok: false, nodes: null, code: 1, stderr: "boom" });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: false, reason: "read-failed" });
    expect(applyLabel.calls.length).toBe(0);
    expect(removeLabel.calls.length).toBe(0);
  });
});

describe("stampWorkerLabel — applyLabel throws", () => {
  test("throw is swallowed — stamped:false, no propagation", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [] });
    const applyLabel = recorder(() => {
      throw new Error("linearis exploded");
    });
    const removeLabel = recorder({ removed: true });

    let threw = false;
    let res;
    try {
      res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(res).toEqual({ stamped: false, reason: "apply-threw" });
  });
});

describe("stampWorkerLabel — removeLabel fails", () => {
  test("a failed foreign-label removal aborts the stamp — apply is NEVER attempted", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const removeLabel = recorder({ removed: false, reason: "transient" });
    const applyLabel = recorder({ applied: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: false, reason: "remove-failed" });
    expect(applyLabel.calls.length).toBe(0);
  });

  test("removeLabel throwing also aborts the stamp — apply is NEVER attempted, no propagation", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const removeLabel = recorder(() => {
      throw new Error("linearis exploded");
    });
    const applyLabel = recorder({ applied: true });

    let threw = false;
    let res;
    try {
      res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(res).toEqual({ stamped: false, reason: "remove-failed" });
    expect(applyLabel.calls.length).toBe(0);
  });
});

describe("stampWorkerLabel — applyLabel reports a non-throw failure", () => {
  test("applied:false with a reason is surfaced verbatim", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [] });
    const applyLabel = recorder({ applied: false, reason: "exclusive-conflict" });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: false, reason: "exclusive-conflict" });
  });
});

describe("stampWorkerLabel — thenable removeLabel (the production async-declared shape, CTL-764 round-5 discipline)", () => {
  test("resolved {removed:true} — apply happens on a microtask, strictly AFTER the confirmed remove", async () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const order = [];
    const removeLabel = recorder((ticket, name) => {
      order.push(`remove:${name}`);
      return Promise.resolve({ removed: true });
    });
    const applyLabel = recorder(({ label }) => {
      order.push(`apply:${label}`);
      return { applied: true };
    });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });

    // Sync caller only learns the swap was deferred; no apply yet.
    expect(res).toEqual({ stamped: false, reason: "swap-deferred" });
    expect(applyLabel.calls.length).toBe(0);

    await Promise.resolve(); // drain the confirmation microtask
    expect(order).toEqual(["remove:worker:other", "apply:worker:mini"]);
  });

  test("resolved {removed:false} — apply is NEVER attempted (abort survives the async boundary)", async () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const removeLabel = recorder(Promise.resolve({ removed: false, reason: "transient" }));
    const applyLabel = recorder({ applied: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });
    expect(res).toEqual({ stamped: false, reason: "swap-deferred" });

    await Promise.resolve();
    await Promise.resolve();
    expect(applyLabel.calls.length).toBe(0);
  });

  test("rejected promise — swallowed, apply is NEVER attempted, nothing propagates", async () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const rejection = Promise.reject(new Error("linearis exploded"));
    rejection.catch(() => {}); // pre-observed so bun doesn't flag an unhandled rejection before stamp attaches its catch
    const removeLabel = recorder(rejection);
    const applyLabel = recorder({ applied: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["other"], readLabelNodes, applyLabel, removeLabel });
    expect(res).toEqual({ stamped: false, reason: "swap-deferred" });

    await Promise.resolve();
    await Promise.resolve();
    expect(applyLabel.calls.length).toBe(0);
  });
});

describe("stampWorkerLabel — replica-first read (Codex #2650 P2)", () => {
  test("replica already-present hit is LIVE-CONFIRMED — 1 read, zero writes when live agrees", () => {
    const replica = { labels: recorder([{ id: "l1", name: "worker:mini" }]) };
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:mini" }] });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(replica.labels.calls.length).toBe(1);
    expect(readLabelNodes.calls.length).toBe(1); // the confirm — this is the one no-write replica answer
    expect(applyLabel.calls.length).toBe(0);
    expect(removeLabel.calls.length).toBe(0);
  });

  test("STALE replica already-present hit (peer swapped live) — live confirm disagrees, swap proceeds", () => {
    // Replica still shows worker:mini from our previous stint; live truth is
    // worker:mini-2 (a peer swapped it and we just re-won the claim).
    const replica = { labels: recorder([{ id: "l1", name: "worker:mini" }]) };
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l2", name: "worker:mini-2" }] });
    const removeLabel = recorder({ removed: true });
    const applyLabel = recorder({ applied: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["mini", "mini-2"], replica, readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(removeLabel.calls.length).toBe(1);
    expect(removeLabel.calls[0][1]).toBe("worker:mini-2");
    expect(applyLabel.calls.length).toBe(1);
  });

  test("live confirm of a replica already-present hit FAILING skips the stamp (no writes)", () => {
    const replica = { labels: recorder([{ id: "l1", name: "worker:mini" }]) };
    const readLabelNodes = recorder({ ok: false, nodes: null, code: 1, stderr: "boom" });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: false, reason: "read-failed" });
    expect(applyLabel.calls.length).toBe(0);
    expect(removeLabel.calls.length).toBe(0);
  });

  test("replica [] (authoritative empty) is trusted — no live read, one apply", () => {
    const replica = { labels: recorder([]) };
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "x", name: "worker:other" }] });
    const applyLabel = recorder({ applied: true });
    const removeLabel = recorder({ removed: true });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(readLabelNodes.calls.length).toBe(0);
    expect(removeLabel.calls.length).toBe(0);
    expect(applyLabel.calls.length).toBe(1);
  });

  test("replica MISS (undefined) falls back LOUDLY to the live read", () => {
    const replica = { labels: recorder(undefined) };
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:mini" }] });
    const warns = [];
    const log = { warn: (...a) => warns.push(a) };

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel: recorder({ applied: true }), removeLabel: recorder({ removed: true }), log });

    expect(res).toEqual({ stamped: true });
    expect(readLabelNodes.calls.length).toBe(1);
    expect(warns.some(([, msg]) => String(msg).includes("falling back to live read"))).toBe(true);
  });

  test("replica.labels throwing is swallowed by the outer guard — stamped:false, nothing propagates", () => {
    const replica = { labels: () => { throw new Error("db exploded"); } };

    let threw = false;
    let res;
    try {
      res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes: recorder({ ok: true, nodes: [] }), applyLabel: recorder({ applied: true }), removeLabel: recorder({ removed: true }) });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(res).toEqual({ stamped: false, reason: "threw" });
  });

  test("no replica (null) — live read path unchanged, no fallback warn", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:mini" }] });
    const warns = [];
    const log = { warn: (...a) => warns.push(a) };

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel: recorder({ applied: true }), removeLabel: recorder({ removed: true }), log });

    expect(res).toEqual({ stamped: true });
    expect(readLabelNodes.calls.length).toBe(1);
    expect(warns.length).toBe(0);
  });
});

describe("stampWorkerLabel — stale-replica exclusive-conflict live retry (Codex #2650 round-2)", () => {
  test("replica missed a live foreign sibling → apply conflicts → ONE live retry removes it and re-applies", () => {
    // Replica says no labels; live truth has worker:other still attached.
    const replica = { labels: recorder([]) };
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:other" }] });
    const removeLabel = recorder({ removed: true });
    let applyCalls = 0;
    const applyLabel = recorder(() => {
      applyCalls += 1;
      // First apply (off the stale replica read) hits the server-side
      // exclusive-group rejection; the live-retry apply succeeds.
      return applyCalls === 1 ? { applied: false, reason: "exclusive-conflict" } : { applied: true };
    });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(readLabelNodes.calls.length).toBe(1); // the live retry read
    expect(removeLabel.calls.length).toBe(1); // the stale sibling removed
    expect(removeLabel.calls[0][1]).toBe("worker:other");
    expect(applyLabel.calls.length).toBe(2);
  });

  test("live retry that STILL conflicts surfaces the failure — no infinite recursion", () => {
    const replica = { labels: recorder([]) };
    const readLabelNodes = recorder({ ok: true, nodes: [] });
    const applyLabel = recorder({ applied: false, reason: "exclusive-conflict" });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", replica, readLabelNodes, applyLabel, removeLabel: recorder({ removed: true }) });

    expect(res).toEqual({ stamped: false, reason: "exclusive-conflict" });
    expect(readLabelNodes.calls.length).toBe(1); // exactly one live retry
    expect(applyLabel.calls.length).toBe(2); // replica attempt + live attempt, then stop
  });

  test("exclusive-conflict retries once even off a LIVE read (roster-limited eager set can miss an in-group sibling)", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [] });
    const applyLabel = recorder({ applied: false, reason: "exclusive-conflict" });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel: recorder({ removed: true }) });

    expect(res).toEqual({ stamped: false, reason: "exclusive-conflict" });
    expect(readLabelNodes.calls.length).toBe(2); // initial + the one conflict retry
    expect(applyLabel.calls.length).toBe(2); // first attempt + retry attempt, then stop
  });
});

describe("stampWorkerLabel — group-scoped sibling removal (Codex #2650 round-3)", () => {
  test("an unrelated same-prefix label (worker:frontend, not roster-known) is NEVER removed when the apply succeeds", () => {
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l9", name: "worker:frontend" }] });
    const removeLabel = recorder({ removed: true });
    const applyLabel = recorder({ applied: true }); // different group — no exclusive conflict

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["mini", "mini-2"], readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(removeLabel.calls.length).toBe(0);
    expect(applyLabel.calls.length).toBe(1);
  });

  test("a decommissioned host's sibling (not in roster) swaps via the conflict-proven retry", () => {
    // worker:oldhost is OUR group's child but its host left the roster —
    // the eager pass skips it, the apply conflicts, the retry removes it.
    const readLabelNodes = recorder({ ok: true, nodes: [{ id: "l1", name: "worker:oldhost" }] });
    const removeLabel = recorder({ removed: true });
    let applyCalls = 0;
    const applyLabel = recorder(() => {
      applyCalls += 1;
      return applyCalls === 1 ? { applied: false, reason: "exclusive-conflict" } : { applied: true };
    });

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", knownHosts: ["mini", "mini-2"], readLabelNodes, applyLabel, removeLabel });

    expect(res).toEqual({ stamped: true });
    expect(removeLabel.calls.length).toBe(1);
    expect(removeLabel.calls[0][1]).toBe("worker:oldhost");
    expect(applyLabel.calls.length).toBe(2);
  });
});
