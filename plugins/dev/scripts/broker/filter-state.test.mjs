// Unit tests for filter-daemon SQLite state store (CTL-284).
// Run: bun test plugins/dev/scripts/filter-daemon/filter-state.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openFilterStateDb,
  closeFilterStateDb,
  upsertFilterStateOpen,
  setFilterStateMerged,
  setFilterStateDeploying,
  setFilterStateDeployed,
  setFilterStateFailed,
  deleteFilterState,
  getFilterStateByInterest,
} from "./filter-state.mjs";

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "filter-state-test-"));
  dbPath = join(tmpDir, "filter-state.db");
  openFilterStateDb(dbPath);
});

afterEach(() => {
  closeFilterStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("upsertFilterStateOpen", () => {
  test("creates a new row with status=open and updated_at set", () => {
    upsertFilterStateOpen({ interestId: "i1", prNumber: 42, repo: "o/r" });
    const row = getFilterStateByInterest("i1");
    expect(row).not.toBeNull();
    expect(row.interestId).toBe("i1");
    expect(row.prNumber).toBe(42);
    expect(row.repo).toBe("o/r");
    expect(row.status).toBe("open");
    expect(row.mergeCommitSha).toBeNull();
    expect(row.deploymentId).toBeNull();
    expect(row.environment).toBeNull();
    expect(row.updatedAt).toBeTruthy();
  });

  test("is idempotent — replaces existing row for same interestId", () => {
    upsertFilterStateOpen({ interestId: "i2", prNumber: 1, repo: "o/r" });
    upsertFilterStateOpen({ interestId: "i2", prNumber: 99, repo: "o/r" });
    const row = getFilterStateByInterest("i2");
    expect(row.prNumber).toBe(99);
    expect(row.status).toBe("open");
  });
});

describe("setFilterStateMerged", () => {
  test("updates SHA and status; returns interestId", () => {
    upsertFilterStateOpen({ interestId: "i3", prNumber: 1, repo: "o/r" });
    const got = setFilterStateMerged("i3", "abc123");
    expect(got).toEqual({ interestId: "i3" });
    const row = getFilterStateByInterest("i3");
    expect(row.mergeCommitSha).toBe("abc123");
    expect(row.status).toBe("merged");
  });

  test("returns null when interestId not found", () => {
    expect(setFilterStateMerged("missing", "abc")).toBeNull();
  });
});

describe("setFilterStateDeploying", () => {
  test("matches by SHA, sets deploymentId/environment/status='deploying'", () => {
    upsertFilterStateOpen({ interestId: "i4", prNumber: 1, repo: "o/r" });
    setFilterStateMerged("i4", "shaXYZ");
    const got = setFilterStateDeploying("shaXYZ", 9001, "production");
    expect(got).toEqual({ interestId: "i4" });
    const row = getFilterStateByInterest("i4");
    expect(row.deploymentId).toBe(9001);
    expect(row.environment).toBe("production");
    expect(row.status).toBe("deploying");
  });

  test("returns null when SHA doesn't match any row", () => {
    upsertFilterStateOpen({ interestId: "i5", prNumber: 1, repo: "o/r" });
    setFilterStateMerged("i5", "shaA");
    expect(setFilterStateDeploying("shaB", 1, "production")).toBeNull();
  });
});

describe("setFilterStateDeployed", () => {
  test("matches by deploymentId, sets status='deployed'", () => {
    upsertFilterStateOpen({ interestId: "i6", prNumber: 1, repo: "o/r" });
    setFilterStateMerged("i6", "shaQ");
    setFilterStateDeploying("shaQ", 4242, "production");
    const got = setFilterStateDeployed(4242);
    expect(got).toEqual({ interestId: "i6" });
    expect(getFilterStateByInterest("i6").status).toBe("deployed");
  });

  test("returns null when deploymentId not found", () => {
    expect(setFilterStateDeployed(99999)).toBeNull();
  });
});

describe("setFilterStateFailed", () => {
  test("matches by deploymentId, sets status='failed'", () => {
    upsertFilterStateOpen({ interestId: "i7", prNumber: 1, repo: "o/r" });
    setFilterStateMerged("i7", "shaR");
    setFilterStateDeploying("shaR", 7, "production");
    const got = setFilterStateFailed(7);
    expect(got).toEqual({ interestId: "i7" });
    expect(getFilterStateByInterest("i7").status).toBe("failed");
  });
});

describe("deleteFilterState", () => {
  test("removes the row", () => {
    upsertFilterStateOpen({ interestId: "i8", prNumber: 1, repo: "o/r" });
    deleteFilterState("i8");
    expect(getFilterStateByInterest("i8")).toBeNull();
  });

  test("is a no-op when interestId is unknown", () => {
    expect(() => deleteFilterState("never-existed")).not.toThrow();
  });
});

describe("persistence across reopen", () => {
  test("state survives close + reopen", () => {
    upsertFilterStateOpen({ interestId: "i9", prNumber: 1, repo: "o/r" });
    setFilterStateMerged("i9", "persistedSha");
    closeFilterStateDb();
    openFilterStateDb(dbPath);
    const row = getFilterStateByInterest("i9");
    expect(row.mergeCommitSha).toBe("persistedSha");
    expect(row.status).toBe("merged");
  });
});

describe("openFilterStateDb idempotency", () => {
  test("returns the same instance on repeated calls", () => {
    const first = openFilterStateDb(dbPath);
    const second = openFilterStateDb(dbPath);
    expect(first).toBe(second);
  });
});
