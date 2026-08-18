// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-parity.test.mjs
//
// Most of these test the ways a ledger LIES — an empty side, nothing joined, a name
// that vanished. A parity harness that can only report agreement is the instrument
// failure this repo has shipped before, so every "clean" here has to be earned.

import { describe, expect, test } from "bun:test";
import {
  COMPARE_SPEC,
  KNOWN_ABSENT,
  OBSERVED_ONLY_FIELDS,
  compareGithubStreams,
  smeeRepos,
  parityExitCode,
} from "./github-feed-parity.mjs";

const ev = (name, attrs, payload, extra = {}) => ({
  ts: "2026-08-18T00:00:00Z", id: "x", attributes: { "event.name": name, ...attrs },
  body: { message: name, payload }, ...extra,
});

const comment = (id, over = {}) =>
  ev("github.pr_review_comment.created",
    { "vcs.repository.name": "o/r", "vcs.pr.number": 7, "event.entity": "pr_review_comment",
      "event.action": "created", "event.label": "PR #7", "event.stream_class": "coordination" },
    { commentId: id, body: "b", htmlUrl: `https://github.com/o/r/pull/7#discussion_r${id}`,
      author: { login: "alice", type: "User" }, ...over });

describe("a clean ledger has to be earned", () => {
  test("identical streams are clean", () => {
    const r = compareGithubStreams([comment(1), comment(2)], [comment(1), comment(2)]);
    expect(r.totals).toEqual({ joined: 2, agree: 2, unjoined: 0, smeeUnjoined: 0 });
    expect(r.clean).toBe(true);
    expect(parityExitCode(r)).toBe(0);
  });

  test("⛔ an empty feed side is INCONCLUSIVE, never clean", () => {
    // [].every() is true. A ledger that reports agreement because it compared
    // nothing is the exact false-clean this module exists to refuse.
    const r = compareGithubStreams([], [comment(1)]);
    expect(r.clean).toBe(false);
    expect(r.inconclusive).toContain("feed-side-empty");
    expect(parityExitCode(r)).toBe(3);
  });

  test("⛔ an empty smee side is INCONCLUSIVE, never clean", () => {
    const r = compareGithubStreams([comment(1)], []);
    expect(r.clean).toBe(false);
    expect(r.inconclusive).toContain("smee-side-empty");
    expect(parityExitCode(r)).toBe(3);
  });

  test("⛔ two non-empty streams that share no key are INCONCLUSIVE, not clean", () => {
    // Nothing was actually compared. Reporting 0 divergences here would be a lie.
    const r = compareGithubStreams([comment(1)], [comment(999)]);
    expect(r.totals.joined).toBe(0);
    expect(r.inconclusive).toContain("no-events-joined");
    expect(r.clean).toBe(false);
    expect(parityExitCode(r)).toBe(3);
  });

  test("an unjoined feed event is counted, never folded into agreement", () => {
    const r = compareGithubStreams([comment(1), comment(2)], [comment(1)]);
    expect(r.byName["github.pr_review_comment.created"].unjoined).toBe(1);
    expect(r.totals.agree).toBe(1);
  });
});

describe("⛔ P1 (Codex #3520): the ledger must compare MULTIPLICITY, not presence", () => {
  // Codex built exactly these two controls and both returned clean:true before the
  // fix — the ledger certifying parity across a dropped or duplicated dispatch.
  test("2 feed vs 1 smee under one key is NOT clean", () => {
    const r = compareGithubStreams([comment(1), comment(1)], [comment(1)]);
    expect(r.clean).toBe(false);
    expect(r.totals.unjoined).toBe(1);
    expect(parityExitCode(r)).toBe(3);
  });

  test("1 feed vs 2 smee under one key is NOT clean", () => {
    const r = compareGithubStreams([comment(1)], [comment(1), comment(1)]);
    expect(r.clean).toBe(false);
    expect(r.smeeUnjoined).toBe(1);
    expect(r.inconclusive).toContain("smee-events-without-a-twin:1");
  });

  test("a twin is CONSUMED — it cannot serve two feed events", () => {
    const r = compareGithubStreams([comment(1), comment(1), comment(1)], [comment(1), comment(1)]);
    expect(r.totals.joined).toBe(2);
    expect(r.totals.unjoined).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("balanced repeats under one key ARE clean — the fix must not forbid legitimate duplicates", () => {
    // The positive control. Coarse keys (review keys on repo/pr/reviewer/state) make
    // repeats expected, so a rule that called all repetition dirty would be useless.
    const r = compareGithubStreams([comment(1), comment(1)], [comment(1), comment(1)]);
    expect(r.totals).toEqual({ joined: 2, agree: 2, unjoined: 0, smeeUnjoined: 0 });
    expect(r.clean).toBe(true);
  });
});

describe("⛔ P1 (Codex #3520): an unmatched event cannot certify parity", () => {
  test("feed [1,2] vs smee [1] is INCONCLUSIVE, not clean", () => {
    // Before the fix this returned clean:true — one pair joined and agreed, and the
    // predicate only looked at `joined - agree`. The extra event may be a duplicate
    // or a spurious dispatch; either way it is not evidence of parity.
    const r = compareGithubStreams([comment(1), comment(2)], [comment(1)]);
    expect(r.totals.joined).toBe(1);
    expect(r.totals.agree).toBe(1);
    expect(r.clean).toBe(false);
    expect(r.inconclusive).toContain("feed-events-without-a-twin:1");
    expect(parityExitCode(r)).toBe(3);
  });

  test("smee [1,2] vs feed [1] is INCONCLUSIVE too — the rule is symmetric", () => {
    const r = compareGithubStreams([comment(1)], [comment(1), comment(2)]);
    expect(r.clean).toBe(false);
    expect(r.inconclusive).toContain("smee-events-without-a-twin:1");
  });
});

describe("field-level divergence", () => {
  test("a payload diff is caught and NAMED with both values", () => {
    const r = compareGithubStreams([comment(1, { body: "changed" })], [comment(1)]);
    expect(r.clean).toBe(false);
    const d = r.byName["github.pr_review_comment.created"].diffs["body.payload.body"];
    expect(d[0]).toEqual({ feed: "changed", smee: "b" });
    expect(parityExitCode(r)).toBe(2);
  });

  test("an attribute diff is caught", () => {
    const bad = comment(1); bad.attributes["vcs.pr.number"] = 9;
    const r = compareGithubStreams([bad], [comment(1)]);
    expect(r.clean).toBe(false);
    expect(r.byName["github.pr_review_comment.created"].diffs["attributes.vcs.pr.number"]).toBeDefined();
  });

  test("⭐ the fields that MUST differ do not count as divergence", () => {
    // Otherwise the ledger reports a permanent diff on every run and stops meaning
    // anything — the two producers legitimately differ in id/ts/channel/source.
    const f = comment(1); f.id = "feed-id"; f.ts = "2026-08-18T09:99:99Z";
    f.attributes["event.channel"] = "cloud-feed"; f.body.payload.source = "cloud-feed";
    const s = comment(1); s.id = "smee-id"; s.attributes["event.channel"] = "webhook";
    s.attributes["webhook.delivery.id"] = "abc";
    expect(compareGithubStreams([f], [s]).clean).toBe(true);
  });
});

describe("⚠️ observed-only fields: equal today, not guaranteed", () => {
  const pr = (draft) => ev("github.pr.opened",
    { "vcs.repository.name": "o/r", "vcs.pr.number": 7, "event.entity": "pr", "event.action": "opened",
      "event.label": "PR #7", "event.stream_class": "coordination" },
    { action: "opened", merged: false, mergedAt: null, draft, mergeable: null });

  test("a draft divergence is REPORTED but does not break clean", () => {
    // The replica holds current state; the webhook held the value at the edge. This
    // is the one real diff the live 3h ledger found, and it is inherent.
    const r = compareGithubStreams([pr(false)], [pr(true)]);
    expect(r.clean).toBe(true);
    expect(r.byName["github.pr.opened"].observedOnly["body.payload.draft"][0])
      .toEqual({ feed: false, smee: true });
  });

  test("the observed-only list is explicit, so nothing hides inside a prefix rule", () => {
    expect(OBSERVED_ONLY_FIELDS).toEqual(["body.payload.draft", "body.payload.mergeable"]);
  });
});

describe("⛔ a consumed name that vanishes must not read as agreement", () => {
  const merged = ev("github.pr.merged",
    { "vcs.repository.name": "o/r", "vcs.pr.number": 7 },
    { action: "closed", merged: true, mergeCommitSha: "abc" });
  const suite = ev("github.check_suite.completed",
    { "vcs.repository.name": "o/r", "vcs.revision": "abc" },
    { conclusion: "success", status: "completed", prNumbers: [7] });

  test("⭐ check_suite.completed is NO LONGER a declared gap — a missing one breaks clean", () => {
    // ⛔ THE LAST EXCUSED NAME. While it sat in KNOWN_ABSENT the ledger could not fail
    // on the one name still keeping the smee tunnel alive, so a CLEAN verdict was
    // silent about exactly the thing the cutover turns on. CTC-712 removed the reason
    // for the excuse; this asserts the excuse went with it.
    const r = compareGithubStreams([comment(1)], [comment(1), suite]);
    expect(r.expectedAbsent["github.check_suite.completed"]).toBeUndefined();
    expect(r.unexplainedAbsent["github.check_suite.completed"]).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("⛔ KNOWN_ABSENT is EMPTY, and that is the invariant — not a tidy-up", () => {
    // `unexplainedAbsent` is `absent − KNOWN_ABSENT`, so every entry here is a name
    // the ledger is configured to be unable to fail on. An empty table means every
    // consumed name that goes missing now blocks CLEAN.
    expect(Object.keys(KNOWN_ABSENT)).toEqual([]);
  });

  test("⭐ pr.merged is NO LONGER a declared gap — a missing one now breaks clean", () => {
    // ⛔ The inverse control, and the whole reason CTC-691 mattered: while pr.merged
    // was declared uncovered, the ledger EXCUSED its absence, so the one name whose
    // loss silently kills the merge→deploy chain was the one the instrument was
    // configured not to notice. Now its absence is a finding.
    const r = compareGithubStreams([comment(1)], [comment(1), merged]);
    expect(r.expectedAbsent["github.pr.merged"]).toBeUndefined();
    expect(r.unexplainedAbsent["github.pr.merged"]).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("⭐ and a MATCHED pr.merged compares clean, including the join key", () => {
    // The positive control: without it, the test above passes for a ledger that
    // simply refuses every pr.merged.
    const r = compareGithubStreams([comment(1), merged], [comment(1), merged]);
    expect(r.unexplainedAbsent).toEqual({});
    expect(r.clean).toBe(true);
  });

  test("an UNDECLARED absence breaks clean", () => {
    // A name smee delivers, that we claim to produce, and produced none of.
    const push = ev("github.push",
      { "vcs.repository.name": "o/r", "vcs.ref.name": "refs/heads/main", "vcs.revision": "a1" },
      { baseSha: "b", headSha: "a1", commits: [] });
    const r = compareGithubStreams([comment(1)], [comment(1), push]);
    expect(r.unexplainedAbsent["github.push"]).toBe(1);
    expect(r.clean).toBe(false);
    // ⚠️ INCONCLUSIVE (3), not diverged (2). The push has no twin on the feed side,
    // and from the ledger alone a missing name is indistinguishable from window skew.
    // Both are non-clean and both refuse a cutover; "I cannot tell" is the honest
    // label, and `unexplainedAbsent` still names the specific hole to investigate.
    expect(parityExitCode(r)).toBe(3);
    expect(r.inconclusive).toContain("smee-events-without-a-twin:1");
  });

  test("⛔ every consumed name is now failable — none is excused", () => {
    // The general form of the two tests above, so a future re-added excuse has to be
    // argued for against an assertion rather than slipped into a frozen object.
    for (const n of Object.keys(COMPARE_SPEC)) expect(KNOWN_ABSENT[n]).toBeUndefined();
  });
});

describe("coverage of the spec itself", () => {
  test("every name the producer emits has a compare spec", async () => {
    // A name with no spec is counted `unkeyable` and would otherwise quietly never
    // be compared at all.
    const { GITHUB_DISPATCH_CLASS_NAMES } = await import("./github-feed-event.mjs");
    const missing = GITHUB_DISPATCH_CLASS_NAMES.filter((n) => !(n in COMPARE_SPEC));
    expect(missing).toEqual([]);
  });

  test("an unspecced name is counted unkeyable and forces INCONCLUSIVE", () => {
    const weird = ev("github.workflow_run.completed", { "vcs.repository.name": "o/r" }, {});
    const r = compareGithubStreams([comment(1), weird], [comment(1)]);
    expect(r.unkeyable).toBe(1);
    expect(r.inconclusive).toContain("feed-unkeyable-events:1");
    expect(r.clean).toBe(false);
  });

  test("a null report is inconclusive, not clean", () => {
    expect(parityExitCode(null)).toBe(3);
  });
});

describe("⛔ the comparison is scoped to repos smee can actually deliver", () => {
  // Measured on mini-2: the two producers cover overlapping but DIFFERENT repo sets.
  //   smee : catalyst · catalyst-cloud · ryanrozich/personal-os
  //   feed : catalyst · catalyst-cloud · catalyst-cloud-sdk · thoughts
  // Before scoping, every feed event from a feed-only repo counted as
  // `feed-events-without-a-twin` and forced INCONCLUSIVE — so the cutover gate was
  // unmeetable for a reason that was not a fault (6 such events in 55 minutes).
  const inRepo = (repo, name, attrs, payload) =>
    ev(name, { "vcs.repository.name": repo, ...attrs }, payload);

  const smeePush = inRepo("o/shared", "github.push",
    { "vcs.ref.name": "refs/heads/main", "vcs.revision": "a1" },
    { baseSha: "b", headSha: "a1", commits: [] });
  const feedPush = inRepo("o/shared", "github.push",
    { "vcs.ref.name": "refs/heads/main", "vcs.revision": "a1" },
    { baseSha: "b", headSha: "a1", commits: [] });
  const feedOnly = inRepo("o/feed-only", "github.push",
    { "vcs.ref.name": "refs/heads/main", "vcs.revision": "z9" },
    { baseSha: "y", headSha: "z9", commits: [] });

  test("⭐ a feed event from a repo smee does not deliver does NOT block clean", () => {
    const r = compareGithubStreams([feedPush, feedOnly], [smeePush]);
    expect(r.totals.unjoined).toBe(0);
    expect(r.clean).toBe(true);
  });

  test("⛔ but it is REPORTED, never silently dropped", () => {
    // The feed covering more than the tunnel is a REASON TO RETIRE, not a caveat —
    // an operator reading a clean verdict has to be able to see it.
    const r = compareGithubStreams([feedPush, feedOnly], [smeePush]);
    expect(r.feedOnlyRepos).toEqual({ "o/feed-only": 1 });
    expect(r.comparableRepos).toEqual(["o/shared"]);
  });

  test("⛔ a feed event from a SHARED repo with no twin STILL blocks clean", () => {
    // The control that keeps the scoping honest: it must excuse only the events smee
    // could never have produced, never a genuine phantom in a repo it covers.
    const phantom = inRepo("o/shared", "github.push",
      { "vcs.ref.name": "refs/heads/other", "vcs.revision": "q7" },
      { baseSha: "p", headSha: "q7", commits: [] });
    const r = compareGithubStreams([feedPush, phantom], [smeePush]);
    expect(r.totals.unjoined).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("⛔ scoping is derived from the SMEE side only — a repo the feed SHOULD cover still fails", () => {
    // Taking the intersection of both sides would also drop a repo the feed is
    // supposed to cover and silently does not, which is a real defect. Here smee
    // delivers two repos and the feed only one: the missing one must still count.
    const smeeOther = inRepo("o/smee-only", "github.push",
      { "vcs.ref.name": "refs/heads/main", "vcs.revision": "m3" },
      { baseSha: "l", headSha: "m3", commits: [] });
    const r = compareGithubStreams([feedPush], [smeePush, smeeOther]);
    expect(r.comparableRepos).toEqual(["o/shared", "o/smee-only"]);
    expect(r.smeeUnjoined).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("⚠️ an event with NO repo attribute stays comparable", () => {
    // Treating it as feed-only would let a malformed envelope excuse itself out of
    // the comparison — the shape of every false-clean in this file's history.
    const noRepo = ev("github.push",
      { "vcs.ref.name": "refs/heads/main", "vcs.revision": "n0" },
      { baseSha: "m", headSha: "n0", commits: [] });
    const r = compareGithubStreams([feedPush, noRepo], [smeePush]);
    expect(r.feedOnlyRepos).toEqual({});
    expect(r.totals.unjoined).toBe(1);
    expect(r.clean).toBe(false);
  });

  test("smeeRepos collects the delivered set, ignoring blanks", () => {
    expect([...smeeRepos([smeePush, smeePush])]).toEqual(["o/shared"]);
    expect([...smeeRepos([ev("github.push", {}, {})])]).toEqual([]);
  });
});

describe("CTC-712 — the check_suite compare spec can join, and can DIVERGE", () => {
  const suiteEv = (over = {}) => ev(
    "github.check_suite.completed",
    {
      "vcs.repository.name": "o/r", "vcs.pr.number": 7, "vcs.revision": "abc",
      "cicd.pipeline.run.status": "completed", "cicd.pipeline.run.conclusion": "success",
      "event.entity": "check_suite", "event.action": "completed",
      "event.label": "PR #7", "event.stream_class": "coordination",
      ...(over.attrs ?? {}),
    },
    { conclusion: "success", status: "completed", prNumbers: [7], ...(over.payload ?? {}) },
  );

  test("a matched pair joins and agrees", () => {
    const r = compareGithubStreams([suiteEv()], [suiteEv()]);
    expect(r.byName["github.check_suite.completed"].joined).toBe(1);
    expect(r.byName["github.check_suite.completed"].agree).toBe(1);
    expect(r.totals.smeeUnjoined).toBe(0);
  });

  test("⛔ a disagreeing PAYLOAD association is never clean — that field IS the route", () => {
    // `router.mjs:1497` routes on `detail.prNumbers`, so a ledger that could not fail
    // on it would certify the exact defect CTC-712 exists to close. The key includes it
    // (see the spec), so a disagreement surfaces as unjoined rather than as a
    // disagreeing pair — either way, never as clean.
    const r = compareGithubStreams([suiteEv()], [suiteEv({ payload: { prNumbers: [7, 9] } })]);
    expect(r.clean).toBe(false);
    expect(r.totals.smeeUnjoined).toBe(1);
  });

  test("⭐ a vcs.pr.number-only difference JOINS and AGREES — it changes no dispatch", () => {
    // The measured case: the webhook decorates an empty-association suite from its
    // SHA→PR cache (355 of 983 live events) and the replica cannot reproduce that
    // historical map. Comparing it would leave 27% of the smee side permanently
    // unjoinable for a difference nothing routes on — a false BLOCKER, the same shape
    // as the repo-scoping one #3551 fixed.
    const feed = suiteEv({ attrs: { "vcs.pr.number": undefined, "event.label": undefined },
                           payload: { prNumbers: [] } });
    const smeeSide = suiteEv({ attrs: { "vcs.pr.number": 3468, "event.label": "PR #3468" },
                               payload: { prNumbers: [] } });
    const r = compareGithubStreams([feed], [smeeSide]);
    expect(r.byName["github.check_suite.completed"].joined).toBe(1);
    expect(r.byName["github.check_suite.completed"].agree).toBe(1);
    expect(r.totals.smeeUnjoined).toBe(0);
  });

  test("⛔ but a CONCLUSION difference still breaks clean — the exclusion is narrow", () => {
    // The control on the test above: excluding one display field must not have
    // loosened the comparison generally.
    const r = compareGithubStreams(
      [suiteEv()],
      [suiteEv({ attrs: { "cicd.pipeline.run.conclusion": "failure" }, payload: { conclusion: "failure" } })],
    );
    expect(r.clean).toBe(false);
  });



  test("⚠️ the coarse key still counts MULTIPLICITY — a dropped suite cannot hide", () => {
    // Two real suites bucket under one key (no suite id is on either side). If the
    // feed emits one where smee emitted two, that must surface, not be absorbed.
    const r = compareGithubStreams([suiteEv()], [suiteEv(), suiteEv()]);
    expect(r.totals.smeeUnjoined).toBe(1);
    expect(r.clean).toBe(false);
    expect(r.inconclusive.join("|")).toContain("smee-events-without-a-twin");
  });
});
