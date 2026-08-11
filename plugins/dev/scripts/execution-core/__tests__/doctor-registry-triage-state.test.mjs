import { describe, test, expect } from "bun:test";
import { checkRegistryTriageState, checksForClass } from "../doctor.mjs";

const PROJECTS = [
  { team: "CAT", repoRoot: "/r/cat", eligibleQuery: null },
  { team: "PAN", repoRoot: "/r/pan", eligibleQuery: { triageStatus: "Intake" } },
];

// A team's entry is either a plain state-name list (a fully drained connection)
// or `{ states, truncated: true }` to model a page that did NOT drain.
const teamsPayload = (map) => ({
  data: {
    teams: {
      nodes: Object.entries(map).map(([key, entry]) => {
        const { states, truncated } = Array.isArray(entry) ? { states: entry, truncated: false } : entry;
        return {
          key,
          states: {
            nodes: states.map((name) => ({ name })),
            pageInfo: { hasNextPage: !!truncated },
          },
        };
      }),
    },
  },
});

const deps = (over = {}) => ({
  listProjects: () => PROJECTS,
  linearToken: () => "lin_api_test_token",
  post: async () => teamsPayload({ CAT: ["Todo", "Triage", "Done"], PAN: ["Todo", "Intake"] }),
  ...over,
});

describe("checkRegistryTriageState (CAT-140)", () => {
  test("every team has its resolved triage state", async () => {
    expect((await checkRegistryTriageState(deps()))[0].status).toBe("pass");
  });

  test("a missing state fails with the team, state, and consequence", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({ CAT: ["Todo", "Done"], PAN: ["Todo", "Intake"] }),
    }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("CAT");
    expect(result.detail).toContain("Triage");
    expect(result.detail).toMatch(/cannot leave Todo/i);
  });

  test("checks a customized triageStatus", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({ CAT: ["Todo", "Triage"], PAN: ["Todo", "Triage"] }),
    }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Intake");
  });

  test("preinstall and explicit override downgrade definitive absence", async () => {
    const post = async () => teamsPayload({ CAT: ["Todo"], PAN: ["Todo", "Intake"] });
    expect((await checkRegistryTriageState(deps({ preinstall: true, post })))[0].status).toBe("warn");
    expect((await checkRegistryTriageState(deps({ severityOverride: "warn", post })))[0].status).toBe("warn");
  });

  test("degrades without failing when evidence is unavailable", async () => {
    let called = false;
    expect((await checkRegistryTriageState(deps({ linearToken: () => "", post: async () => { called = true; } })))[0].status).toBe("info");
    expect(called).toBe(false);
    expect((await checkRegistryTriageState(deps({ listProjects: () => { throw new Error("boom"); } })))[0].status).toBe("info");
    expect((await checkRegistryTriageState(deps({ listProjects: () => [] })))[0].status).toBe("info");
    expect((await checkRegistryTriageState(deps({ post: async () => ({ errors: [{ message: "denied" }] }) })))[0].status).toBe("warn");
    expect((await checkRegistryTriageState(deps({ post: async () => ({ data: {} }) })))[0].status).toBe("warn");
    expect((await checkRegistryTriageState(deps({ post: async () => { throw new Error("offline"); } })))[0].status).toBe("warn");
  });

  // Codex #3214 P2: absence from a page that did not drain is not absence.
  test("a truncated state page is unverified, not absent", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({
        CAT: { states: ["Todo", "Done"], truncated: true },
        PAN: ["Todo", "Intake"],
      }),
    }));
    expect(result.status).toBe("info");
    expect(result.detail).toContain("CAT");
    expect(result.detail).toMatch(/truncated/i);
  });

  test("a truncated page that already contains the state still passes", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({
        CAT: { states: ["Todo", "Triage"], truncated: true },
        PAN: ["Todo", "Intake"],
      }),
    }));
    expect(result.status).toBe("pass");
  });

  test("absence from a drained page is still a definitive failure", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({
        CAT: { states: ["Todo", "Done"], truncated: false },
        PAN: ["Todo", "Intake"],
      }),
    }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("CAT");
  });

  test("requests the max page size and carries pageInfo", async () => {
    let seen = "";
    await checkRegistryTriageState(deps({
      post: async (query) => {
        seen = query;
        return teamsPayload({ CAT: ["Todo", "Triage"], PAN: ["Todo", "Intake"] });
      },
    }));
    expect(seen).toContain("states(first: 250)");
    expect(seen).toContain("hasNextPage");
  });

  test("a team omitted by Linear is unverified, not absent", async () => {
    const [result] = await checkRegistryTriageState(deps({
      post: async () => teamsPayload({ CAT: ["Todo", "Triage"] }),
    }));
    expect(result.status).toBe("info");
    expect(result.detail).toContain("PAN");
  });

  test("never leaks the token value", async () => {
    const secret = "lin_api_do_not_leak";
    const outcomes = await Promise.all([
      checkRegistryTriageState(deps({ linearToken: () => secret, post: async () => ({ errors: [{ message: "denied" }] }) })),
      checkRegistryTriageState(deps({ linearToken: () => secret, post: async () => { throw new Error("offline"); } })),
    ]);
    expect(outcomes.flat().every((result) => !result.detail.includes(secret))).toBe(true);
  });

  test("is registered only in the worker rubric", () => {
    const source = (nodeClass) => checksForClass({ recognized: true, class: nodeClass })
      .map((check) => check.toString())
      .join("\n");
    expect(source("worker")).toContain("checkRegistryTriageState");
    expect(source("developer")).not.toContain("checkRegistryTriageState");
    expect(source("monitor")).not.toContain("checkRegistryTriageState");
  });
});
