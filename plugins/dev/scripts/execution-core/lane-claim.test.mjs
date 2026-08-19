// lane-claim.test.mjs — CTL-2068.
// Run: cd plugins/dev/scripts/execution-core && bun test lane-claim.test.mjs
import { describe, expect, test } from "bun:test";
import {
  buildStateRank,
  buildKeyRank,
  classifyLaneClaimWrite,
  buildLaneClaimGuard,
  VERDICT,
  REASON,
} from "./lane-claim.mjs";

// The real stateMap from this workspace's Layer-1 config, not an invented one.
const STATE_MAP = {
  backlog: "Backlog",
  todo: "Todo",
  triage: "Triage",
  research: "Research",
  planning: "Plan",
  inProgress: "Implement",
  verifying: "Validate",
  reviewing: "Validate",
  remediating: "Remediate",
  inReview: "PR",
  done: "Done",
  canceled: "Canceled",
};
const RANK = buildStateRank(STATE_MAP);
const KEY_RANK = buildKeyRank();
const tr = (key) => KEY_RANK.get(key); // target rank, exactly as the guard computes it

// The two actor ids are the REAL ones read off the replica for CTC-787.
const FLEET = "78f8f491-a980-4b99-91a3-8280821f0821"; // "Catalyst Cloud" — the app-actor
const LANE = "c2a8cc92-cab6-4536-9500-0f24abdf702b"; // "Ryan Rozich" — how a lane's write appears
const BOTS = new Set([FLEET]);

describe("buildStateRank", () => {
  test("ranks each pipeline-written state at its EARLIEST phase", () => {
    expect([...RANK]).toEqual([
      ["Research", 1],
      ["Plan", 2],
      ["Implement", 3],
      ["Validate", 4],
      ["PR", 6],
    ]);
  });

  test("⛔ four phases write `inReview`; PR ranks at the FIRST of them (6), not the last (9)", () => {
    // A max/last-wins rank would put PR at teardown's index, making a legitimate
    // monitor-merge -> pr write look like a regression.
    expect(RANK.get("PR")).toBe(6);
  });

  test("⛔ does NOT rank states the pipeline never writes — that absence is load-bearing", () => {
    for (const name of ["Todo", "Backlog", "Triage", "Done", "Canceled"]) {
      expect(RANK.has(name)).toBe(false);
    }
  });

  test("a malformed stateMap yields an empty rank rather than throwing", () => {
    for (const bad of [null, undefined, [], "x", 7]) expect(buildStateRank(bad).size).toBe(0);
  });
});

describe("classifyLaneClaimWrite — the CTC-787 collision", () => {
  test("⭐ REFUSES the exact write that caused it: Implement -> Research, 74 s after a lane claim", () => {
    const v = classifyLaneClaimWrite({
      currentState: "Implement",
      targetRank: tr("research"),
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.REFUSE);
    expect(v.reason).toBe(REASON.REGRESSION_AGAINST_LANE_CLAIM);
    expect(v.currentRank).toBe(3);
    expect(v.targetRank).toBe(1);
  });

  test("⛔ NEGATIVE CONTROL — the identical regression by the FLEET is ALLOWED", () => {
    // This is the control that proves the guard keys on the ACTOR and not on the direction.
    // Without it, a guard that simply refused every backward write would pass the test above
    // while breaking the L3 destroy-and-recreate and the verify<->remediate cycle.
    const v = classifyLaneClaimWrite({
      currentState: "Implement",
      targetRank: tr("research"),
      lastChange: { actorId: FLEET },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.ALLOW);
    expect(v.reason).toBe(REASON.LAST_CHANGE_BY_FLEET);
  });
});

describe("classifyLaneClaimWrite — forward moves are never refused", () => {
  test("a lane-claimed ticket may still move FORWARD (Implement -> PR)", () => {
    const v = classifyLaneClaimWrite({
      currentState: "Implement",
      targetRank: tr("inReview"),
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.ALLOW);
    expect(v.reason).toBe(REASON.NOT_A_REGRESSION);
  });

  test("equal rank is not a regression (verify and review both write `Validate`)", () => {
    const v = classifyLaneClaimWrite({
      currentState: "Validate",
      targetRank: tr("verifying"),
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.ALLOW);
    expect(v.reason).toBe(REASON.NOT_A_REGRESSION);
  });
});

describe("classifyLaneClaimWrite — every decline is INCONCLUSIVE and NAMED, never a silent allow", () => {
  test("⛔ an EMPTY botUserIds set never refuses — with no known fleet ids everything looks like a lane", () => {
    for (const bots of [new Set(), undefined, null, ["x"]]) {
      const v = classifyLaneClaimWrite({
        currentState: "Implement",
        targetRank: tr("research"),
        lastChange: { actorId: LANE },
        botUserIds: bots,
        rank: RANK,
      });
      expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
      expect(v.reason).toBe(REASON.NO_BOT_IDS);
    }
  });

  test("absent history is INCONCLUSIVE — a replica outage must not wedge every phase write", () => {
    const v = classifyLaneClaimWrite({
      currentState: "Implement",
      targetRank: tr("research"),
      lastChange: null,
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.NO_HISTORY);
  });

  test("a history row with no actor is INCONCLUSIVE, not treated as a lane", () => {
    for (const actorId of [null, undefined, ""]) {
      const v = classifyLaneClaimWrite({
        currentState: "Implement",
        targetRank: tr("research"),
        lastChange: { actorId },
        botUserIds: BOTS,
        rank: RANK,
      });
      expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
      expect(v.reason).toBe(REASON.NO_ACTOR);
    }
  });

  test("⭐ Todo -> Research is INCONCLUSIVE, so the fleet can still start work a HUMAN queued", () => {
    // The single most important allow: a human moving a ticket to Todo is a non-fleet state
    // change, and Todo is unranked, so this must not read as a lane claim.
    const v = classifyLaneClaimWrite({
      currentState: "Todo",
      targetRank: tr("research"),
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.UNRANKED_CURRENT);
  });

  test("an unrankable TARGET key is INCONCLUSIVE — this guard abstains rather than guess an order", () => {
    const v = classifyLaneClaimWrite({
      currentState: "Implement",
      targetRank: undefined,
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.UNRANKED_TARGET);
  });

  test("a missing rank map is INCONCLUSIVE, not a crash and not a refusal", () => {
    const v = classifyLaneClaimWrite({ currentState: "Implement", targetRank: tr("research") });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.BAD_INPUT);
  });

  test("⛔ the no-args shape does not throw (the DEFAULT path, which no other test exercises)", () => {
    expect(() => classifyLaneClaimWrite()).not.toThrow();
    expect(classifyLaneClaimWrite().verdict).toBe(VERDICT.INCONCLUSIVE);
  });
});

describe("buildKeyRank — the TARGET side", () => {
  test("ranks each linear key at its earliest phase", () => {
    expect([...KEY_RANK]).toEqual([
      ["research", 1],
      ["planning", 2],
      ["inProgress", 3],
      ["verifying", 4],
      ["reviewing", 5],
      ["inReview", 6],
    ]);
  });

  test("⛔ `inReview` is written by four phases and ranks at the FIRST (6), not teardown (9)", () => {
    expect(KEY_RANK.get("inReview")).toBe(6);
  });

  test("takes no arguments — it is derived entirely from the workflow descriptor", () => {
    expect(buildKeyRank()).toEqual(KEY_RANK);
  });

  test("⭐ the verify<->remediate cycle is NOT a regression under a lane claim", () => {
    // review -> verify: current `Validate` ranks 4 (verify is the earlier of the two phases
    // that write it); target key `verifying` ranks 4. Equal, so allowed. If either side
    // ranked `Validate` at review's index instead, this legitimate cycle would be refused.
    const v = classifyLaneClaimWrite({
      currentState: "Validate",
      targetRank: tr("verifying"),
      lastChange: { actorId: LANE },
      botUserIds: BOTS,
      rank: RANK,
    });
    expect(v.verdict).toBe(VERDICT.ALLOW);
  });
});

describe("buildLaneClaimGuard — the assembled production shape", () => {
  const guard = (readLastStateChange) =>
    buildLaneClaimGuard({ stateMap: STATE_MAP, botUserIds: BOTS, readLastStateChange });

  test("⭐ end-to-end replay of CTC-787 through the assembled guard", () => {
    const v = guard(() => ({ actorId: LANE })).evaluate({
      ticket: "CTC-787",
      currentState: "Implement",
      targetKey: "research",
    });
    expect(v.verdict).toBe(VERDICT.REFUSE);
    expect(v.reason).toBe(REASON.REGRESSION_AGAINST_LANE_CLAIM);
  });

  test("⛔ a THROWING reader is 'could not look' — INCONCLUSIVE, never a refusal", () => {
    const v = guard(() => {
      throw new Error("replica gone");
    }).evaluate({ ticket: "CTC-787", currentState: "Implement", targetKey: "research" });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.NO_HISTORY);
  });

  test("a reader returning undefined (replica MISS) is INCONCLUSIVE", () => {
    const v = guard(() => undefined).evaluate({
      ticket: "CTC-787",
      currentState: "Implement",
      targetKey: "research",
    });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
  });

  test("⛔ the no-args factory produces a guard that abstains rather than throwing", () => {
    // The DEFAULT path: no stateMap, no bot ids, no reader — the shape an unconfigured
    // host gets. It must answer, not crash, and it must never refuse.
    const g = buildLaneClaimGuard();
    expect(() => g.evaluate()).not.toThrow();
    expect(g.evaluate().verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(
      g.evaluate({ ticket: "X-1", currentState: "Implement", targetKey: "research" }).verdict
    ).toBe(VERDICT.INCONCLUSIVE);
  });
});

describe("evaluateDispatch — the veto that actually stops the duplicate work", () => {
  const mk = (o = {}) =>
    buildLaneClaimGuard({
      stateMap: STATE_MAP,
      botUserIds: BOTS,
      readLastStateChange: () => ({ actorId: LANE }),
      readCurrentState: () => "Implement",
      ...o,
    });

  test("⭐ REFUSES the research dispatch on a lane-claimed ticket (the CTC-787 shape)", () => {
    const v = mk().evaluateDispatch({ ticket: "CTC-787", phase: "research" });
    expect(v.verdict).toBe(VERDICT.REFUSE);
    expect(v.reason).toBe(REASON.REGRESSION_AGAINST_LANE_CLAIM);
  });

  test("⛔ CONTROL — a FORWARD phase on the same claimed ticket still dispatches", () => {
    expect(mk().evaluateDispatch({ ticket: "CTC-787", phase: "pr" }).verdict).toBe(VERDICT.ALLOW);
  });

  test("⛔ CONTROL — the same backward phase is allowed when the FLEET made the last move", () => {
    const v = mk({ readLastStateChange: () => ({ actorId: FLEET }) }).evaluateDispatch({
      ticket: "CTC-787",
      phase: "research",
    });
    expect(v.verdict).toBe(VERDICT.ALLOW);
  });

  test("⭐ `triage` is never vetoed — it writes no status, and it is where fleet work begins", () => {
    const v = mk().evaluateDispatch({ ticket: "CTC-787", phase: "triage" });
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.reason).toBe(REASON.PHASE_WRITES_NO_STATUS);
  });

  test("an unreadable current state is INCONCLUSIVE — a replica outage never withholds work", () => {
    for (const reader of [
      () => null,
      () => "",
      () => {
        throw new Error("down");
      },
      undefined,
    ]) {
      const v = mk({ readCurrentState: reader }).evaluateDispatch({
        ticket: "T-1",
        phase: "research",
      });
      expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
      expect(v.reason).toBe(REASON.NO_CURRENT_STATE);
    }
  });

  test("⛔ the kill switch disables ONLY the dispatch veto; the write guard stays armed", () => {
    const g = mk({ dispatchVeto: false });
    expect(g.evaluateDispatch({ ticket: "CTC-787", phase: "research" }).reason).toBe(
      REASON.DISPATCH_VETO_DISABLED
    );
    // ⭐ The half that must survive the switch.
    expect(
      g.evaluate({ ticket: "CTC-787", currentState: "Implement", targetKey: "research" }).verdict
    ).toBe(VERDICT.REFUSE);
  });

  test("⛔ the no-args guard does not throw and never vetoes", () => {
    const g = buildLaneClaimGuard();
    expect(() => g.evaluateDispatch()).not.toThrow();
    expect(g.evaluateDispatch({ ticket: "X-1", phase: "research" }).verdict).toBe(
      VERDICT.INCONCLUSIVE
    );
  });
});
