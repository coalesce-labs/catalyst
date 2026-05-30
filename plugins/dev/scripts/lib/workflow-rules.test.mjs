// workflow-rules.test.mjs — the conditional resolution layer (CTL descriptor v1.1).

import { describe, test, expect } from "bun:test";
import {
  SCOPE_POINTS,
  WorkflowRuleError,
  buildContext,
  evalPredicate,
  resolveStep,
  resolveDescriptorStep,
} from "./workflow-rules.mjs";
import { descriptor } from "./workflow-descriptor.mjs";

describe("buildContext + scope→points", () => {
  test("large scope → estimate 8", () => {
    const c = buildContext({ scope: "large" });
    expect(c.ticket.scope).toBe("large");
    expect(c.ticket.estimate).toBe(8);
  });
  test("unpointed scope → estimate null", () => {
    expect(buildContext({ scope: null }).ticket.estimate).toBeNull();
  });
  test("scope→points map", () => {
    expect(SCOPE_POINTS).toEqual({ small: 1, medium: 3, large: 8, epic: 13 });
  });
});

describe("evalPredicate (closed ops, no eval)", () => {
  const ctx = buildContext({ scope: "large", priority: 2 });
  test("in / eq", () => {
    expect(evalPredicate({ field: "ticket.scope", op: "in", value: ["large", "epic"] }, ctx)).toBe(true);
    expect(evalPredicate({ field: "ticket.scope", op: "in", value: ["small"] }, ctx)).toBe(false);
    expect(evalPredicate({ field: "ticket.scope", op: "eq", value: "large" }, ctx)).toBe(true);
  });
  test("gte / lt on the derived estimate", () => {
    expect(evalPredicate({ field: "ticket.estimate", op: "gte", value: 5 }, ctx)).toBe(true);
    expect(evalPredicate({ field: "ticket.estimate", op: "lt", value: 5 }, ctx)).toBe(false);
  });
  test("unknown field is a VALIDATION ERROR, not silent-false", () => {
    expect(() => evalPredicate({ field: "ticket.points", op: "gte", value: 5 }, ctx)).toThrow(WorkflowRuleError);
  });
  test("unknown op throws (no regex/matches in v1)", () => {
    expect(() => evalPredicate({ field: "ticket.scope", op: "matches", value: ".*" }, ctx)).toThrow(WorkflowRuleError);
  });
  test("valid-but-unpopulated field → false (not throw)", () => {
    expect(evalPredicate({ field: "ticket.estimate", op: "gte", value: 5 }, buildContext({ scope: null }))).toBe(false);
  });
});

describe("resolveStep", () => {
  const base = {
    id: "plan", effort: "high", model: "opus", preamble: ["base pre"], postamble: [],
    rules: [
      {
        when: { field: "ticket.scope", op: "in", value: ["large", "epic"] },
        set: { effort: "max", model: "opusplan" },
        appendPostamble: ["Large ticket — use /workflows."],
      },
    ],
  };
  test("large ticket → effort:max, model:opusplan, postamble appended, audit trail; rules stripped", () => {
    const r = resolveStep(base, buildContext({ scope: "large" }));
    expect(r.effort).toBe("max");
    expect(r.model).toBe("opusplan");
    expect(r.postamble).toEqual(["Large ticket — use /workflows."]);
    expect(r.preamble).toEqual(["base pre"]);
    expect(r._applied).toEqual([0]);
    expect(r.rules).toBeUndefined();
  });
  test("small ticket → unchanged base, no rule fired", () => {
    const r = resolveStep(base, buildContext({ scope: "small" }));
    expect(r.effort).toBe("high");
    expect(r.model).toBe("opus");
    expect(r.postamble).toEqual([]);
    expect(r._applied).toEqual([]);
  });
  test("interpolates ${ticket}/${ticket.scope}/${ticket.estimate} in appended lines", () => {
    const b = {
      id: "plan",
      rules: [
        {
          when: { field: "ticket.scope", op: "in", value: ["large"] },
          appendPostamble: ["${ticket} is ${ticket.scope} (~${ticket.estimate} pts)"],
        },
      ],
    };
    const r = resolveStep(b, buildContext({ scope: "large", ticketId: "CTL-999" }));
    expect(r.postamble).toEqual(["CTL-999 is large (~8 pts)"]);
  });
  test("invalid resolved effort throws (enum mirrors --effort)", () => {
    const b = { id: "x", rules: [{ when: { field: "ticket.scope", op: "eq", value: "large" }, set: { effort: "ultra" } }] };
    expect(() => resolveStep(b, buildContext({ scope: "large" }))).toThrow(WorkflowRuleError);
  });
});

describe("resolveDescriptorStep against the real default descriptor (marquee example is REAL)", () => {
  test("plan step fires the large-ticket rule end-to-end", () => {
    const r = resolveDescriptorStep(descriptor, "plan", buildContext({ scope: "epic", ticketId: "CTL-1" }));
    expect(r.effort).toBe("max");
    expect(r.model).toBe("opusplan");
    expect(r.postamble.join(" ")).toContain("/workflows");
  });
  test("plan step on a small ticket keeps descriptor defaults (effort high, no postamble)", () => {
    const r = resolveDescriptorStep(descriptor, "plan", buildContext({ scope: "small" }));
    expect(r.effort).toBe("high");
    expect(r.postamble).toEqual([]);
  });
});
