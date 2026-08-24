// loss.test.mjs — CTL-1463 Phase 3: the two-tier loss classifier.
//
// Run: bun test scripts/packaging/__tests__/loss.test.mjs
//
// Every row of the classifier table gets its own fixture, and each assertion
// checks the EXACT class string and policy — not merely that the field was
// read. Asserting a discriminator is read is not asserting it changes the
// answer: a classifier returning "cosmetic" for everything must fail these.

import { describe, test, expect } from "bun:test";

import { classifyPackLosses, buildLossReport, hasUnacknowledgedLosses, lossCounts } from "../core/loss.mjs";

function basePack(overrides = {}) {
  return {
    contractVersion: 1,
    packId: "catalyst-x",
    sourceRoot: "plugins/x",
    skills: [],
    agents: [],
    hooks: { present: false, entryCount: 0 },
    mcpServers: null,
    ...overrides,
  };
}

function classifiedSkill(id, overrides = {}) {
  return {
    id,
    name: id,
    description: "d",
    body: "body text",
    files: [],
    neutral: { effects: [], invocation: "auto" },
    claudeOnly: {},
    ...overrides,
  };
}

describe("the claude target never loses anything", () => {
  test("a pack with hooks, an unclassified skill, and an agent has zero losses on the claude target", () => {
    const pack = basePack({
      skills: [{ ...classifiedSkill("a"), neutral: null }],
      agents: [{ id: "ag", name: "ag", description: "d", body: "b", claudeOnly: {} }],
      hooks: { present: true, entryCount: 3 },
    });
    const result = classifyPackLosses("catalyst-x", pack, "claude");
    expect(result).toEqual({ omitted: [], degraded: [], warnings: [] });
  });
});

describe("hooks.toml — safety, never projected", () => {
  test("hooks.present true omits every otherwise-classified skill from a non-Claude target", () => {
    const pack = basePack({
      skills: [classifiedSkill("guarded")],
      hooks: { present: true, entryCount: 11 },
    });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]).toMatchObject({ skill: "catalyst-x/guarded", class: "safety" });
    expect(result.omitted[0].reason).toContain("hooks.toml");
  });

  test("hooks.present false produces no hooks-related loss (negative control)", () => {
    const pack = basePack({ hooks: { present: false, entryCount: 0 } });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.warnings.some((w) => w.component === "hooks.toml")).toBe(false);
  });
});

describe("allowed-tools / disable-model-invocation — safety, omit unless classified (BOTH directions)", () => {
  test("a skill with neutral: null is OMITTED with class safety", () => {
    const pack = basePack({ skills: [{ ...classifiedSkill("commit"), neutral: null }] });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.omitted.length).toBe(1);
    expect(result.omitted[0].class).toBe("safety");
    expect(result.omitted[0].skill).toBe("catalyst-x/commit");
  });

  test("the SAME skill with a neutral declaration is EMITTED (not omitted) — both directions", () => {
    const pack = basePack({ skills: [classifiedSkill("commit")] });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.omitted).toEqual([]);
  });
});

describe("agents/*.md subagents — capability, warn-and-omit (not build-fail)", () => {
  test("an agent is DEGRADED (not omitted) with class capability", () => {
    const pack = basePack({ agents: [{ id: "locator", name: "locator", description: "d", body: "b", claudeOnly: {} }] });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.omitted).toEqual([]);
    expect(result.degraded.length).toBe(1);
    expect(result.degraded[0].class).toBe("capability");
    expect(result.degraded[0].agent).toBe("catalyst-x/locator");
  });
});

describe("model: / color: / argument-hint: / user-invocable: / version: — cosmetic, dropped + warned", () => {
  for (const field of ["model", "color", "argument-hint", "user-invocable", "version"]) {
    test(`${field} on an EMITTED skill produces a cosmetic warning naming the field`, () => {
      const pack = basePack({ skills: [classifiedSkill("s", { claudeOnly: { [field]: "x" } })] });
      const result = classifyPackLosses("catalyst-x", pack, "codex");
      const w = result.warnings.find((x) => x.field === field);
      expect(w).toBeDefined();
      expect(w.class).toBe("cosmetic");
    });
  }

  test("a skill with none of these fields produces no cosmetic warnings (negative control)", () => {
    const pack = basePack({ skills: [classifiedSkill("s")] });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.warnings.filter((w) => w.class === "cosmetic")).toEqual([]);
  });

  for (const field of ["model", "color"]) {
    test(`${field} on an omitted agent still produces a cosmetic warning naming the agent`, () => {
      const pack = basePack({
        agents: [{ id: "locator", name: "locator", description: "d", body: "b", claudeOnly: { [field]: "x" } }],
      });
      const result = classifyPackLosses("catalyst-x", pack, "codex");
      expect(result.warnings).toContainEqual({
        agent: "catalyst-x/locator",
        class: "cosmetic",
        field,
      });
    });
  }
});

describe("presentation patterns in prose — warned, not omitted", () => {
  test("${CLAUDE_PLUGIN_ROOT} in the body produces a presentation warning", () => {
    const pack = basePack({
      skills: [classifiedSkill("s", { body: 'run ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh' })],
    });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    const w = result.warnings.find((x) => x.class === "presentation");
    expect(w).toBeDefined();
    expect(result.omitted).toEqual([]);
  });

  test("Task(subagent_type=...) in the body produces a presentation warning", () => {
    const pack = basePack({
      skills: [classifiedSkill("s", { body: 'Task(subagent_type="catalyst-dev:codebase-locator")' })],
    });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.warnings.some((w) => w.class === "presentation")).toBe(true);
  });

  test("plain prose with no vendor syntax produces no presentation warning (negative control)", () => {
    const pack = basePack({ skills: [classifiedSkill("s", { body: "just prose, nothing special" })] });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.warnings.filter((w) => w.class === "presentation")).toEqual([]);
  });
});

describe(".mcp.json co-location — capability, reported", () => {
  test("a non-null mcpServers produces a capability warning", () => {
    const pack = basePack({ mcpServers: { mcpServers: {} } });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    const w = result.warnings.find((x) => x.component === ".mcp.json");
    expect(w).toBeDefined();
    expect(w.class).toBe("capability");
  });

  test("mcpServers: null produces no such warning (negative control)", () => {
    const pack = basePack({ mcpServers: null });
    const result = classifyPackLosses("catalyst-x", pack, "codex");
    expect(result.warnings.some((w) => w.component === ".mcp.json")).toBe(false);
  });
});

describe("buildLossReport — determinism and no-silent-caps helpers", () => {
  test("the same input produces byte-identical JSON across two calls (renderedAt is injected, never Date.now())", () => {
    const packs = [
      { packId: "b", pack: basePack({ packId: "b", skills: [{ ...classifiedSkill("z"), neutral: null }] }) },
      { packId: "a", pack: basePack({ packId: "a", agents: [{ id: "y", name: "y", description: "d", body: "b", claudeOnly: {} }] }) },
    ];
    const r1 = buildLossReport({ packs, targetNames: ["codex"], renderedAt: "2026-01-01T00:00:00Z" });
    const r2 = buildLossReport({ packs, targetNames: ["codex"], renderedAt: "2026-01-01T00:00:00Z" });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    // Cross-pack ordering is sorted (packId "a" sorts before "b") — stable ordering, not insertion order.
    expect(r1.targets.codex.degraded[0].agent).toBe("a/y");
  });

  test("hasUnacknowledgedLosses is true when a skill is omitted, false for a fully-classified pack with no hooks/agents/mcp", () => {
    const lossy = buildLossReport({
      packs: [{ packId: "x", pack: basePack({ skills: [{ ...classifiedSkill("s"), neutral: null }] }) }],
      targetNames: ["codex"],
      renderedAt: "t",
    });
    expect(hasUnacknowledgedLosses(lossy)).toBe(true);

    const clean = buildLossReport({
      packs: [{ packId: "x", pack: basePack({ skills: [classifiedSkill("s")] }) }],
      targetNames: ["codex"],
      renderedAt: "t",
    });
    expect(hasUnacknowledgedLosses(clean)).toBe(false);
  });

  test("lossCounts reports non-zero counts, never a silent zero, when losses exist", () => {
    const report = buildLossReport({
      packs: [{ packId: "x", pack: basePack({ skills: [{ ...classifiedSkill("s"), neutral: null }] }) }],
      targetNames: ["codex"],
      renderedAt: "t",
    });
    expect(lossCounts(report).codex.omitted).toBe(1);
  });
});
