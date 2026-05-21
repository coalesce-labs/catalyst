// Unit tests for the execution-core central registry (CTL-564 Phase 1).
// Run: cd plugins/dev/scripts/execution-core && bun test registry.test.mjs
//
// The registry is the D4 successor to the per-repo enrollment records and the
// D9 cloud seam: all registry I/O flows through registry.mjs. These tests
// follow enrollment.test.mjs's fixture pattern — CATALYST_DIR redirection and
// mkdtempSync temp dirs — so they never touch a real ~/catalyst.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getRegistryPath } from "./config.mjs";
import { listProjects, getProjectConfig, upsertProjectEntry } from "./registry.mjs";

let catalystDir;
let registryDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-registry-"));
  process.env.CATALYST_DIR = catalystDir;
  registryDir = join(catalystDir, "execution-core");
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// Write the registry.json file directly (raw fixture for reader tests).
function writeRegistry(obj) {
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    getRegistryPath(),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)
  );
}

describe("getRegistryPath", () => {
  test("resolves to <CATALYST_DIR>/execution-core/registry.json", () => {
    expect(getRegistryPath()).toBe(join(catalystDir, "execution-core", "registry.json"));
  });
});

describe("listProjects", () => {
  test("returns [] when the registry file is absent", () => {
    expect(listProjects()).toEqual([]);
  });

  test("returns [] (and does not throw) when the registry is malformed JSON", () => {
    writeRegistry("{ not valid json");
    let got;
    expect(() => {
      got = listProjects();
    }).not.toThrow();
    expect(got).toEqual([]);
  });

  test("parses { projects: [...] } into the entry array", () => {
    writeRegistry({
      projects: [
        { team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: { status: "Ready" } },
        { team: "ADV", repoRoot: "/repos/adv", eligibleQuery: { status: "Ready" } },
      ],
    });
    const got = listProjects();
    expect(got).toHaveLength(2);
    expect(got.map((p) => p.team).sort()).toEqual(["ADV", "CTL"]);
    expect(got[0]).toEqual({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
  });

  test("skips an entry missing team or repoRoot", () => {
    writeRegistry({
      projects: [
        { team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: { status: "Ready" } },
        { repoRoot: "/repos/noteam", eligibleQuery: { status: "Ready" } },
        { team: "NOROOT", eligibleQuery: { status: "Ready" } },
      ],
    });
    expect(listProjects().map((p) => p.team)).toEqual(["CTL"]);
  });

  test("returns [] when projects key is absent", () => {
    writeRegistry({});
    expect(listProjects()).toEqual([]);
  });
});

describe("getProjectConfig", () => {
  test("returns the matching entry for a known team", () => {
    writeRegistry({
      projects: [
        { team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: { status: "Ready" } },
        { team: "ADV", repoRoot: "/repos/adv", eligibleQuery: { status: "Ready" } },
      ],
    });
    expect(getProjectConfig("CTL")).toEqual({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
  });

  test("returns null for an unknown team", () => {
    writeRegistry({
      projects: [{ team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: {} }],
    });
    expect(getProjectConfig("UNKNOWN")).toBeNull();
  });

  test("returns null when the registry file is missing", () => {
    expect(getProjectConfig("CTL")).toBeNull();
  });
});

describe("upsertProjectEntry", () => {
  test("creates the registry file and execution-core/ dir when absent", () => {
    expect(existsSync(registryDir)).toBe(false);
    upsertProjectEntry({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
    expect(existsSync(getRegistryPath())).toBe(true);
    expect(listProjects().map((p) => p.team)).toEqual(["CTL"]);
  });

  test("appends a new team without touching existing entries", () => {
    upsertProjectEntry({ team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: { status: "Ready" } });
    upsertProjectEntry({ team: "ADV", repoRoot: "/repos/adv", eligibleQuery: { status: "Ready" } });
    const got = listProjects();
    expect(got).toHaveLength(2);
    expect(got.map((p) => p.team).sort()).toEqual(["ADV", "CTL"]);
    expect(getProjectConfig("CTL").repoRoot).toBe("/repos/ctl");
  });

  test("replaces an existing team in place — no duplicates (idempotent)", () => {
    upsertProjectEntry({ team: "CTL", repoRoot: "/repos/old", eligibleQuery: { status: "Ready" } });
    upsertProjectEntry({ team: "CTL", repoRoot: "/repos/new", eligibleQuery: { status: "Triage" } });
    const got = listProjects();
    expect(got).toHaveLength(1);
    expect(got[0].repoRoot).toBe("/repos/new");
    expect(got[0].eligibleQuery).toEqual({ status: "Triage" });
  });

  test("is atomic — leaves no .tmp file behind in execution-core/", () => {
    upsertProjectEntry({ team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: { status: "Ready" } });
    expect(readdirSync(registryDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("throws when team is missing", () => {
    expect(() => upsertProjectEntry({ repoRoot: "/repos/ctl" })).toThrow();
  });

  test("throws when repoRoot is missing", () => {
    expect(() => upsertProjectEntry({ team: "CTL" })).toThrow();
  });

  test("returns the written entry", () => {
    const entry = upsertProjectEntry({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
    expect(entry).toEqual({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
  });
});

describe("CLI (import.meta.main)", () => {
  const registryCli = join(import.meta.dir, "registry.mjs");

  function runCli(args) {
    return execFileSync(process.execPath, [registryCli, ...args], {
      env: { ...process.env, CATALYST_DIR: catalystDir },
      encoding: "utf8",
    });
  }

  test("upsert then list round-trips the entry", () => {
    runCli([
      "upsert",
      "--team",
      "CTL",
      "--repo-root",
      "/repos/ctl",
      "--eligible-query",
      '{"status":"Ready"}',
    ]);
    const out = JSON.parse(runCli(["list"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      team: "CTL",
      repoRoot: "/repos/ctl",
      eligibleQuery: { status: "Ready" },
    });
  });

  test("get <team> prints the matching entry", () => {
    runCli([
      "upsert",
      "--team",
      "CTL",
      "--repo-root",
      "/repos/ctl",
      "--eligible-query",
      '{"status":"Ready"}',
    ]);
    const out = JSON.parse(runCli(["get", "CTL"]));
    expect(out.team).toBe("CTL");
    expect(out.repoRoot).toBe("/repos/ctl");
  });

  test("re-running upsert produces no duplicate", () => {
    const args = [
      "upsert",
      "--team",
      "CTL",
      "--repo-root",
      "/repos/ctl",
      "--eligible-query",
      '{"status":"Ready"}',
    ];
    runCli(args);
    runCli(args);
    const out = JSON.parse(runCli(["list"]));
    expect(out).toHaveLength(1);
  });
});
