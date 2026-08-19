// CTL-1961 — the agent tools' write-path decision.
//
// The property that matters is NOT "shadow writes direct" (obvious); it is that
// "the proxy is OFF" and "I could not reach the proxy" are never collapsed into the
// same answer. Collapsing them is how a tool writes direct forever while looking routed
// — which is exactly what the first cut of this change did, by importing an export name
// that does not exist.
import { describe, test, expect } from "bun:test";
import { decideWritePath, WRITE_PROXY_MODES } from "./linear-write-path.mjs";

describe("decideWritePath — off", () => {
  test("off writes direct, says nothing, observes nothing", () => {
    expect(decideWritePath({ mode: "off", proxyReady: false })).toEqual({
      action: "direct",
      observe: false,
      reason: null,
    });
  });

  test("off is unaffected by a READY proxy — an installed transport is not a mandate", () => {
    expect(decideWritePath({ mode: "off", proxyReady: true }).action).toBe("direct");
    expect(decideWritePath({ mode: "off", proxyReady: true }).observe).toBe(false);
  });
});

describe("decideWritePath — enforce", () => {
  test("enforce with a ready proxy routes to the cloud", () => {
    expect(decideWritePath({ mode: "enforce", proxyReady: true })).toEqual({
      action: "proxy",
      observe: false,
      reason: null,
    });
  });

  test("⛔ THE DEFECT THIS PINS: enforce WITHOUT a proxy REFUSES — it must never write direct", () => {
    const d = decideWritePath({
      mode: "enforce",
      proxyReady: false,
      unavailableReason: "proxy modules unreachable: Cannot find module",
    });
    expect(d.action).toBe("refuse");
    // ⛔ the reason must survive to the operator — a bare refusal is not diagnosable
    expect(d.reason).toContain("Cannot find module");
  });

  test("enforce without a proxy AND without a stated reason still refuses, with a default one", () => {
    const d = decideWritePath({ mode: "enforce", proxyReady: false });
    expect(d.action).toBe("refuse");
    expect(typeof d.reason).toBe("string");
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("decideWritePath — shadow", () => {
  test("shadow with a ready proxy: direct write PLUS an observation", () => {
    expect(decideWritePath({ mode: "shadow", proxyReady: true })).toEqual({
      action: "direct",
      observe: true,
      reason: null,
    });
  });

  test("⭐ shadow with NO proxy still writes — but says why it could not observe", () => {
    // shadow's contract is "change nothing the operator can see in Linear", so an
    // unreachable proxy must not block the write. It must still be audible.
    const d = decideWritePath({ mode: "shadow", proxyReady: false, unavailableReason: "out-of-tree copy" });
    expect(d.action).toBe("direct");
    expect(d.observe).toBe(false);
    expect(d.reason).toBe("out-of-tree copy");
  });
});

describe("⛔ the distinction the whole module exists for", () => {
  test("`off` and `unavailable` are NEVER the same answer under enforce", () => {
    const off = decideWritePath({ mode: "off", proxyReady: false });
    const unavailable = decideWritePath({ mode: "enforce", proxyReady: false, unavailableReason: "x" });
    // Same inputs to a naive implementation ("no transport → write direct"); different answers here.
    expect(off.action).toBe("direct");
    expect(unavailable.action).toBe("refuse");
    expect(off.action).not.toBe(unavailable.action);
  });

  test("`off` and `unavailable` differ under shadow too — by the reason, not the action", () => {
    const off = decideWritePath({ mode: "off", proxyReady: false });
    const unavailable = decideWritePath({ mode: "shadow", proxyReady: false, unavailableReason: "x" });
    expect(off.action).toBe(unavailable.action); // both write
    expect(off.reason).toBeNull();
    expect(unavailable.reason).toBe("x"); // ...but only one of them is silent
  });
});

describe("⛔ unknown / hostile modes degrade to off, never to enforce", () => {
  test("a typo'd mode is treated as off — it must not REFUSE a write on a typo", () => {
    for (const bad of ["Enforce", "ENFORCE", "enforce ", "on", "true", "", null, undefined, 7, {}]) {
      const d = decideWritePath({ mode: bad, proxyReady: true });
      expect(d.action).toBe("direct");
      expect(d.observe).toBe(false);
    }
  });

  test("no arguments at all is `off`, not a crash", () => {
    expect(decideWritePath()).toEqual({ action: "direct", observe: false, reason: null });
  });

  test("the mode vocabulary is exactly these three", () => {
    expect([...WRITE_PROXY_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-1961 — a SOURCE-LEVEL guard, because the property lives in a script that
// cannot be imported (top-level await + it writes to Linear on import).
//
// The property: `linear-reply.mjs`'s eyes-clear is BEST-EFFORT. It runs after the
// comment has already been posted, so exiting non-zero there would report failure for
// a reply that succeeded — and `ask.mjs` invokes this script, so a retry could
// double-post. Both minis run CATALYST_LINEAR_WRITE_PROXY=enforce, so this is the live
// path. The original code expressed it as `try { … } catch {}`; routing must not quietly
// upgrade a swallowed cleanup into a fatal one.
//
// `linear-ack.mjs` is deliberately the OPPOSITE — there the reaction IS the operation, so
// refusing is correct — and that asymmetry is what makes this test discriminating rather
// than a tautology.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url))) === ""
  ? "."
  : join(dirname(fileURLToPath(import.meta.url)), "..");

/** The eyes-clear block of linear-reply.mjs, sliced by its own anchors. */
function eyesClearBlock() {
  const src = readFileSync(join(SCRIPTS, "linear-reply.mjs"), "utf8");
  const start = src.indexOf("CTL-1961 — WHY ONLY THIS WRITE IS ROUTED");
  const end = src.indexOf("console.log(JSON.stringify({ ok:");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("anchors not found — the guard cannot report a clean pass it did not earn");
  }
  return src.slice(start, end);
}

describe("⛔ the eyes-clear must never fail a reply that already posted", () => {
  test("linear-reply.mjs's eyes-clear block contains NO process.exit", () => {
    expect(eyesClearBlock()).not.toContain("process.exit");
  });

  test("⭐ POSITIVE CONTROL: the same scan DOES find linear-ack's deliberate refusal", () => {
    // Without this, the test above would pass just as happily against a file it failed to
    // read, or a scan that matches nothing. linear-ack SHOULD exit — the reaction is its
    // whole operation — so finding it proves the instrument works.
    const ack = readFileSync(join(SCRIPTS, "linear-ack.mjs"), "utf8");
    expect(ack).toContain("process.exit(1)");
  });

  test("⛔ the anchors themselves are asserted — a silent slice failure must throw, not pass", () => {
    // If either anchor is renamed the slice would be empty, and an empty string trivially
    // "contains no process.exit". eyesClearBlock throws instead; this pins that.
    expect(eyesClearBlock().length).toBeGreaterThan(200);
  });
});

// ── CTL-2026: the branch the TOOLS restate when this very file is unreachable ────────
//
// `linear-ack.mjs` / `linear-reply.mjs` guard the import of this module (an out-of-tree
// copy cannot resolve it) and, in the catch, cannot then ASK it what to do. They carry a
// four-line inline fallback instead. That fallback is not a second dialect — it restates
// exactly one branch of the function below, the `proxyReady:false` column — but a
// restatement drifts the moment this file changes and nothing tells the author.
//
// So this pins the property the fallback depends on, over the WHOLE mode set rather than
// the three modes someone happened to think of: with no transport, refusal is reserved to
// `enforce` and nothing else. If that ever stops being true, this fails and names the two
// files that must change with it.
describe("the unreachable-leaf fallback (linear-ack.mjs / linear-reply.mjs)", () => {
  test("with no transport, `refuse` is reserved to enforce — every other mode writes direct", () => {
    for (const mode of WRITE_PROXY_MODES) {
      const d = decideWritePath({ mode, proxyReady: false, unavailableReason: "modules unreachable" });
      expect(`${mode} -> ${d.action}`).toBe(`${mode} -> ${mode === "enforce" ? "refuse" : "direct"}`);
    }
  });

  test("an unrecognised mode is not a licence to refuse (it degrades to off, i.e. direct)", () => {
    // The tools' fallback compares against the literal "enforce"; anything else must be
    // safe to treat as direct, or a typo'd env var would silently stop every reply.
    for (const mode of ["", "ENFORCE", "on", "1", undefined, null]) {
      expect(decideWritePath({ mode, proxyReady: false }).action).toBe("direct");
    }
  });

  test("with no transport, nothing is ever OBSERVED — the fallback has no proxy to observe with", () => {
    for (const mode of WRITE_PROXY_MODES) {
      expect(decideWritePath({ mode, proxyReady: false }).observe).toBe(false);
    }
  });
});
