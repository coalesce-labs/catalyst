// Unit tests for deleteProjectEntry (CTL-1154).
// Run: cd plugins/dev/scripts/execution-core && bun test registry-delete.test.mjs

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getRegistryPath } from "./config.mjs";
import { deleteProjectEntry, listProjects, upsertProjectEntry } from "./registry.mjs";

let catalystDir;
let registryDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-registry-delete-"));
  process.env.CATALYST_DIR = catalystDir;
  registryDir = join(catalystDir, "execution-core");
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeRegistry(obj) {
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    getRegistryPath(),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)
  );
}

describe("deleteProjectEntry (CTL-1154)", () => {
  it("removes the matching team and preserves all others (atomic rewrite)", () => {
    writeRegistry({
      projects: [
        { team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: null },
        { team: "ADV", repoRoot: "/repos/adv", eligibleQuery: null },
        { team: "EVR", repoRoot: "/repos/evr", eligibleQuery: null },
      ],
    });
    const result = deleteProjectEntry({ team: "ADV" });
    expect(result).toEqual({ team: "ADV", deleted: true });
    const projects = listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.team).sort()).toEqual(["CTL", "EVR"]);
  });

  it("is idempotent: deleting an absent team is a no-op and returns { deleted: false }", () => {
    writeRegistry({
      projects: [{ team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: null }],
    });
    const result = deleteProjectEntry({ team: "ZZZ" });
    expect(result).toEqual({ team: "ZZZ", deleted: false });
    // original entry preserved
    expect(listProjects()).toHaveLength(1);
    expect(listProjects()[0].team).toBe("CTL");
  });

  it("on a missing registry file returns { deleted: false } and does not create one", () => {
    // no registry file seeded
    expect(existsSync(getRegistryPath())).toBe(false);
    const result = deleteProjectEntry({ team: "CTL" });
    expect(result).toEqual({ team: "CTL", deleted: false });
    expect(existsSync(getRegistryPath())).toBe(false);
  });

  it("throws when team is missing/falsy", () => {
    expect(() => deleteProjectEntry({})).toThrow();
    expect(() => deleteProjectEntry({ team: "" })).toThrow();
    expect(() => deleteProjectEntry()).toThrow();
  });

  it("writes atomically (no .tmp left behind on success)", () => {
    writeRegistry({
      projects: [
        { team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: null },
        { team: "ADV", repoRoot: "/repos/adv", eligibleQuery: null },
      ],
    });
    deleteProjectEntry({ team: "ADV" });
    expect(readdirSync(registryDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("round-trips with upsertProjectEntry: add then delete returns to prior state", () => {
    writeRegistry({
      projects: [{ team: "CTL", repoRoot: "/repos/ctl", eligibleQuery: null }],
    });
    upsertProjectEntry({ team: "TMP", repoRoot: "/repos/tmp", eligibleQuery: null });
    expect(listProjects()).toHaveLength(2);
    deleteProjectEntry({ team: "TMP" });
    const projects = listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].team).toBe("CTL");
  });
});

describe("CLI: registry.mjs delete (CTL-1154)", () => {
  const registryCli = join(import.meta.dir, "registry.mjs");

  function runCli(args) {
    return execFileSync(process.execPath, [registryCli, ...args], {
      env: { ...process.env, CATALYST_DIR: catalystDir },
      encoding: "utf8",
    });
  }

  it("delete --team T removes the entry and exits 0", () => {
    runCli(["upsert", "--team", "CTL", "--repo-root", "/repos/ctl"]);
    runCli(["upsert", "--team", "TMP", "--repo-root", "/repos/tmp"]);
    const out = JSON.parse(runCli(["delete", "--team", "TMP"]));
    expect(out.deleted).toBe(true);
    expect(out.team).toBe("TMP");
    const projects = listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].team).toBe("CTL");
  });

  it("delete --team absent exits 0 and returns { deleted: false }", () => {
    runCli(["upsert", "--team", "CTL", "--repo-root", "/repos/ctl"]);
    const out = JSON.parse(runCli(["delete", "--team", "ZZZ"]));
    expect(out.deleted).toBe(false);
    // original preserved
    expect(listProjects()).toHaveLength(1);
  });
});
