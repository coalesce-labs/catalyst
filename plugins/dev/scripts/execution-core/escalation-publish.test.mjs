// escalation-publish.test.mjs — CTL-2159. THE producer sweep's proof.
//
// One property, asserted per producer: under its own trigger condition the
// producer no longer writes the Linear `needs-human` label, AND the correct
// replacement fired (retry kept / alert-class recorded / ask filed).
//
// ⛔ WHY THIS SUITE IS SHAPED AROUND `applyLabel` CALLS AND NOT AROUND A GREP.
// The plan's producer inventory was built from a regex over `labelOnce(` /
// `labelNeedsHumanUnlessBeliefOwner(` / `applyStalledLabel(` / `status:
// "needs-human"`. SIX real producers match none of those tokens — they route
// through `routeStuckTicketToDelegate` → delegate-first.mjs:70, including
// scheduler.mjs:9294, the highest-volume one. An agent that sweeps by that regex
// passes its own grep and leaves the volume producer running. So every test here
// drives the REAL call path with a spy `applyLabel` and asserts the spy was
// never called with "needs-human" — a property the regex cannot fake.
//
// Run: bun test plugins/dev/scripts/execution-core/escalation-publish.test.mjs
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  publishEscalation,
  askFieldsFromExplanation,
  askTransportMode,
  explanationForStall,
  ESCALATION_MARKER_LABEL,
} from "./escalation-publish.mjs";
import { labelNeedsHumanUnlessBeliefOwner, labelMarkerBase } from "./label-guard.mjs";
import { routeStuckTicketToDelegate } from "./delegate-first.mjs";
import { executeEscalations } from "./beliefs/escalate.mjs";
import { STALL_CLASS, ESCALATION_PUBLISHED_FIELD } from "./stall-class.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ctl2159-"));
  return dir;
}
function workerDir(orchDir, ticket) {
  const d = join(orchDir, "workers", ticket);
  mkdirSync(d, { recursive: true });
  return d;
}
/** A spy that records every label write attempt. */
function labelSpy() {
  const calls = [];
  return {
    calls,
    writeStatus: {
      applyLabel: (arg) => {
        calls.push(arg);
        return { applied: true };
      },
    },
    needsHumanCalls: () => calls.filter((c) => c?.label === "needs-human"),
  };
}
function readSignal(orchDir, ticket, phase = "recovery-pass") {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

const QUIET_ENV = { CATALYST_ESCALATION_ASK: "off" };

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CHOKEPOINT. Every non-belief producer reaches labelNeedsHumanUnlessBeliefOwner.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ the chokepoint no longer writes the Linear label", () => {
  test("a SYSTEM stall writes ZERO labels and still reports PUBLISHED", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-1");
    const spy = labelSpy();
    const published = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-1", spy.writeStatus, {
      env: QUIET_ENV,
      site: "terminal-sweep",
      explanation: { problem: "sdk overloaded", failureReason: "sdk-overloaded-exhausted" },
    });
    expect(spy.calls).toEqual([]);
    // ⛔ The return value is a RETRY CONTRACT — five loops read it as their STOP.
    expect(published).toBe(true);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("POSITIVE CONTROL: the same spy DOES record a label when one is written", () => {
    // Without this, "zero needs-human calls" could mean the spy is never wired.
    const spy = labelSpy();
    spy.writeStatus.applyLabel({ ticket: "CTL-1", label: "queued" });
    expect(spy.calls).toEqual([{ ticket: "CTL-1", label: "queued" }]);
    expect(spy.needsHumanCalls()).toEqual([]);
  });

  test("the once-marker is still written — boot-resume's auto-resume suppression", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-2");
    labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-2", labelSpy().writeStatus, {
      env: QUIET_ENV,
      site: "watchdog-kill",
      explanation: { problem: "worker died" },
    });
    // boot-resume.mjs:493 reads EXACTLY this path to suppress auto-resume of a
    // chronically-failing ticket. Renaming or dropping it silently re-arms that.
    expect(existsSync(`${labelMarkerBase(orchDir, "CTL-2", ESCALATION_MARKER_LABEL)}.applied`)).toBe(
      true
    );
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("a second call is a marker-guarded no-op — returns false, writes nothing", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-3");
    const spy = labelSpy();
    const first = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-3", spy.writeStatus, {
      env: QUIET_ENV,
      site: "terminal-sweep",
      explanation: { problem: "x" },
    });
    const second = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-3", spy.writeStatus, {
      env: QUIET_ENV,
      site: "terminal-sweep",
      explanation: { problem: "x" },
    });
    expect([first, second]).toEqual([true, false]);
    expect(spy.calls).toEqual([]);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("belief-owner deferral is unchanged (CTL-1241)", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-4");
    const spy = labelSpy();
    const r = labelNeedsHumanUnlessBeliefOwner(orchDir, "CTL-4", spy.writeStatus, {
      env: { CATALYST_INTENTS_ENFORCE: "1" },
      site: "terminal-sweep",
      log: { info: () => {} },
    });
    expect(r).toBe(false);
    expect(spy.calls).toEqual([]);
    expect(existsSync(`${labelMarkerBase(orchDir, "CTL-4", ESCALATION_MARKER_LABEL)}.applied`)).toBe(
      false
    );
    rmSync(orchDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CLASS DECIDES WHAT IS PUBLISHED.
// ─────────────────────────────────────────────────────────────────────────────
describe("the publication table", () => {
  test("SYSTEM: zero artifacts, class stamped, NOT marked escalationPublished", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-10");
    const asks = [];
    const ok = publishEscalation(orchDir, "CTL-10", {
      env: {},
      site: "terminal-sweep",
      reason: "sdk-overloaded-exhausted",
      markerBase: labelMarkerBase(orchDir, "CTL-10", ESCALATION_MARKER_LABEL),
      fileAsk: (f) => {
        asks.push(f);
        return { ok: true };
      },
      writeSignal: ({ fields }) => {
        writeFileSync(
          join(orchDir, "workers", "CTL-10", "phase-recovery-pass.json"),
          JSON.stringify({ ticket: "CTL-10", ...fields })
        );
      },
    });
    expect(ok).toBe(true);
    expect(asks).toEqual([]);
    const sig = readSignal(orchDir, "CTL-10");
    expect(sig.stallClass).toBe(STALL_CLASS.SYSTEM);
    // ⛔ Stamping this for SYSTEM would silence the unstuck sweep's repair of
    // remediate-cycle-cap-exhausted / prior-artifact-retry-exhausted stalls.
    expect(sig[ESCALATION_PUBLISHED_FIELD]).toBeUndefined();
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("ASK with real evidence: ONE ask filed, carrying `blocks` to the work ticket", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-11");
    const asks = [];
    const ok = publishEscalation(orchDir, "CTL-11", {
      env: {},
      site: "dep-cycle",
      reason: "design-signoff-gate",
      explanation: {
        problem: "the CTL-11 dependency cycle cannot be broken by an agent",
        call_to_action: "break the CTL-11 ↔ CTL-12 dependency cycle",
        why_asking: "only a person can decide which side of the cycle gives way",
        recommendation: "drop the CTL-12 → CTL-11 edge",
        options: [
          { label: "drop CTL-12 → CTL-11", tradeoff: "CTL-12 ships without the shared helper" },
          { label: "merge the two tickets", tradeoff: "one larger, slower change" },
        ],
      },
      markerBase: labelMarkerBase(orchDir, "CTL-11", ESCALATION_MARKER_LABEL),
      fileAsk: (f) => {
        asks.push(f);
        return { ok: true };
      },
    });
    expect(ok).toBe(true);
    expect(asks).toHaveLength(1);
    expect(asks[0].blocks).toEqual(["CTL-11"]);
    expect(asks[0].team).toBe("CTL");
    expect(asks[0].options).toHaveLength(2);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("⛔ ASK without answerable evidence DOWNGRADES to HELD — it never files a content-free ask", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-12");
    const asks = [];
    const ok = publishEscalation(orchDir, "CTL-12", {
      env: {},
      site: "dep-cycle",
      reason: "design-signoff-gate",
      explanation: { problem: "needs a human" }, // no options, no default
      markerBase: labelMarkerBase(orchDir, "CTL-12", ESCALATION_MARKER_LABEL),
      fileAsk: (f) => {
        asks.push(f);
        return { ok: true };
      },
      writeSignal: ({ fields }) => {
        writeFileSync(
          join(orchDir, "workers", "CTL-12", "phase-recovery-pass.json"),
          JSON.stringify({ ticket: "CTL-12", ...fields })
        );
      },
    });
    expect(ok).toBe(true);
    expect(asks).toEqual([]); // CTC-653: an option-less ask is structurally undecidable
    expect(readSignal(orchDir, "CTL-12").stallClass).toBe(STALL_CLASS.HELD);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("a transient ask failure is NOT published — no marker, so the next tick retries", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-13");
    const ok = publishEscalation(orchDir, "CTL-13", {
      env: {},
      site: "dep-cycle",
      reason: "design-signoff-gate",
      explanation: {
        problem: "p",
        call_to_action: "c",
        why_asking: "w",
        recommendation: "r",
        options: [
          { label: "a", tradeoff: "t1" },
          { label: "b", tradeoff: "t2" },
        ],
      },
      markerBase: labelMarkerBase(orchDir, "CTL-13", ESCALATION_MARKER_LABEL),
      fileAsk: () => ({ ok: false, terminal: false, reason: "ask-exit-1" }),
    });
    const base = labelMarkerBase(orchDir, "CTL-13", ESCALATION_MARKER_LABEL);
    expect(ok).toBe(false);
    expect(existsSync(`${base}.applied`)).toBe(false);
    expect(existsSync(`${base}.skipped`)).toBe(false);
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("a TERMINAL ask failure writes .skipped — labelUnrecoverable stays true, so the cooldown is still written", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-14");
    publishEscalation(orchDir, "CTL-14", {
      env: {},
      site: "dep-cycle",
      reason: "design-signoff-gate",
      explanation: {
        problem: "p",
        call_to_action: "c",
        why_asking: "w",
        recommendation: "r",
        options: [
          { label: "a", tradeoff: "t1" },
          { label: "b", tradeoff: "t2" },
        ],
      },
      markerBase: labelMarkerBase(orchDir, "CTL-14", ESCALATION_MARKER_LABEL),
      fileAsk: () => ({ ok: false, terminal: true, reason: "ask-unverified" }),
    });
    // recovery.mjs:3151 reads exactly this marker as `labelUnrecoverable`.
    expect(existsSync(`${labelMarkerBase(orchDir, "CTL-14", ESCALATION_MARKER_LABEL)}.skipped`)).toBe(
      true
    );
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("the ask transport can be switched off without a code edit", () => {
    expect(askTransportMode({ CATALYST_ESCALATION_ASK: "off" })).toBe("off");
    expect(askTransportMode({})).toBe("on");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SIX INVISIBLE PRODUCERS — the ones the plan's regex could not see.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ the routeStuckTicketToDelegate producers (audit Gap 1)", () => {
  // These six sites — scheduler.mjs:3330 / :7477 / :8548 / :9294 (the volume
  // producer), monitor.mjs:1101, stale-pr-rescue-timer.mjs:488 — all reach the
  // label ONLY through this seam. Proving the seam is label-free proves all six.
  test("with delegate-first OFF the seam still publishes, and writes NO label", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-20");
    const spy = labelSpy();
    const r = routeStuckTicketToDelegate(orchDir, "CTL-20", {
      site: "terminal-sweep",
      reason: "orphan-sweep-stale",
      applyLabel: spy.writeStatus,
      env: { ...QUIET_ENV }, // delegate-first unset ⇒ mode "off" ⇒ the direct path
      log: { info: () => {}, warn: () => {} },
    });
    expect(spy.needsHumanCalls()).toEqual([]);
    expect(spy.calls).toEqual([]);
    // ⛔ The delegate RE-DISPATCH and the publish are two arms of one branch.
    // `labelled` staying true is what keeps stale-pr-rescue's escalatedAt latching
    // and monitor's markTriageCapped firing.
    expect(r).toEqual({ routed: false, labelled: true });
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("POSITIVE CONTROL: the seam's label spy fires for a NON-needs-human label", () => {
    const spy = labelSpy();
    spy.writeStatus.applyLabel({ ticket: "CTL-20", label: "blocked" });
    expect(spy.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE BELIEF PRODUCER — beliefs/escalate.mjs:151, a `labelOnceFn(` call that
//    matches NEITHER of the two seams above.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ the belief engine's escalate seam", () => {
  test("the default publish seam writes no label and returns labelOnce's contract", () => {
    const orchDir = scratch();
    workerDir(orchDir, "CTL-30");
    // Drive the module's own default (no labelOnceFn injected) through a fake db.
    const rows = [{ subject: "CTL-30/implement", value: JSON.stringify({ why: "sdk overloaded" }) }];
    const db = {
      query: () => ({ all: () => rows }),
      prepare: () => ({ run: () => ({ changes: 0 }) }),
    };
    const spy = labelSpy();
    const out = executeEscalations(db, "tick-1", {
      orchDir,
      writeStatus: spy.writeStatus,
      enforce: true,
      env: { ...QUIET_ENV },
      appendEvent: () => {},
    });
    expect(spy.needsHumanCalls()).toEqual([]);
    // `paged` is bound to the FIRST publish — the once-semantics survived.
    expect(out.paged).toBe(1);
    expect(existsSync(`${labelMarkerBase(orchDir, "CTL-30", ESCALATION_MARKER_LABEL)}.applied`)).toBe(
      true
    );
    rmSync(orchDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE ANTI-MANUFACTURE RULE (audit finding (b)).
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ nothing manufactures a human decision any more", () => {
  test("an unexplained SYSTEM stall gets NO explanation card", () => {
    // The old path: coerceExplanation({}, { canExecute: false }) → a DECISION card
    // reading "priority call the agent cannot make unilaterally". 37 of those in
    // one day, all from one provider outage.
    expect(explanationForStall({ fields: {}, ticket: "CTL-40", reason: "sdk-overloaded-exhausted" }))
      .toBeNull();
  });

  test("⛔ deleting only the degrade branch is NOT the fix: an AUTHORIZATION is also refused", () => {
    // canExecute:true routes coerceExplanation to the authorization branch, which
    // emits "approve continuation or cancel?" — still a per-ticket human artifact.
    // The class gate refuses it for the same reason.
    expect(
      explanationForStall({
        fields: { problem: "x" },
        ticket: "CTL-41",
        reason: "prior-artifact-retry-exhausted",
      })
    ).toBeNull();
  });

  test("an ASK-classified stall still gets its card", () => {
    const e = explanationForStall({
      fields: { problem: "PRD required before scoping" },
      ticket: "CTL-42",
      reason: "needs-human:prd-required-before-scoping",
    });
    expect(e).not.toBeNull();
    expect(typeof e.call_to_action).toBe("string");
  });

  test("POSITIVE CONTROL: the gate is the CLASS, not a hardcoded null", () => {
    // If explanationForStall simply returned null always, the ASK case above would
    // fail — it does not. And a MOOT reason must still be refused.
    expect(explanationForStall({ fields: { problem: "x" }, ticket: "CTL-43", reason: "empty-branch" }))
      .toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE ASK-FIELD FLOOR — pure.
// ─────────────────────────────────────────────────────────────────────────────
describe("askFieldsFromExplanation refuses anything unanswerable", () => {
  const full = {
    problem: "p",
    call_to_action: "c",
    why_asking: "w",
    recommendation: "r",
    options: [
      { label: "a", tradeoff: "t1" },
      { label: "b", tradeoff: "t2" },
    ],
  };
  test("a complete explanation yields ask fields", () => {
    const f = askFieldsFromExplanation(full, { ticket: "CTC-9" });
    expect(f.team).toBe("CTC");
    expect(f.blocks).toEqual(["CTC-9"]);
    expect(f.options).toHaveLength(2);
    expect(f.defaultIfSilent).toBe("r");
  });
  test("one option is not enough (CTC-653)", () => {
    expect(askFieldsFromExplanation({ ...full, options: [full.options[0]] }, { ticket: "CTC-9" }))
      .toBeNull();
  });
  test("no default-if-silent is refused", () => {
    const { recommendation, ...noDefault } = full;
    expect(askFieldsFromExplanation(noDefault, { ticket: "CTC-9" })).toBeNull();
  });
  test("null explanation is refused", () => {
    expect(askFieldsFromExplanation(null, { ticket: "CTC-9" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ENROLMENT — the half that makes the deletion survive a fresh install.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ enrolment no longer creates the label", () => {
  const setupSh = join(import.meta.dir, "..", "setup-execution-core-states.sh");
  const checkSh = join(import.meta.dir, "..", "check-setup.sh");
  const checkProjSh = join(import.meta.dir, "..", "check-project-setup.sh");

  test("worker_status_members carries no needs-human entry", () => {
    const src = readFileSync(setupSh, "utf8");
    const block = src.slice(src.indexOf("worker_status_members()"), src.indexOf("build_issue_label_group_create_mutation"));
    expect(block).not.toContain("needs-human");
    // POSITIVE CONTROL: the same slice DOES contain a member that survives.
    expect(block).toContain("needs-input");
  });

  test("⛔ the two assertion loops no longer WARN on its absence (audit Gap 7)", () => {
    // A host that stops creating a label and then warns that it is missing is
    // worse than either half alone.
    for (const p of [checkSh, checkProjSh]) {
      const src = readFileSync(p, "utf8");
      const loops = src.split("\n").filter((l) => l.includes("queued blocked needs-input"));
      expect(loops.length).toBeGreaterThan(0); // positive control: the loop exists
      for (const l of loops) expect(l).not.toContain("needs-human");
    }
  });
});
