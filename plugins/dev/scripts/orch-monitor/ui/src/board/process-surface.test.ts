// process-surface.test.ts — CTL-1101 Phase 3. Pure render-seam helpers only.
// Per repo convention, @xyflow/react components are NOT mounted (requires DOM).
// Only the tested contract surface is exercised here.
import { describe, it, expect, beforeAll } from "bun:test";
import { buildFsmDescriptor } from "../../../../lib/fsm-descriptor.mjs";
import { buildProcessModel, type ProcessModel } from "../lib/process-model";
import {
  edgeStyleForKind,
  isGlyphSelfLoop,
  toFlowEdges,
  nodeBorderColor,
  PHASE_NODE_GEOMETRY,
} from "./process-surface";
import { LIVE, C, PHASE } from "./board-tokens";

let model: ProcessModel;
beforeAll(async () => {
  const descriptor = await buildFsmDescriptor();
  model = buildProcessModel(descriptor as never);
});

// ── edgeStyleForKind ────────────────────────────────────────────────────────────
describe("edgeStyleForKind", () => {
  it("advance is solid (not dashed)", () => {
    expect(edgeStyleForKind("advance").dashed).toBe(false);
  });

  it("every non-advance family is dashed", () => {
    for (const k of [
      "revive",
      "escalation",
      "turn-cap",
      "remediate-cycle",
      "resume",
      "park",
    ] as const) {
      expect(edgeStyleForKind(k).dashed).toBe(true);
    }
  });

  it("no kind produces the reserved LIVE cyan stroke", () => {
    for (const k of [
      "advance",
      "revive",
      "escalation",
      "turn-cap",
      "remediate-cycle",
      "resume",
      "park",
    ] as const) {
      expect(edgeStyleForKind(k).style.stroke).not.toBe(LIVE);
    }
  });

  it("escalation uses C.red as stroke", () => {
    expect(edgeStyleForKind("escalation").style.stroke).toBe(C.red);
  });

  it("returns smoothstep type", () => {
    expect(edgeStyleForKind("advance").type).toBe("smoothstep");
  });
});

// ── isGlyphSelfLoop ─────────────────────────────────────────────────────────────
describe("isGlyphSelfLoop", () => {
  const mk = (f: string, t: string, k: string) =>
    ({ edgeId: `${f}->${k}`, from: f, to: t, kind: k }) as never;

  it("revive self-loop is a glyph", () => {
    expect(isGlyphSelfLoop(mk("verify", "verify", "revive"))).toBe(true);
  });

  it("turn-cap self-loop is a glyph", () => {
    expect(isGlyphSelfLoop(mk("research", "research", "turn-cap"))).toBe(true);
  });

  it("advance hop is NOT a glyph", () => {
    expect(isGlyphSelfLoop(mk("research", "plan", "advance"))).toBe(false);
  });

  it("escalation is NOT a glyph (different source and target)", () => {
    expect(isGlyphSelfLoop(mk("verify", "(stalled)", "escalation"))).toBe(false);
  });
});

// ── toFlowEdges ─────────────────────────────────────────────────────────────────
describe("toFlowEdges", () => {
  it("drops self-loop glyphs (no source===target edges in output)", () => {
    const edges = toFlowEdges(model.edges);
    expect(edges.some((e) => e.source === e.target)).toBe(false);
  });

  it("collapses escalation family to exactly one representative edge into (stalled)", () => {
    const edges = toFlowEdges(model.edges);
    expect(edges.filter((e) => (e.data as { kind?: string })?.kind === "escalation")).toHaveLength(1);
  });

  it("collapses park family to exactly one representative edge into needs-input", () => {
    const edges = toFlowEdges(model.edges);
    expect(edges.filter((e) => (e.data as { kind?: string })?.kind === "park")).toHaveLength(1);
  });

  it("produces RF Edge objects with source/target/id fields", () => {
    const edges = toFlowEdges(model.edges);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(typeof e.source).toBe("string");
      expect(typeof e.target).toBe("string");
      expect(typeof e.id).toBe("string");
    }
  });
});

// ── nodeBorderColor ─────────────────────────────────────────────────────────────
describe("nodeBorderColor", () => {
  it("pipeline phase returns its PHASE color", () => {
    expect(nodeBorderColor("verify")).toBe(PHASE.verify);
    expect(nodeBorderColor("implement")).toBe(PHASE.implement);
  });

  it("(done) uses C.green", () => {
    expect(nodeBorderColor("done")).toBe(C.green);
  });

  it("(stalled) uses C.red", () => {
    expect(nodeBorderColor("stalled")).toBe(C.red);
  });

  it("queued uses C.fgDim", () => {
    expect(nodeBorderColor("queued")).toBe(C.fgDim);
  });

  it("falls back to C.fgDim for unknown phase", () => {
    expect(nodeBorderColor("unknown-phase-xyz")).toBe(C.fgDim);
  });
});

// ── PHASE_NODE_GEOMETRY ─────────────────────────────────────────────────────────
describe("PHASE_NODE_GEOMETRY", () => {
  it("matches design spec: 120×44, 3px accent, 6px radius", () => {
    expect(PHASE_NODE_GEOMETRY).toMatchObject({
      width: 120,
      height: 44,
      accentWidth: 3,
      radius: 6,
    });
  });
});
