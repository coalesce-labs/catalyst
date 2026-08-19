// execution-core-env-drift-health.test.mjs — CTL-2042 doctor drift check tests.
//
// SECURITY: No test may assert on secret values — only variable NAMES.
// `CATALYST_WORKFLOW_GITHUB_TOKEN` must never appear in a test string comparison
// that touches the `detail` field of any check result.

import { describe, test, expect } from "bun:test";
import {
  VERDICT,
  parseEnvAssignments,
  diffVarNames,
  classifyExecutionCoreEnvDrift,
  checkExecutionCoreEnvDrift,
} from "./execution-core-env-drift-health.mjs";

// ─── parseEnvAssignments ─────────────────────────────────────────────────────

describe("parseEnvAssignments", () => {
  test("parses 'export VAR=value' lines", () => {
    const m = parseEnvAssignments("export CATALYST_EXECUTOR=sdk\n");
    expect(m.has("CATALYST_EXECUTOR")).toBe(true);
  });

  test("parses 'VAR=value' lines (without export)", () => {
    const m = parseEnvAssignments("MY_VAR=hello\n");
    expect(m.has("MY_VAR")).toBe(true);
  });

  test("skips comment lines", () => {
    const m = parseEnvAssignments("# This is a comment\nexport FOO=bar\n");
    expect(m.has("FOO")).toBe(true);
    expect([...m.keys()]).not.toContain("# This is a comment");
  });

  test("skips blank lines", () => {
    const m = parseEnvAssignments("\n\nexport FOO=bar\n\n");
    expect(m.size).toBe(1);
    expect(m.has("FOO")).toBe(true);
  });

  test("skips non-assignment lines (source, if, etc.)", () => {
    const text =
      '[ -f "${HOME}/.config/catalyst/execution-core-secrets.env" ] && . "${HOME}/.config/catalyst/execution-core-secrets.env"\n' +
      "export CATALYST_HOST_NAME=mini\n";
    const m = parseEnvAssignments(text);
    expect(m.has("CATALYST_HOST_NAME")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("returns a Map keyed by variable name", () => {
    const m = parseEnvAssignments(
      "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=sdk\n",
    );
    expect(m instanceof Map).toBe(true);
    expect([...m.keys()].sort()).toEqual(["CATALYST_EXECUTOR", "CATALYST_HOST_NAME"]);
  });

  test("handles empty string", () => {
    const m = parseEnvAssignments("");
    expect(m.size).toBe(0);
  });

  test("parses quoted values without stripping quotes (raw line after '=')", () => {
    const m = parseEnvAssignments('export FOO="bar baz"\n');
    expect(m.has("FOO")).toBe(true);
  });
});

// ─── diffVarNames ─────────────────────────────────────────────────────────────

describe("diffVarNames", () => {
  const mkMap = (pairs) => new Map(pairs);

  test("returns empty arrays when both maps are identical", () => {
    const a = mkMap([["FOO", "1"], ["BAR", "2"]]);
    const b = mkMap([["FOO", "1"], ["BAR", "2"]]);
    const d = diffVarNames(a, b);
    expect(d.onlyOnDisk).toEqual([]);
    expect(d.onlyInRepo).toEqual([]);
    expect(d.valueDiffers).toEqual([]);
  });

  test("reports onlyOnDisk when disk has a var not in repo", () => {
    const disk = mkMap([["FOO", "1"], ["DISK_ONLY", "x"]]);
    const repo = mkMap([["FOO", "1"]]);
    const d = diffVarNames(disk, repo);
    expect(d.onlyOnDisk).toContain("DISK_ONLY");
    expect(d.onlyInRepo).toEqual([]);
    expect(d.valueDiffers).toEqual([]);
  });

  test("reports onlyInRepo when repo has a var not on disk", () => {
    const disk = mkMap([["FOO", "1"]]);
    const repo = mkMap([["FOO", "1"], ["REPO_ONLY", "y"]]);
    const d = diffVarNames(disk, repo);
    expect(d.onlyInRepo).toContain("REPO_ONLY");
    expect(d.onlyOnDisk).toEqual([]);
    expect(d.valueDiffers).toEqual([]);
  });

  test("reports valueDiffers when same name has different values", () => {
    const disk = mkMap([["CATALYST_EXECUTOR", "sdk"]]);
    const repo = mkMap([["CATALYST_EXECUTOR", "cli"]]);
    const d = diffVarNames(disk, repo);
    expect(d.valueDiffers).toContain("CATALYST_EXECUTOR");
    expect(d.onlyOnDisk).toEqual([]);
    expect(d.onlyInRepo).toEqual([]);
  });

  test("reports all three categories simultaneously", () => {
    const disk = mkMap([["SHARED", "old"], ["DISK_ONLY", "x"]]);
    const repo = mkMap([["SHARED", "new"], ["REPO_ONLY", "y"]]);
    const d = diffVarNames(disk, repo);
    expect(d.valueDiffers).toContain("SHARED");
    expect(d.onlyOnDisk).toContain("DISK_ONLY");
    expect(d.onlyInRepo).toContain("REPO_ONLY");
  });

  test("diffVarNames result never contains values — only names", () => {
    const disk = mkMap([["SECRET_VAR", "s3cr3t"]]);
    const repo = mkMap([["SECRET_VAR", "n3wsecret"]]);
    const d = diffVarNames(disk, repo);
    // The name is in valueDiffers, but the VALUES are nowhere in the result object
    expect(JSON.stringify(d)).not.toContain("s3cr3t");
    expect(JSON.stringify(d)).not.toContain("n3wsecret");
  });
});

// ─── classifyExecutionCoreEnvDrift ───────────────────────────────────────────

describe("classifyExecutionCoreEnvDrift", () => {
  const HOST_ENV =
    "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n";
  const HOST_ENV_DIFFERENT =
    "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=cli\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n";
  const HOST_ENV_EXTRA_VAR =
    HOST_ENV + "export EXTRA_VAR=only_on_disk\n";

  test("ABSENT when repo file does not exist (ENOENT)", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: null,
      diskError: null,
      repoContent: null,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.ABSENT);
  });

  test("ABSENT when both disk and repo are absent", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: null,
      diskError: null,
      repoContent: null,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.ABSENT);
  });

  test("MATCHES when both files are present and vars are identical", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: HOST_ENV,
      diskError: null,
      repoContent: HOST_ENV,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.MATCHES);
    expect(r.onlyOnDisk).toEqual([]);
    expect(r.onlyInRepo).toEqual([]);
    expect(r.valueDiffers).toEqual([]);
  });

  test("DRIFTED when disk is absent but repo has content", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: null,
      diskError: null,
      repoContent: HOST_ENV,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.DRIFTED);
    expect(r.onlyInRepo).toContain("CATALYST_HOST_NAME");
    expect(r.onlyInRepo).toContain("CATALYST_EXECUTOR");
  });

  test("DRIFTED when a var has a different value on disk", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: HOST_ENV_DIFFERENT,
      diskError: null,
      repoContent: HOST_ENV,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.DRIFTED);
    expect(r.valueDiffers).toContain("CATALYST_EXECUTOR");
  });

  test("DRIFTED when disk has a var not in repo", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: HOST_ENV_EXTRA_VAR,
      diskError: null,
      repoContent: HOST_ENV,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.DRIFTED);
    expect(r.onlyOnDisk).toContain("EXTRA_VAR");
  });

  test("DRIFTED when repo has a var not on disk", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: HOST_ENV,
      diskError: null,
      repoContent: HOST_ENV + "export REPO_ONLY_VAR=something\n",
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.DRIFTED);
    expect(r.onlyInRepo).toContain("REPO_ONLY_VAR");
  });

  test("INCONCLUSIVE when disk is unreadable (non-ENOENT)", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: null,
      diskError: { code: "EACCES" },
      repoContent: HOST_ENV,
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.INCONCLUSIVE);
  });

  test("INCONCLUSIVE when repo is unreadable (non-ENOENT)", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: HOST_ENV,
      diskError: null,
      repoContent: null,
      repoError: { code: "EACCES" },
    });
    expect(r.verdict).toBe(VERDICT.INCONCLUSIVE);
  });

  test("DRIFTED result never exposes values — only names", () => {
    const r = classifyExecutionCoreEnvDrift({
      diskContent: "export SECRET_TOKEN=supersecretvalue\n",
      diskError: null,
      repoContent: "export SECRET_TOKEN=differentvalue\n",
      repoError: null,
    });
    expect(r.verdict).toBe(VERDICT.DRIFTED);
    // The result object must not contain values
    expect(JSON.stringify(r)).not.toContain("supersecretvalue");
    expect(JSON.stringify(r)).not.toContain("differentvalue");
    // But names ARE expected
    expect(r.valueDiffers).toContain("SECRET_TOKEN");
  });
});

// ─── checkExecutionCoreEnvDrift ──────────────────────────────────────────────

describe("checkExecutionCoreEnvDrift", () => {
  const HOST_ENV =
    "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n";

  const makeDeps = ({ diskContent, repoContent, diskError, repoError, clusterAvailable = true } = {}) => ({
    hostName: "mini",
    configDir: "/fake/config",
    clusterDir: "/fake/cluster",
    // Positive control (CTL-2042 Codex P2): default to an inspectable clone so a null
    // repo means "genuinely no committed posture" (ABSENT). Set clusterAvailable:false
    // to model a missing/mis-mounted clone (INCONCLUSIVE, never a false-clean ABSENT).
    exists: () => clusterAvailable,
    readFile: (path) => {
      if (path.includes("/fake/config/execution-core.env")) {
        if (diskError) throw Object.assign(new Error(diskError.code), diskError);
        if (diskContent === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return diskContent;
      }
      if (path.includes("hosts/mini/execution-core.env")) {
        if (repoError) throw Object.assign(new Error(repoError.code), repoError);
        if (repoContent === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return repoContent;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  test("returns PASS when repo has no posture file for this host (ABSENT)", () => {
    const check = checkExecutionCoreEnvDrift(makeDeps({ diskContent: null, repoContent: null }));
    expect(check.status).toBe("pass");
    expect(check.name).toBe("execution-core-env-drift");
  });

  test("returns WARN/INCONCLUSIVE when the cluster clone is unavailable (positive control)", () => {
    // A null repo read that comes from an un-inspectable source (no clone / wrong path /
    // no hosts/ tree) must NOT collapse to a false-clean ABSENT (Codex P2).
    const check = checkExecutionCoreEnvDrift(
      makeDeps({ diskContent: null, repoContent: null, clusterAvailable: false }),
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("INCONCLUSIVE");
  });

  test("returns PASS when disk matches repo (MATCHES)", () => {
    const check = checkExecutionCoreEnvDrift(makeDeps({ diskContent: HOST_ENV, repoContent: HOST_ENV }));
    expect(check.status).toBe("pass");
  });

  test("returns WARN when drifted (var name in detail, value not in detail)", () => {
    const diskWithDifferentVal =
      "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=cli\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n";
    const check = checkExecutionCoreEnvDrift(
      makeDeps({ diskContent: diskWithDifferentVal, repoContent: HOST_ENV }),
    );
    expect(check.status).toBe("warn");
    // detail names the variable
    expect(check.detail).toContain("CATALYST_EXECUTOR");
    // detail NEVER shows values
    expect(check.detail).not.toContain("cli");
    expect(check.detail).not.toContain("sdk");
  });

  test("returns WARN when INCONCLUSIVE (unreadable file)", () => {
    const check = checkExecutionCoreEnvDrift(
      makeDeps({ diskError: { code: "EACCES" }, repoContent: HOST_ENV }),
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("INCONCLUSIVE");
  });

  test("check name is 'execution-core-env-drift'", () => {
    const check = checkExecutionCoreEnvDrift(makeDeps({ diskContent: null, repoContent: null }));
    expect(check.name).toBe("execution-core-env-drift");
  });

  test("production-shape: check is { name, status, detail } — all strings", () => {
    const check = checkExecutionCoreEnvDrift(makeDeps({ diskContent: null, repoContent: null }));
    expect(typeof check.name).toBe("string");
    expect(typeof check.status).toBe("string");
    expect(typeof check.detail).toBe("string");
    expect(["pass", "warn", "fail"]).toContain(check.status);
  });

  test("NEVER emits FAIL — advisory only (same posture as checkLinearWriteBudget)", () => {
    // Every possible code path must not produce FAIL
    const cases = [
      makeDeps({ diskContent: null, repoContent: null }),
      makeDeps({ diskContent: HOST_ENV, repoContent: HOST_ENV }),
      makeDeps({ diskContent: "export FOO=bar\n", repoContent: HOST_ENV }),
      makeDeps({ diskError: { code: "EACCES" }, repoContent: HOST_ENV }),
      makeDeps({ diskContent: null, repoContent: HOST_ENV }),
    ];
    for (const deps of cases) {
      const check = checkExecutionCoreEnvDrift(deps);
      expect(check.status).not.toBe("fail");
    }
  });

  test("WARN detail for DRIFTED includes check-pointing instruction (re-run sync)", () => {
    const check = checkExecutionCoreEnvDrift(
      makeDeps({ diskContent: null, repoContent: HOST_ENV }),
    );
    expect(check.status).toBe("warn");
    // Points user toward the fix
    expect(check.detail.toLowerCase()).toMatch(/sync|cluster|materiali/);
  });

  test("detail always names the directory examined, not just a bare 'ok'", () => {
    // "I looked at X and found Y" — checkable by reader
    const check = checkExecutionCoreEnvDrift(makeDeps({ diskContent: HOST_ENV, repoContent: HOST_ENV }));
    expect(check.detail).not.toBe("ok");
    expect(check.detail.length).toBeGreaterThan(10);
  });
});
