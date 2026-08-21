import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchRevisionIdentityOf,
  listProjects,
  upsertProjectEntry,
} from "../registry.mjs";

function gitFake(map) {
  return (_repoRoot, rev) =>
    rev in map ? { ok: true, stdout: map[rev] } : { ok: false, stdout: "" };
}

const cfg = (team) => JSON.stringify({ catalyst: { linear: { teamKey: team } } });

describe("dispatchRevisionIdentityOf", () => {
  test("prefers refs/remotes/origin/main and records the ref that answered", () => {
    expect(
      dispatchRevisionIdentityOf(
        { team: "CAT", repoRoot: "/repo" },
        { showAtRev: gitFake({ "refs/remotes/origin/main": cfg("CAT"), "refs/heads/main": cfg("CTL") }) },
      ),
    ).toEqual({ declared: "CAT", matches: true, rev: "refs/remotes/origin/main" });
  });

  test("falls back to refs/heads/main when origin/main is absent", () => {
    expect(
      dispatchRevisionIdentityOf(
        { team: "CAT", repoRoot: "/repo" },
        { showAtRev: gitFake({ "refs/heads/main": cfg("CAT") }) },
      ),
    ).toEqual({ declared: "CAT", matches: true, rev: "refs/heads/main" });
  });

  test("detects a mismatch at the dispatch revision", () => {
    expect(
      dispatchRevisionIdentityOf(
        { team: "CAT", repoRoot: "/repo" },
        { showAtRev: gitFake({ "refs/remotes/origin/main": cfg("CTL") }) },
      ),
    ).toEqual({ declared: "CTL", matches: false, rev: "refs/remotes/origin/main" });
  });

  test("accepts the bare config shape", () => {
    const showAtRev = gitFake({ "refs/remotes/origin/main": JSON.stringify({ linear: { teamKey: "CAT" } }) });
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev }).matches).toBe(true);
  });

  test("no resolvable ref is unknown with rev null", () => {
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev: gitFake({}) })).toEqual({
      declared: null,
      matches: null,
      rev: null,
    });
  });

  test("malformed JSON at the revision is unknown and never throws", () => {
    const showAtRev = gitFake({ "refs/remotes/origin/main": "{oops" });
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev })).toEqual({
      declared: null,
      matches: null,
      rev: "refs/remotes/origin/main",
    });
  });

  test.each([undefined, "", "   ", 42])("missing, blank, or non-string teamKey %p is unknown", (teamKey) => {
    const showAtRev = gitFake({
      "refs/remotes/origin/main": JSON.stringify({ catalyst: { linear: { teamKey } } }),
    });
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev }).matches).toBeNull();
  });

  test("a throwing git reader is unknown and never throws", () => {
    const showAtRev = () => {
      throw new Error("boom");
    };
    expect(() => dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev })).not.toThrow();
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev }).rev).toBeNull();
  });

  test("comparison is exact", () => {
    const showAtRev = gitFake({ "refs/remotes/origin/main": cfg("cat") });
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev }).matches).toBe(false);
  });

  test("does not fall through when a resolved ref contains malformed config", () => {
    const showAtRev = gitFake({
      "refs/remotes/origin/main": "{oops",
      "refs/heads/main": cfg("CAT"),
    });
    expect(dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { showAtRev })).toEqual({
      declared: null,
      matches: null,
      rev: "refs/remotes/origin/main",
    });
  });

  test("the default showAtRev never invokes a network git subcommand", () => {
    const calls = [];
    const spawn = (bin, argv) => {
      calls.push([bin, ...argv].join(" "));
      return { status: 128, stdout: "", stderr: "" };
    };
    dispatchRevisionIdentityOf({ team: "CAT", repoRoot: "/repo" }, { spawn });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/^git show /);
      expect(call).not.toMatch(/fetch|ls-remote|pull|clone/);
    }
  });
});

describe("listProjects dispatch-revision opt-in", () => {
  const registryJson = JSON.stringify({ projects: [{ team: "CAT", repoRoot: "/repo" }] });
  const baseDeps = {
    readRegistry: () => registryJson,
    exists: () => true,
    readLayer1: () => cfg("CAT"),
    warn: () => {},
  };

  test("default call spawns no git and attaches no dispatchIdentity", () => {
    let spawned = 0;
    const projects = listProjects({
      ...baseDeps,
      spawn: () => {
        spawned++;
        return { status: 0, stdout: "" };
      },
    });
    expect(spawned).toBe(0);
    expect(projects[0].dispatchIdentity).toBeUndefined();
    expect(projects[0].identity).toEqual({ declared: "CAT", matches: true });
  });

  test("withDispatchIdentity attaches the revision answer per entry", () => {
    const projects = listProjects({
      ...baseDeps,
      withDispatchIdentity: true,
      showAtRev: gitFake({ "refs/remotes/origin/main": cfg("CAT") }),
    });
    expect(projects[0].dispatchIdentity).toEqual({
      declared: "CAT",
      matches: true,
      rev: "refs/remotes/origin/main",
    });
  });

  test("withDispatchIdentity does not change arm-A warn behavior", () => {
    const run = (withDispatchIdentity) => {
      const warnings = [];
      listProjects({
        ...baseDeps,
        readLayer1: () => cfg("CTL"),
        withDispatchIdentity,
        showAtRev: gitFake({ "refs/remotes/origin/main": cfg("CAT") }),
        warn: (obj, message) => warnings.push({ obj, message }),
      });
      return warnings;
    };
    expect(run(true)).toEqual(run(false));
    expect(run(true)).toHaveLength(1);
  });

  test("a nonexistent repoRoot skips the revision read", () => {
    let reads = 0;
    const projects = listProjects({
      ...baseDeps,
      exists: () => false,
      withDispatchIdentity: true,
      showAtRev: () => {
        reads++;
        return { ok: true, stdout: cfg("CAT") };
      },
    });
    expect(reads).toBe(0);
    expect(projects[0].dispatchIdentity).toEqual({ declared: null, matches: null, rev: null });
  });
});

describe("upsertProjectEntry runtime fields", () => {
  let dir;
  let previousCatalystDir;

  afterEach(() => {
    if (previousCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = previousCatalystDir;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("strips dispatchIdentity as well as identity from retained entries", () => {
    previousCatalystDir = process.env.CATALYST_DIR;
    dir = mkdtempSync(join(tmpdir(), "cat-116-registry-"));
    process.env.CATALYST_DIR = dir;
    mkdirSync(join(dir, "execution-core"), { recursive: true });
    writeFileSync(
      join(dir, "execution-core", "registry.json"),
      JSON.stringify({
        projects: [{
          team: "PAN",
          repoRoot: "/missing",
          eligibleQuery: null,
          identity: { declared: "PAN", matches: true },
          dispatchIdentity: { declared: "PAN", matches: true, rev: "refs/heads/main" },
        }],
      }),
    );
    upsertProjectEntry({ team: "CAT", repoRoot: "/cat" });
    const saved = JSON.parse(readFileSync(join(dir, "execution-core", "registry.json"), "utf8"));
    expect(saved.projects[0].identity).toBeUndefined();
    expect(saved.projects[0].dispatchIdentity).toBeUndefined();
  });
});
