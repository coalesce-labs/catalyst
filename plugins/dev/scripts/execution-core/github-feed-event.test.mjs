// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-event.test.mjs
//
// These tests assert the fields `broker/router.mjs` DESTRUCTURES, not a shape that
// merely looks like a GitHub event. Where a field is a join key or a strict `===`
// comparison, the test says so — those are the ones whose failure is silent.

import { describe, expect, test } from "bun:test";
import {
  GITHUB_DISPATCH_CLASS_NAMES,
  GITHUB_SERVICE_NAME,
  GITHUB_UNCOVERED_NAMES,
  SOURCE_CLOUD_FEED,
  UNCOVERED_STREAM_REASONS,
  authorOf,
  authorTypeOf,
  buildGithubEvent,
  classifyGithubRow,
  githubEdgeId,
  githubEventName,
  loginOf,
} from "./github-feed-event.mjs";

// Deterministic seams so the envelope is byte-stable across runs.
const SEAMS = {
  now: () => new Date("2026-08-18T00:00:00.000Z"),
  newId: () => "id0",
  newTrace: () => "trace0",
  newSpan: () => "span0",
};
const build = (k, row) => buildGithubEvent(k, { __ts: 1, __id: "k", ...row }, SEAMS);

describe("envelope invariants shared by every name", () => {
  const rows = {
    prOpened: { repo_id: "o/r", number: 7, draft: 0, mergeable: 1 },
    prClosed: { repo_id: "o/r", number: 7, draft: 0, mergeable: null },
    reviewSubmitted: { repo_id: "o/r", pr_number: 7, user_id: "github:alice", state: "COMMENTED", body: "b" },
    reviewCommentCreated: { repo_id: "o/r", pr_number: 7, id: "991", author_id: "github:alice", body: "b" },
    threadResolved: { repo_id: "o/r", pr_number: 7, id: "PRRT_x" },
    deploymentCreated: { repo_id: "o/r", id: "55", sha: "abc", ref: "main", environment: "production" },
    deploymentStatus: { repo_id: "o/r", id: "9", deployment_id: "55", state: "success", environment: "production" },
    push: { repo_id: "o/r", ref: "refs/heads/main", before: "b1", after: "a1" },
  };

  for (const [key, row] of Object.entries(rows)) {
    test(`${key}: service.name stays catalyst.github`, () => {
      // ⛔ router.mjs's recordLastSeen folds this into the CTL-1122 ingestion-recency
      // map. A different value blinds the github ingestion-SILENCE detector at the
      // exact moment this producer becomes github's only source.
      expect(build(key, row).resource["service.name"]).toBe(GITHUB_SERVICE_NAME);
      expect(GITHUB_SERVICE_NAME).toBe("catalyst.github");
    });

    test(`${key}: provenance is stamped positively as cloud-feed`, () => {
      // cloud-feed-gate.sourceOf reads exactly this key; without it the event
      // classifies as SOURCE_OTHER and inherits no authority.
      const ev = build(key, row);
      expect(ev.body.payload.source).toBe(SOURCE_CLOUD_FEED);
      expect(ev.attributes["event.channel"]).toBe(SOURCE_CLOUD_FEED);
    });

    test(`${key}: does NOT stamp webhook.delivery.id`, () => {
      // That attribute is how sourceOf recognises smee NEGATIVELY. Stamping it here
      // would make our copy indistinguishable from the tunnel's.
      expect(build(key, row).attributes["webhook.delivery.id"]).toBeUndefined();
    });

    test(`${key}: carries a non-empty human body.message and its event.name`, () => {
      const ev = build(key, row);
      expect(ev.body.message.length).toBeGreaterThan(0);
      // summarizeEvent puts body.message into every wake an agent reads, so it must
      // not collapse to the bare name the way the generic builder leaves it.
      expect(ev.body.message).toContain("o/r");
      expect(ev.attributes["event.name"]).toBe(ev.attributes["event.name"]);
      expect(GITHUB_DISPATCH_CLASS_NAMES).toContain(ev.attributes["event.name"]);
    });
  }
});

describe("⛔ the two deliberate divergences from 'nicer'", () => {
  test("pr payloads carry NO title / body / headRef — emitting them would wake a dormant path", () => {
    // router.mjs:1856 scrapes exactly these three for ticket ids. Measured 1208/1208
    // live payloads contain none of them, so _autoPrLifecycleFromTicket never fires.
    // Including them would switch that on fleet-wide.
    const ev = build("prOpened", {
      repo_id: "o/r", number: 7, draft: 0, mergeable: 1,
      title: "CTL-1 do a thing", body: "closes CTL-2", head_ref: "ryan/ctl-3-x",
    });
    expect(Object.keys(ev.body.payload).sort()).toEqual(
      ["action", "draft", "mergeCommitSha", "mergeable", "merged", "mergedAt", "source"],
    );
    const wire = JSON.stringify(ev.body.payload);
    expect(wire).not.toContain("CTL-1");
    expect(wire).not.toContain("CTL-2");
    expect(wire).not.toContain("CTL-3");
  });

  test("pr_review_thread.resolved emits threadId 0, not the real id", () => {
    // Measured 202/202 live events carry 0 (GitHub's thread has no numeric id).
    // Emitting the real id is nicer and breaks the parity instrument.
    const ev = build("threadResolved", { repo_id: "o/r", pr_number: 7, id: "PRRT_realid" });
    expect(ev.body.payload.threadId).toBe(0);
    expect(JSON.stringify(ev.body.payload)).not.toContain("PRRT_realid");
  });
});

describe("⛔ join keys — a wrong type here breaks a chain while everything still routes", () => {
  test("deployment_status.deploymentId is a NUMBER (replica stores TEXT)", () => {
    // filter-state.mjs:117 matches `WHERE deployment_id = ?`. "55" !== 55.
    const ev = build("deploymentStatus", {
      repo_id: "o/r", id: "9", deployment_id: "5936592703", state: "success", environment: "production",
    });
    expect(ev.body.payload.deploymentId).toBe(5936592703);
    expect(typeof ev.body.payload.deploymentId).toBe("number");
  });

  test("deployment.created carries vcs.revision — the merge_commit_sha join key", () => {
    const ev = build("deploymentCreated", {
      repo_id: "o/r", id: "55", sha: "c671cd9c", ref: "main", environment: "production",
    });
    expect(ev.attributes["vcs.revision"]).toBe("c671cd9c");
    expect(ev.attributes["deployment.environment"]).toBe("production");
    expect(typeof ev.attributes["deployment.id"]).toBe("number");
  });

  test("push carries the FULL ref, not a stripped branch", () => {
    // router.mjs:1583 strips `refs/heads/` itself; a pre-stripped value never matches.
    const ev = build("push", { repo_id: "o/r", ref: "refs/heads/main", before: "b", after: "a1b2c3d4e5" });
    expect(ev.attributes["vcs.ref.name"]).toBe("refs/heads/main");
    expect(ev.attributes["event.label"]).toBe("a1b2c3d");
  });

  test("pr.closed sets merged === false STRICTLY (router.mjs:1525 uses ===)", () => {
    const ev = build("prClosed", { repo_id: "o/r", number: 7, draft: 0, mergeable: null });
    expect(ev.body.payload.merged).toBe(false);
    expect(ev.body.payload.merged).not.toBeUndefined();
  });
});

describe("review state normalisation", () => {
  test("the stored UPPERCASE state is lowercased to what the consumer compares", () => {
    // router.mjs:1539 compares === "changes_requested" / "approved". Passing
    // "COMMENTED" through would match neither branch and the gate would go quiet.
    const ev = build("reviewSubmitted", {
      repo_id: "o/r", pr_number: 7, user_id: "github:alice", state: "COMMENTED", body: "b",
    });
    expect(ev.body.payload.state).toBe("commented");
  });
  test("CHANGES_REQUESTED and APPROVED map to the router's exact tokens", () => {
    // ⚠️ Convention, not measurement: neither value has ever been observed on this
    // fleet (6,630/6,630 replica rows and 3,093/3,093 live events are `commented`).
    for (const [stored, want] of [["CHANGES_REQUESTED", "changes_requested"], ["APPROVED", "approved"]]) {
      const ev = build("reviewSubmitted", { repo_id: "o/r", pr_number: 7, user_id: "github:a", state: stored, body: "" });
      expect(ev.body.payload.state).toBe(want);
    }
  });
});

describe("author identity — derived from the login, not joined", () => {
  test("the [bot] suffix rule classifies the author absent from the users table", () => {
    // github:github-code-quality[bot] has no `users` row on mini-2; a left join would
    // have yielded a null type and handled a bot review as a human's.
    expect(authorTypeOf("github-code-quality[bot]")).toBe("Bot");
    expect(authorTypeOf("chatgpt-codex-connector[bot]")).toBe("Bot");
    expect(authorTypeOf("ryanrozich")).toBe("User");
    expect(authorTypeOf(undefined)).toBe("User");
  });
  test("the github: namespace prefix is stripped", () => {
    expect(loginOf("github:thagale")).toBe("thagale");
    expect(loginOf("")).toBe("");
    expect(authorOf("github:x[bot]")).toEqual({ login: "x[bot]", type: "Bot" });
  });
  test("review + review-comment payloads expose author.type for the bot gate", () => {
    const r = build("reviewSubmitted", {
      repo_id: "o/r", pr_number: 7, user_id: "github:chatgpt-codex-connector[bot]", state: "COMMENTED", body: "x",
    });
    expect(r.body.payload.author.type).toBe("Bot");
    expect(r.body.payload.reviewer).toBe("chatgpt-codex-connector[bot]");
    const c = build("reviewCommentCreated", {
      repo_id: "o/r", pr_number: 7, id: "991", author_id: "github:ryanrozich", body: "x",
    });
    expect(c.body.payload.author).toEqual({ login: "ryanrozich", type: "User" });
    expect(c.body.payload.htmlUrl).toBe("https://github.com/o/r/pull/7#discussion_r991");
  });
});

describe("⛔ uncovered names decline with a reason — they never return a silent null", () => {
  test("⭐ prMerged EMITS now that CTC-691 landed — the stream-level decline is gone", () => {
    // This test asserted the opposite until schema 0.1.17. `merge_commit_sha` is a
    // real column, so the whole-stream refusal is deleted and the guard moved to the
    // ROW (see the next test) — which is the finer, and only correct, granularity.
    const v = classifyGithubRow("prMerged", {
      __ts: 1, __id: "k", repo_id: "o/r", number: 7, merge_commit_sha: "abc123",
    });
    expect(v.emit).toBe(true);
    expect(UNCOVERED_STREAM_REASONS.prMerged).toBeUndefined();
  });

  test("⛔ a prMerged row with NO merge_commit_sha declines — the un-backfilled rows", () => {
    // ⚠️ Not hypothetical: CTC-691 added the column without backfilling the ~4,230
    // pre-existing PR rows (COORD-124), so every merge predating the pin has it NULL.
    // A twin without the join key routes and wakes monitor-merge normally while
    // monitor-deploy stops firing — it LOOKS like success, which is why it declines.
    for (const sha of [undefined, null, "", 12345]) {
      const v = classifyGithubRow("prMerged", {
        __ts: 1, __id: "k", repo_id: "o/r", number: 7, merge_commit_sha: sha,
      });
      expect(v.emit).toBe(false);
      expect(v.reason).toBe("no-merge-commit-sha:not-backfilled");
      // A decline, NOT a failure: un-arming the producer would not repair a row that
      // predates the column, and readiness must not drop on a declared gap.
      expect(v.fatal).toBeUndefined();
    }
    // ⭐ Control: the SAME row with a sha emits. Without this the test above passes
    // if classify refuses every prMerged row for some unrelated reason.
    const ok = classifyGithubRow("prMerged", {
      __ts: 1, __id: "k", repo_id: "o/r", number: 7, merge_commit_sha: "abc123",
    });
    expect(ok.emit).toBe(true);
  });
  test("no uncovered name is reachable through the dispatch-class set", () => {
    for (const n of GITHUB_UNCOVERED_NAMES) expect(GITHUB_DISPATCH_CLASS_NAMES).not.toContain(n);
    // ⭐ pr.merged moved OUT of uncovered (CTC-691, schema 0.1.17) and INTO the
    // emit-list. check_suite.completed did not — the table landed but the PR
    // association the consumer keys on did not (CTC-712).
    expect(GITHUB_DISPATCH_CLASS_NAMES).toContain("github.pr.merged");
    expect(GITHUB_UNCOVERED_NAMES).not.toContain("github.pr.merged");
    expect(GITHUB_UNCOVERED_NAMES).toContain("github.check_suite.completed");
    expect(GITHUB_UNCOVERED_NAMES).toContain("github.check_suite.completed");
  });
  test("buildGithubEvent refuses an uncovered stream", () => {
    expect(build("prMerged", { repo_id: "o/r", number: 7 })).toBeNull();
  });
});

describe("classification declines a row the consumer could not use", () => {
  const cases = [
    ["no repo", "prOpened", { __ts: 1, __id: "k", number: 7 }, "no-repo"],
    ["no pr number", "prOpened", { __ts: 1, __id: "k", repo_id: "o/r" }, "no-pr-number"],
    ["no edge timestamp", "prOpened", { __id: "k", repo_id: "o/r", number: 7 }, "no-edge-timestamp"],
    ["no edge id", "prOpened", { __ts: 1, repo_id: "o/r", number: 7 }, "no-edge-id"],
    ["no ref", "push", { __ts: 1, __id: "k", repo_id: "o/r" }, "no-ref"],
    ["no deployment state", "deploymentStatus", { __ts: 1, __id: "k", repo_id: "o/r" }, "no-deployment-state"],
  ];
  for (const [label, key, row, reason] of cases) {
    test(`${label} -> declined as ${reason}`, () => {
      const v = classifyGithubRow(key, row);
      expect(v.emit).toBe(false);
      expect(v.reason).toBe(reason);
    });
  }
  test("an unknown stream is FATAL — it would make every row unemittable", () => {
    const v = classifyGithubRow("nope", {});
    expect(v.emit).toBe(false);
    expect(v.fatal).toBe(true);
  });
});

describe("⛔ P1 (Codex #3513): a mutated row has no per-edge PK, so push folds in its coordinate", () => {
  const push = (ts, after) => ({ __ts: ts, __id: "o/r@refs/heads/main", repo_id: "o/r", ref: "refs/heads/main", after });

  test("two pushes to ONE ref get DIFFERENT identities", () => {
    // The defect: `pushes` is keyed (repo_id, ref) and rewritten per push, so the
    // bare PK is the same string forever. The seen-set then suppressed every push
    // after the first as a re-read — github.push dead per ref, silently.
    const a = githubEdgeId("push", push(1000, "sha-a"));
    const b = githubEdgeId("push", push(2000, "sha-b"));
    expect(a).not.toBe(b);
  });

  test("but the identity is STABLE across re-reads of the SAME push", () => {
    // The settle window re-reads deliberately; suppression depends on the identity
    // being byte-identical for an unchanged row.
    expect(githubEdgeId("push", push(1000, "sha-a"))).toBe(githubEdgeId("push", push(1000, "sha-a")));
  });

  test("a same-millisecond force-push to a different sha is still distinct", () => {
    expect(githubEdgeId("push", push(1000, "sha-a"))).not.toBe(githubEdgeId("push", push(1000, "sha-b")));
  });

  test("only push folds in the coordinate — insert-per-edge streams keep the bare PK", () => {
    const row = { __ts: 5, __id: "r-1" };
    expect(githubEdgeId("reviewSubmitted", row)).toBe(githubEdgeId("reviewSubmitted", { ...row, __ts: 9 }));
  });
});

describe("⛔ P2 (Codex #3513): a row that would emit an unroutable event is declined", () => {
  test("a deployment with no sha is declined, not emitted with an empty join key", () => {
    // vcs.revision is what setFilterStateDeploying matches on. "" routes nowhere and
    // parks the deployment lifecycle, while counting as a successful emit.
    for (const sha of [undefined, null, "", 12345]) {
      const v = classifyGithubRow("deploymentCreated", {
        __ts: 1, __id: "d1", repo_id: "o/r", id: "d1", sha, environment: "production",
      });
      expect(v.emit).toBe(false);
      expect(v.reason).toBe("no-deployment-sha");
    }
  });
  test("a deployment WITH a sha still emits (the control — the rule can pass)", () => {
    const v = classifyGithubRow("deploymentCreated", {
      __ts: 1, __id: "d1", repo_id: "o/r", id: "d1", sha: "c671cd9c", environment: "production",
    });
    expect(v.emit).toBe(true);
  });
});

describe("edge identity is stable and PK-derived", () => {
  test("the same row yields the same id across reads (the seen-set depends on it)", () => {
    const row = { __ts: 5, __id: "o/r#7", number: 7, repo_id: "o/r" };
    expect(githubEdgeId("prOpened", row)).toBe(githubEdgeId("prOpened", { ...row, __ts: 9 }));
  });
  test("distinct streams over one row do not collide", () => {
    const row = { __ts: 5, __id: "o/r#7" };
    expect(githubEdgeId("prOpened", row)).not.toBe(githubEdgeId("prClosed", row));
  });
  test("a row with no id yields null rather than a colliding constant", () => {
    expect(githubEdgeId("prOpened", { __ts: 1 })).toBeNull();
  });
});

describe("deployment_status name and severity are per-row", () => {
  const mk = (state) => build("deploymentStatus", {
    repo_id: "o/r", id: "9", deployment_id: "55", state, environment: "production",
  });
  test("the name carries the state", () => {
    expect(githubEventName("deploymentStatus", { state: "failure" })).toBe("github.deployment_status.failure");
    expect(mk("success").attributes["event.name"]).toBe("github.deployment_status.success");
  });
  test("failure and error are ERROR severity; success is INFO", () => {
    expect(mk("failure").severityText).toBe("ERROR");
    expect(mk("error").severityNumber).toBe(17);
    expect(mk("success").severityText).toBe("INFO");
  });
});

describe("⭐ github.pr.merged — the envelope the deploy chain joins on (CTC-691)", () => {
  const row = {
    __ts: 1, __id: "o/r#7", repo_id: "o/r", number: 7,
    merge_commit_sha: "deadbeefcafe", merged_at: 1_700_000_000_000,
    draft: 0, mergeable: 1,
  };
  const ev = () => buildGithubEvent("prMerged", row);

  test("⛔ mergeCommitSha is carried on BOTH the payload and vcs.revision", () => {
    // `router.mjs:1513` reads `detail.mergeCommitSha` and writes it via
    // setFilterStateMerged; `github.deployment.created` later matches
    // `WHERE merge_commit_sha = ?`. This is the join key, not a description.
    const e = ev();
    expect(e.body.payload.mergeCommitSha).toBe("deadbeefcafe");
    expect(e.attributes["vcs.revision"]).toBe("deadbeefcafe");
  });

  test("⛔ action is `closed` with merged:true — GitHub never sends action `merged`", () => {
    // Inventing an action nobody emits leaves tryPrLifecycleRoute unmatched while
    // every count still reads "emitted".
    const e = ev();
    expect(e.body.payload.action).toBe("closed");
    expect(e.body.payload.merged).toBe(true);
    expect(e.attributes["event.action"]).toBe("merged"); // the OTel action, not the payload's
  });

  test("⚠️ it does NOT carry title/body/headRef — the dormant lifecycle scraper", () => {
    // `tryTicketLifecycleRoute` (router.mjs:1856) scrapes exactly those three for
    // ticket ids and is dormant on this fleet (1,208/1,208 live payloads lack them).
    // Including them switches `_autoPrLifecycleFromTicket` on fleet-wide.
    const p = ev().body.payload;
    for (const k of ["title", "body", "headRef"]) expect(p[k]).toBeUndefined();
  });

  test("mergedAt renders ISO-8601 UTC from the stored epoch-ms", () => {
    expect(ev().body.payload.mergedAt).toBe(new Date(1_700_000_000_000).toISOString());
    // A row with no merged_at yields null rather than "Invalid Date".
    const e = buildGithubEvent("prMerged", { ...row, merged_at: null });
    expect(e.body.payload.mergedAt).toBeNull();
  });

  test("the envelope keeps this feature's three invariants", () => {
    const e = ev();
    expect(e.resource["service.name"]).toBe("catalyst.github"); // CTL-1122 recency map
    expect(e.attributes["event.channel"]).toBe("cloud-feed");
    expect(e.body.payload.source).toBe("cloud-feed");
  });

  test("⛔ a row with no sha builds NOTHING — the guard is upstream of the builder", () => {
    expect(buildGithubEvent("prMerged", { ...row, merge_commit_sha: null })).toBeNull();
  });
});

describe("⭐ github.push from push_events is byte-identical to the pushes copy (CTC-704)", () => {
  // The two streams differ in WHICH ROWS they yield, never in what an event looks
  // like. A second builder is how the feed copy and its own replacement drift apart
  // on a field the consumer reads.
  const shared = { __ts: 5, repo_id: "o/r", ref: "refs/heads/main", before: "aaa", after: "bbb" };

  test("both streams produce the same envelope for the same row", () => {
    const fromPushes = buildGithubEvent("push", { ...shared, __id: "o/r@refs/heads/main" });
    const fromEvents = buildGithubEvent("pushEvent", { ...shared, __id: "d1", delivery_id: "d1" });
    // ids/timestamps are per-emission; compare everything the consumer reads.
    expect(fromEvents.attributes).toEqual(fromPushes.attributes);
    expect(fromEvents.body.payload).toEqual(fromPushes.body.payload);
    expect(fromEvents.body.message).toBe(fromPushes.body.message);
  });

  test("⛔ the FULL ref is carried, not a stripped branch", () => {
    // router.mjs:1582 strips `refs/heads/` itself; a pre-stripped value fails its match.
    expect(buildGithubEvent("pushEvent", { ...shared, __id: "d1" }).attributes["vcs.ref.name"])
      .toBe("refs/heads/main");
  });

  test("a row with no ref declines", () => {
    expect(classifyGithubRow("pushEvent", { __ts: 5, __id: "d1", repo_id: "o/r", ref: "" }).emit).toBe(false);
  });
});
