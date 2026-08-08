// doctor-registry-team-identity.test.mjs — CAT-52. All dependencies are
// injected; the never-FAIL and never-throw invariants are load-bearing.

import { describe, test, expect } from "bun:test";
import { checkRegistryTeamIdentity } from "../doctor.mjs";

const deps = (projects) => ({ listProjects: () => projects });

describe("checkRegistryTeamIdentity", () => {
  test("all consistent returns PASS with the verified count", () => {
    const rec = checkRegistryTeamIdentity(
      deps([{ team: "PAN", identity: { declared: "PAN", matches: true } }]),
    );
    expect(rec.name).toBe("registry-team-identity");
    expect(rec.status).toBe("pass");
    expect(rec.detail).toContain("1");
  });

  test("a mismatch returns WARN naming the team, declaration, and path", () => {
    const rec = checkRegistryTeamIdentity(
      deps([
        { team: "CAT", repoRoot: "/clone", identity: { declared: "CTL", matches: false } },
        { team: "PAN", repoRoot: "/pan", identity: { declared: "PAN", matches: true } },
      ]),
    );
    expect(rec.status).toBe("warn");
    expect(rec.detail).toContain("CAT");
    expect(rec.detail).toContain("CTL");
    expect(rec.detail).toContain("/clone");
    expect(rec.detail).toContain("CAT-52");
  });

  test("every entry mismatched still never returns FAIL", () => {
    const rec = checkRegistryTeamIdentity(
      deps([
        { team: "A", repoRoot: "/a", identity: { declared: "X", matches: false } },
        { team: "B", repoRoot: "/b", identity: { declared: "Y", matches: false } },
      ]),
    );
    expect(rec.status).toBe("warn");
    expect(rec.status).not.toBe("fail");
    expect(rec.detail).toContain("A");
    expect(rec.detail).toContain("B");
  });

  test("an empty registry returns INFO", () => {
    expect(checkRegistryTeamIdentity(deps([])).status).toBe("info");
  });

  // "No mismatch" is not "verified". An entry whose config is absent,
  // unreadable, malformed, or missing teamKey was never actually checked, so
  // grading it PASS would report a clean contract that nothing confirmed.
  test("an unknown identity is not a warning, and is never PASS", () => {
    const rec = checkRegistryTeamIdentity(
      deps([{ team: "CAT", repoRoot: "/gone", identity: { declared: null, matches: null } }]),
    );
    expect(rec.status).toBe("info");
    expect(rec.detail).toContain("0/1");
  });

  test("all identities unknown reports INFO, not a clean PASS", () => {
    const rec = checkRegistryTeamIdentity(
      deps([
        { team: "CAT", repoRoot: "/a", identity: { declared: null, matches: null } },
        { team: "PAN", repoRoot: "/b", identity: { declared: null, matches: null } },
      ]),
    );
    expect(rec.status).toBe("info");
    expect(rec.status).not.toBe("pass");
    expect(rec.detail).toContain("0/2");
  });

  test("a partially verified registry stays INFO and counts the unverified", () => {
    const rec = checkRegistryTeamIdentity(
      deps([
        { team: "PAN", repoRoot: "/pan", identity: { declared: "PAN", matches: true } },
        { team: "CAT", repoRoot: "/gone", identity: { declared: null, matches: null } },
      ]),
    );
    expect(rec.status).toBe("info");
    expect(rec.detail).toContain("1/2");
  });

  test("a throwing registry reader degrades to INFO without throwing", () => {
    let rec;
    expect(() => {
      rec = checkRegistryTeamIdentity({
        listProjects: () => {
          throw new Error("boom");
        },
      });
    }).not.toThrow();
    expect(rec.status).toBe("info");
    expect(rec.status).not.toBe("fail");
  });
});
