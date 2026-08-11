import { describe, expect, test } from "bun:test";
import { buildPriorArtifactExplanationFields, isPriorArtifactBlock, parseDispatchRefusal, resolvePriorArtifactRespondGateMode } from "./prior-artifact-block.mjs";

describe("prior artifact block", () => {
  test("parses a refusal object from multi-line stdout", () => {
    const stdout = 'preamble\n{"status":"refused","reason":"prior_artifact_missing","artifact":"glob:thoughts/shared/research","searchedPath":"/wt/CAT-55/thoughts/shared/research"}\n';
    expect(parseDispatchRefusal(stdout)).toEqual({ reason: "prior_artifact_missing", artifact: "glob:thoughts/shared/research", artifactDir: "thoughts/shared/research", searchedPath: "/wt/CAT-55/thoughts/shared/research" });
  });
  test("rejects malformed and non-refused stdout", () => {
    for (const value of ["", "not json", "[1,2]", '{"status":"launched"}', null, undefined]) expect(parseDispatchRefusal(value)).toBeNull();
    expect(parseDispatchRefusal('{"status":"refused"}')).toBeNull();
  });
  test("supports older refusal output without searchedPath", () => {
    expect(parseDispatchRefusal('{"status":"refused","reason":"prior_artifact_missing","artifact":"glob:thoughts/shared/plans"}')).toMatchObject({ artifactDir: "thoughts/shared/plans", searchedPath: null });
  });
  test("predicate requires stalled reason and exit code 2", () => {
    const signal = { stalledReason: "prior-artifact-retry-exhausted", dispatchFailureCode: 2 };
    expect(isPriorArtifactBlock(signal)).toBe(true);
    expect(isPriorArtifactBlock({ ...signal, dispatchFailureCode: 0 })).toBe(false);
    expect(isPriorArtifactBlock({ ...signal, stalledReason: "dispatch-circuit-breaker" })).toBe(false);
    for (const value of [null, undefined, "x", 42]) expect(isPriorArtifactBlock(value)).toBe(false);
  });
  test("gate mode defaults unknown values to enforce", () => {
    expect(resolvePriorArtifactRespondGateMode("off")).toBe("off");
    expect(resolvePriorArtifactRespondGateMode("shadow")).toBe("shadow");
    expect(resolvePriorArtifactRespondGateMode("bogus")).toBe("enforce");
  });
  test("manual explanation names the artifact and searched path", () => {
    const value = buildPriorArtifactExplanationFields({ ticket: "CAT-55", phase: "plan", artifactDir: "thoughts/shared/research", searchedPath: "/wt/CAT-55/thoughts/shared/research" });
    expect(value.escalation_type).toBe("manual");
    expect(value.problem).toContain("thoughts/shared/research");
    expect(value.problem).toContain("/wt/CAT-55/thoughts/shared/research");
    expect(value.why_not_auto).toMatch(/re-dispatching alone will not clear/i);
  });
});
