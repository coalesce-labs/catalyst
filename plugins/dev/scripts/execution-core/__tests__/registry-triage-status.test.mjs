import { describe, test, expect } from "bun:test";
import {
  DEFAULT_TRIAGE_STATUS,
  resolveTriageStatusForTeam,
  resolveEligibleQuery,
} from "../registry.mjs";

describe("resolveTriageStatusForTeam", () => {
  test("eligibleQuery:null resolves to the shared default", () => {
    const getConfig = () => ({ team: "CAT", repoRoot: "/r", eligibleQuery: null });
    expect(resolveTriageStatusForTeam("CAT", { getConfig })).toBe(DEFAULT_TRIAGE_STATUS);
  });

  test("a customized triageStatus wins over the default", () => {
    const getConfig = () => ({
      team: "ACME",
      repoRoot: "/r",
      eligibleQuery: { triageStatus: "Intake" },
    });
    expect(resolveTriageStatusForTeam("ACME", { getConfig })).toBe("Intake");
  });

  test("an absent team registry entry still resolves to the default", () => {
    expect(resolveTriageStatusForTeam("NOPE", { getConfig: () => null })).toBe(
      DEFAULT_TRIAGE_STATUS,
    );
  });

  test("a falsy team resolves to null", () => {
    expect(resolveTriageStatusForTeam(null, { getConfig: () => null })).toBeNull();
  });

  test("resolveEligibleQuery continues to emit the shared default", () => {
    expect(resolveEligibleQuery({ team: "CAT", eligibleQuery: null }).triageStatus).toBe(
      DEFAULT_TRIAGE_STATUS,
    );
  });
});
