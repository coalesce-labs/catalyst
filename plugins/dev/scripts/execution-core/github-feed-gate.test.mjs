// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-gate.test.mjs

import { describe, expect, test } from "bun:test";
import {
  EXCLUSION_REASONS,
  GITHUB_CONSUMED_NAMES,
  GITHUB_LOSSY_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
  computeSuppressible,
  decideDispatch,
  githubLossyNames,
  isGithubDispatchClass,
  sourceOf,
} from "./github-feed-gate.mjs";
import {
  GITHUB_DISPATCH_CLASS_NAMES,
  GITHUB_UNCOVERED_NAMES,
  SOURCE_CLOUD_FEED,
} from "./github-feed-event.mjs";
import { PUSH_IS_LOSSY } from "./github-feed-source.mjs";

const ev = (name, { attrs = {}, payload = {} } = {}) => ({
  attributes: { "event.name": name, ...attrs },
  body: { payload },
});
const smee = (name) => ev(name, { attrs: { "webhook.delivery.id": "delivery-1" } });
const feed = (name, { authority = true } = {}) =>
  ev(name, { payload: { source: SOURCE_CLOUD_FEED, ...(authority ? { feedAuthority: true } : {}) } });

describe("⛔ the gate's universe is what the ROUTER consumes, not what the producer emits", () => {
  test("both uncovered names are IN the universe — they are the two most dangerous names here", () => {
    // router.mjs:1497 (check_suite → CI wait) and :1513 (pr.merged →
    // setFilterStateMerged, the merge→deploy join key) both act on these.
    // Taking the producer's emit-list as the universe answered "not-dispatch-class"
    // for pr.merged — safe by accident, and it would have recorded that the gate
    // never looked rather than that it looked and refused.
    for (const name of GITHUB_UNCOVERED_NAMES) {
      expect(GITHUB_CONSUMED_NAMES).toContain(name);
      expect(isGithubDispatchClass(smee(name))).toBe(true);
    }
  });

  test("a github.* name the router does NOT consume gets no opinion", () => {
    const v = decideDispatch(smee("github.issues.opened"), { mode: "enforce", isReady: () => true });
    expect(v.reason).toBe("not-dispatch-class");
    expect(v.suppress).toBe(false);
  });
});

describe("⛔ suppression is per NAME, and the excluded set is COMPUTED from the producer's own declarations", () => {
  test("the suppressible set is exactly the consumed names minus uncovered minus lossy", () => {
    const excluded = new Set([...GITHUB_UNCOVERED_NAMES, ...GITHUB_LOSSY_NAMES]);
    expect(GITHUB_SUPPRESSIBLE_NAMES).toEqual(GITHUB_CONSUMED_NAMES.filter((n) => !excluded.has(n)));
    // The property that matters, stated independently of the arithmetic above:
    // nothing the producer declared uncovered is suppressible.
    for (const n of GITHUB_UNCOVERED_NAMES) expect(GITHUB_SUPPRESSIBLE_NAMES).not.toContain(n);
  });

  test("⚠️ the lossy set TRACKS PUSH_IS_LOSSY — driven in BOTH states, not asserted as a tautology", () => {
    // ⛔ The obvious version of this test —
    //      expect(GITHUB_LOSSY_NAMES).toEqual(PUSH_IS_LOSSY ? ["github.push"] : [])
    //    — passes whether the set is derived or typed, because PUSH_IS_LOSSY is true
    //    today and both branches evaluate to the same literal. It asserts nothing and
    //    would still pass after CTC-704 lands, when the set is supposed to be empty.
    expect(githubLossyNames(true)).toEqual(["github.push"]);
    expect(githubLossyNames(false)).toEqual([]);
    expect(GITHUB_LOSSY_NAMES).toEqual(githubLossyNames(PUSH_IS_LOSSY));
  });

  test("⭐ the post-CTC-704 world: when pushes is keyed per delivery, push becomes suppressible", () => {
    // Drives the change that closes the gap, today, so landing CTC-704 is a flag
    // flip in one file rather than a second trip through this gate's design.
    const after = computeSuppressible({
      consumed: GITHUB_CONSUMED_NAMES,
      uncovered: GITHUB_UNCOVERED_NAMES,
      lossy: githubLossyNames(false),
    });
    expect(after).toContain("github.push");
    // and the two genuinely-uncovered names are STILL excluded — closing one gap
    // must not silently open the other two.
    for (const n of GITHUB_UNCOVERED_NAMES) expect(after).not.toContain(n);
  });

  test("⭐ the post-CTC-712 world: emptying the uncovered list makes those names suppressible", () => {
    const after = computeSuppressible({
      consumed: GITHUB_CONSUMED_NAMES,
      uncovered: [],
      lossy: GITHUB_LOSSY_NAMES,
    });
    expect(after).toContain("github.check_suite.completed");
    expect(after).not.toContain("github.push"); // still lossy until CTC-704
  });

  test("every excluded name carries a reason naming the ticket that closes it", () => {
    for (const n of [...GITHUB_UNCOVERED_NAMES, ...GITHUB_LOSSY_NAMES]) {
      expect(EXCLUSION_REASONS[n]).toMatch(/CTC-\d+/);
    }
  });
});

describe("⛔ enforce must NOT suppress smee for a name with no faithful replacement", () => {
  // Precondition asserted before the outcome: a fully-armed, ready producer is the
  // ONLY state in which this rule can be observed to bind. Asserting the outcome
  // under a not-ready producer would pass with the rule deleted.
  const armed = { mode: "enforce", isReady: () => true };

  test("a suppressible name IS suppressed when armed — the control that proves the rest is not vacuous", () => {
    const v = decideDispatch(smee("github.pr.opened"), armed);
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("smee-captured");
  });

  test("⭐ github.pr.merged is now SUPPRESSIBLE — CTC-691 landed in schema 0.1.17", () => {
    // This asserted the opposite until the pin. `merge_commit_sha` is a real column,
    // the producer emits the name, and the gate may therefore suppress smee's copy.
    const v = decideDispatch(smee("github.pr.merged"), armed);
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("smee-captured");
  });

  test("github.check_suite.completed survives — no suite row (CTC-667 item 4)", () => {
    const v = decideDispatch(smee("github.check_suite.completed"), armed);
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("no-replacement:no-suite-row:CTC-667-item-4");
  });

  test("⛔ github.push survives — the collapse loses an ARRIVAL, not a value (CTC-704)", () => {
    // router.mjs:1582 reads scope.ref and nothing else, and sets no wakeStateKey, so
    // every arriving push is its own wake. Suppressing smee here under enforce is a
    // wake that never happens with no second copy to recover it from.
    const v = decideDispatch(smee("github.push"), armed);
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("lossy-replacement:pushes-keyed-per-ref:CTC-704");
  });

  test("⚠️ an excluded name reports ITS OWN reason even while the producer is un-armed", () => {
    // ⛔ WHAT THIS OWNS, precisely — and my first version of it asserted the wrong
    //    thing. I wrote it as an order control ("readiness first would let a ready
    //    producer suppress pr.merged") and the mutation DID NOT FIRE: moving the
    //    no-replacement block below the readiness check still returns suppress:false
    //    for pr.merged, because the block simply runs later and catches it anyway.
    //    The suppress bit is invariant under that reordering. The test passed with
    //    the rule it was named for deleted.
    //
    //    The order buys DIAGNOSIS, not safety, and that is worth a control of its
    //    own: an operator reading the capture file mid-cutover has to tell
    //    "smee kept authority because the producer is stalled" (transient, chase it)
    //    from "because this name has no replacement" (permanent until CTC-691 lands).
    //    Under the wrong order every excluded name reports `enforce-not-armed`
    //    whenever the producer happens to be un-armed, and the two collapse.
    const v = decideDispatch(smee("github.check_suite.completed"), { mode: "enforce", isReady: () => false });
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("no-replacement:no-suite-row:CTC-667-item-4");
    expect(v.reason).not.toMatch(/^enforce-not-armed/);
  });
});

describe("the readiness lever — enforce hands authority back to smee whenever the producer cannot produce", () => {
  const cases = [
    ["absent probe", undefined, "enforce-not-armed"],
    ["null probe", null, "enforce-not-armed"],
    ["boolean false", false, "enforce-not-armed"],
    ["probe returns false", () => false, "enforce-not-armed"],
    ["probe throws", () => { throw new Error("boom"); }, "enforce-not-armed:probe-threw"],
    [
      "verdict object carries WHY into the capture record",
      () => ({ ready: false, reason: "ready-file-stale:95s" }),
      "enforce-not-armed:ready-file-stale:95s",
    ],
  ];
  for (const [label, isReady, reason] of cases) {
    test(`smee stays authoritative — ${label}`, () => {
      const v = decideDispatch(smee("github.pr.opened"), { mode: "enforce", isReady });
      expect(v.suppress).toBe(false);
      expect(v.reason).toBe(reason);
    });
  }

  test("a verdict object with ready:true arms", () => {
    const v = decideDispatch(smee("github.pr.opened"), { mode: "enforce", isReady: () => ({ ready: true }) });
    expect(v.suppress).toBe(true);
  });
});

describe("the feed side is decided by its OWN stamp (CTL-1901's asymmetry), never by readiness", () => {
  test("a stamped feed event dispatches even while the probe says NOT ready", () => {
    // The whole point of the asymmetry: a later readiness change must not retroactively
    // revoke authority from a line already on disk, or the edge reaches neither path.
    const v = decideDispatch(feed("github.pr.opened"), { mode: "enforce", isReady: () => false });
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("feed-authoritative");
  });

  test("an UNSTAMPED feed event does not dispatch", () => {
    const v = decideDispatch(feed("github.pr.opened", { authority: false }), { mode: "enforce", isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-emitted-while-unarmed");
  });

  test("⛔ a feed event for an EXCLUDED name is refused on the feed side too", () => {
    // Both halves of the exclusion must agree by construction. If the feed side
    // allowed it while the smee side (correctly) declines to suppress, BOTH copies
    // dispatch — the double-dispatch the gate exists to prevent.
    const v = decideDispatch(feed("github.check_suite.completed"), { mode: "enforce", isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-excluded:no-replacement:no-suite-row:CTC-667-item-4");
  });
});

describe("modes below enforce leave routing byte-identical to pre-CTL-1929", () => {
  for (const mode of ["off", "shadow", undefined, "ENFORCE", "enfroce"]) {
    test(`mode ${JSON.stringify(mode)}: smee dispatches every consumed name`, () => {
      for (const name of GITHUB_CONSUMED_NAMES) {
        const v = decideDispatch(smee(name), { mode, isReady: () => true });
        expect(v.suppress).toBe(false);
        expect(v.reason).toBe("webhook-authoritative");
      }
    });
  }

  test("⚠️ a real github.* feed event in shadow is refused — a rollback that does not roll back", () => {
    // In shadow the producer emits only `github-feed.would-dispatch`. A real name
    // reaching this log means a stale enforce-mode producer survived the flip back.
    const v = decideDispatch(feed("github.pr.opened"), { mode: "shadow", isReady: () => true });
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe("feed-not-authoritative");
  });
});

describe("sourceOf identifies the feed POSITIVELY and everything else by elimination", () => {
  test("the feed's stamp wins", () => {
    expect(sourceOf(feed("github.pr.opened"))).toBe(SOURCE_CLOUD_FEED);
  });
  test("a webhook delivery id reads as webhook", () => {
    expect(sourceOf(smee("github.pr.opened"))).toBe("webhook");
  });
  test("⛔ an unknown producer lands in `other` and is treated as smee, never as the feed", () => {
    const mystery = ev("github.pr.opened", { payload: { source: "some-new-thing" } });
    expect(sourceOf(mystery)).toBe("other");
    // and it must not inherit the feed's authority
    const v = decideDispatch(mystery, { mode: "enforce", isReady: () => true });
    expect(v.reason).toBe("smee-captured");
  });
  test("an empty-string delivery id is not a webhook", () => {
    expect(sourceOf(ev("github.pr.opened", { attrs: { "webhook.delivery.id": "" } }))).toBe("other");
  });
});

describe("the producer's own emit-list stays the source of truth for coverage", () => {
  test("every name the producer emits is either suppressible or explicitly lossy", () => {
    for (const n of GITHUB_DISPATCH_CLASS_NAMES) {
      const suppressible = GITHUB_SUPPRESSIBLE_NAMES.includes(n);
      const lossy = GITHUB_LOSSY_NAMES.includes(n);
      expect(suppressible || lossy).toBe(true);
    }
  });
});
