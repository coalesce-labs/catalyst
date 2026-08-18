// pr-status-fold-wiring.test.mjs — CTL-2008. Does `processEvent` actually fold, and
// does it fold where it has to?
//
// Run: cd plugins/dev/scripts/broker && bun test pr-status-fold-wiring.test.mjs
//
// ⛔ WHY THIS IS SEPARATE FROM pr-status-fold.test.mjs. The classifier being right
// proves nothing about the defect. `processEvent` returns at
// `if (!interests.size) return`, and on an execution-core host the interest table is
// PERMANENTLY empty — the daemon runs no `filter.register` producer. A fold placed one
// line below that gate passes every value test ever written and writes zero rows on
// every production host. That is the shape CTL-1929 was bitten by twice in one day (a
// gate reading a file nobody writes; an env pin only one of three readers sees), and
// router.mjs's own CTL-822 comment records a verify panel catching the identical
// placement mistake on the Linear fold.
//
// The load-bearing assertion is therefore: **with the interest table EMPTY, a
// github.pr.* event still writes the row.** This module never registers an interest,
// so `interests` stays at its natural size 0 for the whole file.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  putPrStatus,
  getAllPrStatuses,
} from "./broker-state.mjs";
import { processEvent } from "./router.mjs";

let dir;
let dbPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl2008-"));
  dbPath = join(dir, "filter-state.db");
  openBrokerStateDb(dbPath);
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT repo, pr_number, status FROM pr_status_cache ORDER BY pr_number").all();
  } finally {
    db.close();
  }
};

const feedMerge = (pr) => ({
  ts: "2026-08-18T19:00:10Z",
  id: `evt-${pr}`,
  resource: { "service.name": "catalyst.github" },
  attributes: {
    "event.name": "github.pr.merged",
    "vcs.repository.name": "coalesce-labs/catalyst-cloud",
    "vcs.pr.number": pr,
    "event.channel": "cloud-feed",
  },
  body: {
    message: `github.pr.merged for coalesce-labs/catalyst-cloud PR #${pr}`,
    payload: {
      action: "closed",
      merged: true,
      mergeCommitSha: "c7c255ccd200febc935c76ef32d22368ece14c81",
      source: "cloud-feed",
      feedAuthority: true,
    },
  },
});

describe("⛔ the fold runs with the interest table EMPTY", () => {
  test("a cloud-feed github.pr.merged writes pr_status_cache with zero interests", () => {
    expect(rows()).toEqual([]);
    processEvent(feedMerge(882));
    expect(rows()).toEqual([
      { repo: "coalesce-labs/catalyst-cloud", pr_number: 882, status: "merged" },
    ]);
  });

  test("the row is visible through getAllPrStatuses — the board-health read path", () => {
    // Proves the fold reaches the actual consumer, not just a table nobody reads.
    processEvent(feedMerge(882));
    const byRepo = getAllPrStatuses().get(882);
    expect(byRepo?.get("coalesce-labs/catalyst-cloud")?.status).toBe("merged");
  });
});

describe("the SMEE-shaped envelope folds identically — the rollback path", () => {
  test("a webhook-channel github.pr.opened writes `open`", () => {
    processEvent({
      ts: "2026-08-18T19:00:11Z",
      id: "evt-webhook",
      attributes: {
        "event.name": "github.pr.opened",
        "vcs.repository.name": "coalesce-labs/catalyst",
        "vcs.pr.number": 3629,
        "event.channel": "webhook",
      },
      body: { payload: { action: "opened", merged: false } },
    });
    expect(rows()).toEqual([{ repo: "coalesce-labs/catalyst", pr_number: 3629, status: "open" }]);
  });

  test("a LEGACY top-level `scope` + `detail` envelope folds too", () => {
    // The v1 envelope puts repo/pr under `scope` and the payload under `detail`.
    // ⚠️ The repo here is deliberately NOT `coalesce-labs/catalyst`: processEvent's
    // CTL-993 plugin-refresh side-channel reacts to a merge on the CONFIGURED repo by
    // running a real `git fetch`, which turned this one test into a 2.3 s network call.
    // The fold's repo handling is repo-agnostic, so the realism is not worth the fetch.
    processEvent({
      ts: "2026-08-18T19:00:12Z",
      id: "evt-legacy",
      event: "github.pr.merged",
      scope: { repo: "coalesce-labs/catalyst-otel", pr: 3585 },
      detail: { merged: true },
    });
    expect(rows()).toEqual([
      { repo: "coalesce-labs/catalyst-otel", pr_number: 3585, status: "merged" },
    ]);
  });
});

describe("⛔ merged is terminal through the whole path", () => {
  test("a later `opened` for the same PR cannot walk a merged row back", () => {
    processEvent(feedMerge(882));
    processEvent({
      ts: "2026-08-18T19:05:00Z",
      id: "evt-late-open",
      attributes: {
        "event.name": "github.pr.opened",
        "vcs.repository.name": "coalesce-labs/catalyst-cloud",
        "vcs.pr.number": 882,
      },
      body: { payload: { merged: false } },
    });
    expect(rows()).toEqual([
      { repo: "coalesce-labs/catalyst-cloud", pr_number: 882, status: "merged" },
    ]);
  });

  test("putPrStatus reports the latch rather than silently no-opping", () => {
    expect(putPrStatus("o/r", 1, "open")).toBe(true);
    expect(putPrStatus("o/r", 1, "merged")).toBe(true);
    expect(putPrStatus("o/r", 1, "open")).toBe(false); // declined by the latch
    expect(putPrStatus("o/r", 1, "closed")).toBe(false);
  });
});

describe("putPrStatus refuses input board-health could not interpret", () => {
  test("an unrecognised status is refused, not written", () => {
    // It would throw nowhere: PR_MERGED_RE simply stops matching and the PR silently
    // leaves both cohorts.
    for (const bad of ["deploying", "MERGED", "", null, undefined, 1]) {
      expect(putPrStatus("o/r", 7, bad)).toBe(false);
    }
    expect(rows()).toEqual([]);
  });

  test("a missing repo or a non-positive PR number is refused", () => {
    expect(putPrStatus("", 7, "open")).toBe(false);
    expect(putPrStatus(null, 7, "open")).toBe(false);
    expect(putPrStatus("o/r", 0, "open")).toBe(false);
    expect(putPrStatus("o/r", -1, "open")).toBe(false);
    expect(rows()).toEqual([]);
  });
});

describe("non-PR events leave the table alone", () => {
  test("check_suite, push and a phase event write nothing", () => {
    for (const n of [
      "github.check_suite.completed",
      "github.push",
      "phase.implement.complete.CTL-1",
    ]) {
      processEvent({
        ts: "2026-08-18T19:00:13Z",
        id: `evt-${n}`,
        attributes: {
          "event.name": n,
          "vcs.repository.name": "coalesce-labs/catalyst",
          "vcs.pr.number": 3585,
        },
        body: { payload: { merged: true } },
      });
    }
    expect(rows()).toEqual([]);
  });
});
