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

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

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

    stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

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

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

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
      res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });
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

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });

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

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });
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

    const res = stampWorkerLabel({ ticket: "CTL-1", hostName: "mini", readLabelNodes, applyLabel, removeLabel });
    expect(res).toEqual({ stamped: false, reason: "swap-deferred" });

    await Promise.resolve();
    await Promise.resolve();
    expect(applyLabel.calls.length).toBe(0);
  });
});
