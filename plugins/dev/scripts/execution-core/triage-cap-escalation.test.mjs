import { describe, test, expect } from "bun:test";
import { buildTriageCapExplanation, formatTriageCapComment } from "./triage-cap-escalation.mjs";
import { validateExplanation } from "./escalation-explanation.mjs";

const evidence = { ticket: "CAT-83", cap: 3, count: 3, artifactPresent: false, signalStatus: "failed" };

describe("triage cap escalation (CAT-83)", () => {
  test("builds an undegraded valid decision", () => {
    const explanation = buildTriageCapExplanation(evidence);
    expect(validateExplanation(explanation, { canExecute: false })).toEqual({ valid: true, errors: [] });
    expect(explanation.degraded).toBeUndefined();
    expect(explanation.options.length).toBeGreaterThanOrEqual(2);
  });

  test("formats a deterministic operator comment", () => {
    const body = formatTriageCapComment(evidence);
    expect(body).toContain("3 of 3");
    expect(body).toContain("No triage.json");
    expect(body).toContain("re-arm");
    expect(body).toBe(formatTriageCapComment(evidence));
  });
});
