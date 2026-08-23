// registry-team-identity.test.mjs — CAT-52. Hermetic: every filesystem read is
// injected, so the suite touches no real registry or checkout.

import { describe, test, expect } from "bun:test";
import { teamIdentityOf, listProjects } from "../registry.mjs";

function reader(map) {
  return (p) => {
    if (!(p in map)) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return map[p];
  };
}

describe("teamIdentityOf", () => {
  test("nested config shape returns the declared team", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: "CAT" } } }) }),
    );
    expect(result).toEqual({ declared: "CAT", matches: true });
  });

  test("bare config shape is supported", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": JSON.stringify({ linear: { teamKey: "CAT" } }) }),
    );
    expect(result.matches).toBe(true);
  });

  // The real CAT -> CTL dispatch-revision case belongs to
  // registry-dispatch-revision-identity.test.mjs; this suite covers Arm A.
  test("detects a mismatch between the registry team and the declared teamKey", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/clone" },
      reader({ "/clone/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: "CTL" } } }) }),
    );
    expect(result).toEqual({ declared: "CTL", matches: false });
  });

  // The runtime compares team keys strictly (monitor.mjs `query.team !==
  // parsed.teamKey`, getProjectConfig's `p.team === team`), so a case- or
  // whitespace-differing key IS a real mismatch — grading it "matches" would
  // report a registry as healthy while every Linear event is silently dropped.
  test("a case-differing team key is a mismatch, mirroring the strict runtime", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: "cat" } } }) }),
    );
    expect(result).toEqual({ declared: "cat", matches: false });
  });

  test("surrounding whitespace is a mismatch and is reported verbatim", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: " CAT " } } }) }),
    );
    expect(result).toEqual({ declared: " CAT ", matches: false });
  });

  test("absent config is unknown", () => {
    expect(teamIdentityOf({ team: "CAT", repoRoot: "/gone" }, reader({}))).toEqual({
      declared: null,
      matches: null,
    });
  });

  test("malformed config is unknown and never throws", () => {
    expect(teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": "{not json" }),
    )).toEqual({ declared: null, matches: null });
  });

  test("missing teamKey is unknown", () => {
    const result = teamIdentityOf(
      { team: "CAT", repoRoot: "/r" },
      reader({ "/r/.catalyst/config.json": JSON.stringify({ catalyst: { linear: {} } }) }),
    );
    expect(result.matches).toBe(null);
  });

  test("a throwing reader is contained", () => {
    expect(() => teamIdentityOf({ team: "CAT", repoRoot: "/r" }, () => {
      throw new Error("boom");
    })).not.toThrow();
  });
});

describe("listProjects team identity", () => {
  const registry = JSON.stringify({
    projects: [
      { team: "CAT", repoRoot: "/clone" },
      { team: "PAN", repoRoot: "/pan" },
    ],
  });

  function deps(warns) {
    return {
      readRegistry: () => registry,
      exists: () => true,
      readLayer1: reader({
        "/clone/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: "CTL" } } }),
        "/pan/.catalyst/config.json": JSON.stringify({ catalyst: { linear: { teamKey: "PAN" } } }),
      }),
      warn: (obj, msg) => warns.push({ obj, msg }),
    };
  }

  test("mismatched entries remain returned with identity attached", () => {
    const projects = listProjects(deps([]));
    expect(projects.map((p) => p.team)).toEqual(["CAT", "PAN"]);
    expect(projects.map((p) => p.identity)).toEqual([
      { declared: "CTL", matches: false },
      { declared: "PAN", matches: true },
    ]);
  });

  test("warns exactly once with the mismatched identity", () => {
    const warns = [];
    listProjects(deps(warns));
    const hits = warns.filter((warning) => /declares a different/i.test(warning.msg));
    expect(hits).toHaveLength(1);
    expect(hits[0].obj).toMatchObject({ team: "CAT", declaredTeam: "CTL", repoRoot: "/clone" });
  });

  test("a consistent registry does not warn", () => {
    const warns = [];
    listProjects({
      ...deps(warns),
      readRegistry: () => JSON.stringify({ projects: [{ team: "PAN", repoRoot: "/pan" }] }),
    });
    expect(warns).toHaveLength(0);
  });

  test("a nonexistent repo warns only about existence and has unknown identity", () => {
    const warns = [];
    const projects = listProjects({ ...deps(warns), exists: () => false });
    expect(warns.some((warning) => /does not exist on this host/.test(warning.msg))).toBe(true);
    expect(warns.some((warning) => /declares a different/i.test(warning.msg))).toBe(false);
    expect(projects.every((project) => project.identity.matches === null)).toBe(true);
  });
});
