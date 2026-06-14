// process-model.test.ts — Phase 2 pure model tests (CTL-1101).
// Build a fixture from the live buildFsmDescriptor() export — same source the
// contract test uses — so this suite never re-hardcodes phase names or counts.
// Pure bun:test, no DOM.
import { describe, it, expect, beforeAll } from "bun:test";
import { buildFsmDescriptor } from "../../../../lib/fsm-descriptor.mjs";
import {
  buildProcessModel,
  EDGE_TAXONOMY,
  TAXONOMY_COLOR,
  EFFORT_RULES_PROSE,
  edgeGroup,
  type FsmDescriptor,
  type ProcessModel,
} from "./process-model";
import { LIVE } from "../board/board-tokens";

let descriptor: FsmDescriptor;
let model: ProcessModel;

beforeAll(async () => {
  descriptor = (await buildFsmDescriptor()) as unknown as FsmDescriptor;
  model = buildProcessModel(descriptor);
});

// ── EDGE_TAXONOMY ──────────────────────────────────────────────────────────────
describe("EDGE_TAXONOMY", () => {
  it("maps every kind present in the live descriptor to a group", () => {
    for (const t of descriptor.transitions) {
      expect(EDGE_TAXONOMY[t.kind as keyof typeof EDGE_TAXONOMY]).toBeDefined();
    }
  });

  it("edgeGroup falls back to DETOUR for an unknown kind (never throws)", () => {
    expect(edgeGroup("unknown-kind")).toBe("DETOUR");
    expect(edgeGroup("advance")).toBe("ADVANCE");
    expect(edgeGroup("park")).toBe("PARK");
  });
});

// ── TAXONOMY_COLOR ─────────────────────────────────────────────────────────────
describe("TAXONOMY_COLOR", () => {
  it("covers all four taxonomy groups", () => {
    for (const g of ["ADVANCE", "DETOUR", "RESILIENCE", "PARK"] as const) {
      expect(TAXONOMY_COLOR[g]).toBeDefined();
    }
  });

  it("no group color equals the reserved LIVE cyan (#53cde2)", () => {
    for (const color of Object.values(TAXONOMY_COLOR)) {
      expect(color).not.toBe(LIVE);
    }
  });
});

// ── EFFORT_RULES_PROSE ─────────────────────────────────────────────────────────
describe("EFFORT_RULES_PROSE", () => {
  it("matches the design glyph-for-glyph (en-dash → and middot ·)", () => {
    expect(EFFORT_RULES_PROSE).toBe(
      "estimate < 3 → medium · ≥ 3 → high · ≥ 8 → xhigh + decompose",
    );
  });
});

// ── buildProcessModel — nodes ──────────────────────────────────────────────────
describe("buildProcessModel — nodes", () => {
  it("includes every pipeline phase, remediate ancillary, and synthetic nodes", () => {
    const ids = new Set(model.nodes.map((n) => n.id));
    // Every descriptor phase must be present.
    for (const p of descriptor.phases) {
      expect(ids.has(p)).toBe(true);
    }
    // Synthetic nodes.
    expect(ids.has("(queued)")).toBe(true);
    expect(ids.has("(done)")).toBe(true);
    expect(ids.has("(stalled)")).toBe(true);
    expect(ids.has("needs-input")).toBe(true);
    // Ancillary (remediate).
    for (const a of descriptor.ancillaryPhases) {
      expect(ids.has(a)).toBe(true);
    }
  });

  it("tags pipeline phases as type='phase' with lane='pipeline'", () => {
    for (const p of descriptor.phases) {
      const node = model.nodes.find((n) => n.id === p);
      expect(node).toBeDefined();
      if (node) {
        expect(node.type).toBe("phase");
        expect(node.lane).toBe("pipeline");
      }
    }
  });

  it("tags remediate as type='remediate' with lane='remediate'", () => {
    const node = model.nodes.find((n) => n.id === "remediate");
    expect(node).toBeDefined();
    if (node) {
      expect(node.type).toBe("remediate");
      expect(node.lane).toBe("remediate");
    }
  });

  it("tags needs-input as type='siding' with lane='siding'", () => {
    const node = model.nodes.find((n) => n.id === "needs-input");
    expect(node).toBeDefined();
    if (node) {
      expect(node.type).toBe("siding");
      expect(node.lane).toBe("siding");
    }
  });

  it("tags (done)/(stalled) as type='terminal' with lane='terminal'", () => {
    for (const id of ["(done)", "(stalled)"]) {
      const node = model.nodes.find((n) => n.id === id);
      expect(node).toBeDefined();
      if (node) {
        expect(node.type).toBe("terminal");
        expect(node.lane).toBe("terminal");
      }
    }
  });

  it("tags (queued) as type='queued' with lane='entry'", () => {
    const node = model.nodes.find((n) => n.id === "(queued)");
    expect(node).toBeDefined();
    if (node) {
      expect(node.type).toBe("queued");
      expect(node.lane).toBe("entry");
    }
  });

  it("pipeline x is strictly increasing by stageRank", () => {
    // Build phase→node map for pipeline phases.
    const by = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    // For each consecutive pipeline-phase pair, assert x is strictly increasing.
    const pipelinePhases = descriptor.phases.filter((p) => p !== "remediate");
    for (let i = 1; i < pipelinePhases.length; i++) {
      const a = by[pipelinePhases[i - 1]];
      const b = by[pipelinePhases[i]];
      if (a && b) {
        expect(a.position.x).toBeLessThan(b.position.x);
      }
    }
  });

  it("remediate floats between implement and verify (stageRank 3 < 4 < 5)", () => {
    const by = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    expect(by.implement.position.x).toBeLessThan(by.remediate.position.x);
    expect(by.remediate.position.x).toBeLessThan(by.verify.position.x);
  });

  it("remediate.y is above the pipeline center (remediate lane sits above pipeline lane)", () => {
    const by = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    // remediate.y should be strictly less than research.y (above pipeline).
    expect(by.remediate.position.y).toBeLessThan(by.research.position.y);
  });

  it("remediate node carries cycleCap in its data", () => {
    const node = model.nodes.find((n) => n.id === "remediate");
    expect(node?.data.cycleCap).toBe(descriptor.remediateCycleCap);
  });
});

// ── buildProcessModel — edges ──────────────────────────────────────────────────
describe("buildProcessModel — edges", () => {
  it("EXCLUDES self-loops (revive/turn-cap, from===to) from the edge set", () => {
    expect(model.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("every edge has a valid taxonomy group from EDGE_TAXONOMY", () => {
    for (const e of model.edges) {
      expect(["ADVANCE", "DETOUR", "RESILIENCE", "PARK"]).toContain(e.group);
    }
  });
});

// ── buildProcessModel — glyphs ─────────────────────────────────────────────────
describe("buildProcessModel — glyphs", () => {
  it("emits revive + turn-cap glyphs per pipeline phase (verify has both)", () => {
    const verifyGlyphs = model.glyphs
      .filter((g) => g.nodeId === "verify")
      .map((g) => g.kind);
    expect(verifyGlyphs).toContain("revive");
    expect(verifyGlyphs).toContain("turn-cap");
  });

  it("every pipeline phase has a revive and a turn-cap glyph", () => {
    for (const phase of descriptor.phases) {
      const glyphKinds = model.glyphs
        .filter((g) => g.nodeId === phase)
        .map((g) => g.kind);
      expect(glyphKinds).toContain("revive");
      expect(glyphKinds).toContain("turn-cap");
    }
  });
});

// ── buildProcessModel — machine facts ─────────────────────────────────────────
describe("buildProcessModel — machine facts", () => {
  it("derives machine facts from the descriptor (no hard-coding)", () => {
    expect(model.facts.entryPhase).toBe(descriptor.entryPhase);
    expect(model.facts.terminalPhase).toBe(descriptor.terminalPhase);
    expect(model.facts.remediateCycleCap).toBe(descriptor.remediateCycleCap);
    expect(model.facts.reviveBudget).toBe(descriptor.reviveBudget);
    expect(model.facts.nonPreemptable).toEqual(descriptor.nonPreemptable);
    expect(model.facts.effortRulesProse).toBe(EFFORT_RULES_PROSE);
    expect(model.facts.descriptorSha).toBe(descriptor.descriptorSha);
    expect(model.facts.rulesSha).toBe(descriptor.rulesSha);
  });

  it("derives cycle id and members from the first cycle", () => {
    const cycle = descriptor.cycles[0];
    expect(model.facts.cycleId).toBe(cycle.id);
    expect(model.facts.cycleMembers).toEqual(cycle.members);
  });
});
