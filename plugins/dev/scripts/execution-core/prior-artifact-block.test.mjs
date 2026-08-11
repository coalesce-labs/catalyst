import { describe, expect, test } from "bun:test";
import { PRIOR_ARTIFACT_HOLD_SIGNATURE, buildPriorArtifactExplanationFields, isPriorArtifactBlock, isPriorArtifactForceRequest, parseDispatchRefusal, priorArtifactPresence, resolvePriorArtifactRespondGateMode } from "./prior-artifact-block.mjs";

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
    const value = buildPriorArtifactExplanationFields({ ticket: "CAT-55", phase: "plan", artifact: "glob:thoughts/shared/research", artifactDir: "thoughts/shared/research", searchedPath: "/wt/CAT-55/thoughts/shared/research" });
    expect(value.escalation_type).toBe("manual");
    expect(value.problem).toContain("thoughts/shared/research");
    expect(value.problem).toContain("/wt/CAT-55/thoughts/shared/research");
    expect(value.why_not_auto).toMatch(/re-dispatching alone will not clear/i);
  });
  test("signal specs use the dispatch gate's exact file-existence predicate", () => {
    const input = { ticket: "CAT-55", artifact: "signal:phase-implement.json", artifactDir: "phase-implement.json", searchedPath: "/orch/workers/CAT-55/phase-implement.json", list: () => [] };
    expect(priorArtifactPresence({ ...input, exists: () => true })).toBe(true);
    expect(priorArtifactPresence({ ...input, exists: () => false })).toBe(false);
    expect(buildPriorArtifactExplanationFields({ ticket: "CAT-55", phase: "verify", artifact: input.artifact, artifactDir: input.artifactDir, searchedPath: input.searchedPath })).toBeNull();
  });
  test("glob specs use the dispatch gate's boundary-safe filename predicate", () => {
    const input = { ticket: "CAT-55", artifact: "glob:thoughts/shared/plans", artifactDir: "thoughts/shared/plans", searchedPath: "/wt/thoughts/shared/plans", exists: () => true };
    expect(priorArtifactPresence({ ...input, list: () => ["2026-08-11-cat-551.md"] })).toBe(false);
    expect(priorArtifactPresence({ ...input, list: () => ["2026-08-11-CAT-55-plan.md"] })).toBe(true);
    expect(priorArtifactPresence({ ...input, list: () => { throw new Error("unreadable"); } })).toBe(null);
    expect(priorArtifactPresence({ ...input, list: () => { const err = new Error("missing"); err.code = "ENOENT"; throw err; } })).toBe(false);
  });
  test("a vanished worktree root is indeterminate, not a definitive absence", () => {
    const enoent = () => { const err = new Error("missing"); err.code = "ENOENT"; throw err; };
    const input = { ticket: "CAT-55", artifact: "glob:thoughts/shared/plans", artifactDir: "thoughts/shared/plans", searchedPath: "/wt/CAT-55/thoughts/shared/plans", list: enoent };
    // Worktree still there, artifact dir gone → the document really is absent.
    expect(priorArtifactPresence({ ...input, exists: (p) => p === "/wt/CAT-55" })).toBe(false);
    // Worktree destroyed (CTL-707 L3 / reclaim / monitor node) → no evidence either way.
    expect(priorArtifactPresence({ ...input, exists: () => false })).toBe(null);
    expect(priorArtifactPresence({ ...input, exists: () => { throw new Error("stat failed"); } })).toBe(null);
    const enotdir = () => { const err = new Error("not a dir"); err.code = "ENOTDIR"; throw err; };
    expect(priorArtifactPresence({ ...input, list: enotdir, exists: () => false })).toBe(null);
  });
  test("the hold's own echoed comment cannot force its way past the hold", () => {
    expect(isPriorArtifactForceRequest("force prior artifact retry")).toBe(true);
    expect(isPriorArtifactForceRequest("Please FORCE PRIOR ARTIFACT RETRY now")).toBe(true);
    expect(isPriorArtifactForceRequest('Reply with "force prior artifact retry" to override this hold.\n\n' + PRIOR_ARTIFACT_HOLD_SIGNATURE)).toBe(false);
    for (const value of ["", "retry please", null, undefined, 42]) expect(isPriorArtifactForceRequest(value)).toBe(false);
  });
});
