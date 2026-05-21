// Unit tests for the execution-core enrollment reader (CTL-535 Phase 1).
// Run: cd plugins/dev/scripts/execution-core && bun test enrollment.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listEnrolledProjects,
  loadProjectConfig,
  writeEnrollmentRecord,
  removeEnrollmentRecord,
} from "./enrollment.mjs";

let catalystDir;
let enrollmentDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-enroll-"));
  process.env.CATALYST_DIR = catalystDir;
  enrollmentDir = join(catalystDir, "execution-core", "projects");
  mkdirSync(enrollmentDir, { recursive: true });
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// Write an enrollment record file into the (already-created) enrollment dir.
function writeRecord(name, obj) {
  writeFileSync(
    join(enrollmentDir, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)
  );
}

// Create a stub repo with a .catalyst/config.json carrying the given
// `catalyst` block; return its repoRoot. Nested under catalystDir so the
// afterEach rmSync cleans it up.
function writeRepo(catalyst) {
  const repoRoot = mkdtempSync(join(catalystDir, "repo-"));
  mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
  writeFileSync(join(repoRoot, ".catalyst", "config.json"), JSON.stringify({ catalyst }, null, 2));
  return repoRoot;
}

describe("listEnrolledProjects", () => {
  test("returns one record per *.json in the enrollment dir", () => {
    writeRecord("alpha.json", { projectKey: "alpha", repoRoot: "/repos/alpha" });
    writeRecord("beta.json", { projectKey: "beta", repoRoot: "/repos/beta" });
    // a non-json file is ignored
    writeFileSync(join(enrollmentDir, "README.md"), "not a record");
    const got = listEnrolledProjects();
    expect(got).toHaveLength(2);
    expect(got.map((p) => p.projectKey).sort()).toEqual(["alpha", "beta"]);
  });

  test("parses { projectKey, repoRoot, enrolledAt, status }", () => {
    writeRecord("alpha.json", {
      projectKey: "alpha",
      repoRoot: "/repos/alpha",
      enrolledAt: "2026-05-21T00:00:00Z",
      status: "active",
    });
    const [rec] = listEnrolledProjects();
    expect(rec.projectKey).toBe("alpha");
    expect(rec.repoRoot).toBe("/repos/alpha");
    expect(rec.enrolledAt).toBe("2026-05-21T00:00:00Z");
    expect(rec.status).toBe("active");
  });

  test("skips a malformed JSON file without throwing (logs + continues)", () => {
    writeRecord("good.json", { projectKey: "good", repoRoot: "/repos/good" });
    writeRecord("bad.json", "{ not valid json");
    let got;
    expect(() => {
      got = listEnrolledProjects();
    }).not.toThrow();
    expect(got.map((p) => p.projectKey)).toEqual(["good"]);
  });

  test("skips a record missing projectKey or repoRoot", () => {
    writeRecord("ok.json", { projectKey: "ok", repoRoot: "/repos/ok" });
    writeRecord("no-key.json", { repoRoot: "/repos/x" });
    writeRecord("no-root.json", { projectKey: "y" });
    const got = listEnrolledProjects();
    expect(got.map((p) => p.projectKey)).toEqual(["ok"]);
  });

  test("skips a record whose projectKey is not a safe path segment", () => {
    // projectKey is used verbatim as the eligible/<projectKey>.json path
    // segment — a record carrying path-traversal sequences must be rejected.
    writeRecord("ok.json", { projectKey: "ok", repoRoot: "/repos/ok" });
    writeRecord("traverse.json", { projectKey: "../escape", repoRoot: "/repos/x" });
    writeRecord("dotdot.json", { projectKey: "..", repoRoot: "/repos/y" });
    writeRecord("slash.json", { projectKey: "a/b", repoRoot: "/repos/z" });
    const got = listEnrolledProjects();
    expect(got.map((p) => p.projectKey)).toEqual(["ok"]);
  });

  test("returns [] when the enrollment dir does not exist", () => {
    rmSync(enrollmentDir, { recursive: true, force: true });
    expect(listEnrolledProjects()).toEqual([]);
  });

  test("treats record presence as the enrollment signal — does NOT filter on the unpinned `status` field", () => {
    writeRecord("active.json", { projectKey: "active", repoRoot: "/r/a", status: "active" });
    writeRecord("paused.json", { projectKey: "paused", repoRoot: "/r/p", status: "paused" });
    writeRecord("nostatus.json", { projectKey: "nostatus", repoRoot: "/r/n" });
    const got = listEnrolledProjects();
    expect(got.map((p) => p.projectKey).sort()).toEqual(["active", "nostatus", "paused"]);
  });
});

describe("loadProjectConfig", () => {
  test("reads <repoRoot>/.catalyst/config.json and returns executionCore.eligibleQuery", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: {
        executionCore: {
          eligibleQuery: {
            status: "Todo",
            team: "ENG",
            project: "Platform",
            label: "ready",
            priority: 2,
          },
        },
      },
    });
    const q = loadProjectConfig(repoRoot);
    expect(q).toEqual({
      team: "ENG",
      status: "Todo",
      triageStatus: "Triage",
      project: "Platform",
      label: "ready",
      priority: 2,
    });
  });

  test("resolves eligibleQuery.team, falling back to catalyst.linear.teamKey when absent", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "FALLBACK" },
      orchestration: {
        executionCore: { eligibleQuery: { status: "Todo" } },
      },
    });
    expect(loadProjectConfig(repoRoot).team).toBe("FALLBACK");
  });

  test("defaults eligibleQuery.status to 'Todo' when absent", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: {
        executionCore: { eligibleQuery: { team: "ENG" } },
      },
    });
    expect(loadProjectConfig(repoRoot).status).toBe("Todo");
  });

  test("project/label/priority default to null when absent", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: {
        executionCore: { eligibleQuery: { team: "ENG", status: "Todo" } },
      },
    });
    const q = loadProjectConfig(repoRoot);
    expect(q.project).toBeNull();
    expect(q.label).toBeNull();
    expect(q.priority).toBeNull();
  });

  test("defaults triageStatus to 'Triage' when absent (CTL-565)", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: {
        executionCore: { eligibleQuery: { team: "ENG", status: "Ready" } },
      },
    });
    expect(loadProjectConfig(repoRoot).triageStatus).toBe("Triage");
  });

  test("honors an explicit eligibleQuery.triageStatus override (CTL-565)", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: {
        executionCore: {
          eligibleQuery: { team: "ENG", status: "Ready", triageStatus: "Intake" },
        },
      },
    });
    expect(loadProjectConfig(repoRoot).triageStatus).toBe("Intake");
  });

  test("returns null (project skipped) when executionCore.eligibleQuery is absent", () => {
    const repoRoot = writeRepo({
      linear: { teamKey: "ENG" },
      orchestration: { dispatchMode: "phase-agents" },
    });
    expect(loadProjectConfig(repoRoot)).toBeNull();
  });

  test("returns null when <repoRoot>/.catalyst/config.json is missing or unreadable", () => {
    const repoRoot = mkdtempSync(join(catalystDir, "norepo-"));
    expect(loadProjectConfig(repoRoot)).toBeNull();
  });

  test("returns null when config.json is malformed JSON", () => {
    const repoRoot = mkdtempSync(join(catalystDir, "badrepo-"));
    mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
    writeFileSync(join(repoRoot, ".catalyst", "config.json"), "{ broken");
    expect(loadProjectConfig(repoRoot)).toBeNull();
  });
});

describe("writeEnrollmentRecord", () => {
  test("writes a record that listEnrolledProjects reads back", () => {
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/repos/demo" });
    const got = listEnrolledProjects();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ projectKey: "demo", repoRoot: "/repos/demo" });
    expect(got[0].status).toBe("active");
    expect(typeof got[0].enrolledAt).toBe("string");
  });

  test("creates the projects/ directory if absent", () => {
    // afterEach already removes the tree; remove projects/ explicitly then write
    rmSync(enrollmentDir, { recursive: true, force: true });
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/r/d" });
    expect(listEnrolledProjects().map((p) => p.projectKey)).toEqual(["demo"]);
  });

  test("is atomic — leaves no .tmp file behind", () => {
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/r/d" });
    expect(readdirSync(enrollmentDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("re-enrolling overwrites the existing record (idempotent)", () => {
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/r/old" });
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/r/new" });
    const got = listEnrolledProjects();
    expect(got).toHaveLength(1);
    expect(got[0].repoRoot).toBe("/r/new");
  });

  test("throws on an unsafe projectKey (path traversal)", () => {
    expect(() => writeEnrollmentRecord({ projectKey: "../escape", repoRoot: "/r" })).toThrow();
    expect(() => writeEnrollmentRecord({ projectKey: "a/b", repoRoot: "/r" })).toThrow();
  });

  test("throws when projectKey or repoRoot is missing", () => {
    expect(() => writeEnrollmentRecord({ repoRoot: "/r" })).toThrow();
    expect(() => writeEnrollmentRecord({ projectKey: "demo" })).toThrow();
  });
});

describe("removeEnrollmentRecord", () => {
  test("deletes the record file", () => {
    writeEnrollmentRecord({ projectKey: "demo", repoRoot: "/r/d" });
    removeEnrollmentRecord("demo");
    expect(listEnrolledProjects()).toEqual([]);
  });

  test("is a no-op when the record does not exist", () => {
    expect(() => removeEnrollmentRecord("nonexistent")).not.toThrow();
  });

  test("throws on an unsafe projectKey", () => {
    expect(() => removeEnrollmentRecord("../escape")).toThrow();
  });
});
