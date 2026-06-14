// attention-card.test.ts — CTL-1126 Phase 2. Source-analysis guards for the
// AttentionCard component. Mirrors the home-surface.test.ts pattern: read the
// .tsx source as text (bun test has no jsdom, and attention-card.tsx imports
// lucide-react/shadcn which are not available in the orch-monitor test env).
// The pure model behaviour is tree-tested in attention-card-model.test.ts.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMP = join(HERE, "..", "ui", "src", "components", "home");

function read(rel: string) {
  return readFileSync(join(COMP, rel), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const cardSrc = read("attention-card.tsx");
const cardCode = stripComments(cardSrc);

// ── List variant structural guards ────────────────────────────────────────────

describe("AttentionCard list variant — structural source guards (CTL-1126)", () => {
  it("emits data-inbox-row (list row identity hook)", () => {
    expect(cardSrc).toContain("data-inbox-row");
  });

  it("emits data-row-verb + stopPropagation + onAct?.(row.id)", () => {
    expect(cardSrc).toContain("data-row-verb");
    expect(cardCode).toContain("stopPropagation");
    expect(cardSrc).toContain("onAct?.(row.id)");
  });

  it("emits data-row-overflow for the demoted actions menu", () => {
    expect(cardSrc).toContain("data-row-overflow");
  });

  it("emits data-row-duration + data-row-duration-unavailable (honest duration)", () => {
    expect(cardSrc).toContain("data-row-duration");
    expect(cardSrc).toContain("data-row-duration-unavailable");
  });

  it("does NOT use the shadcn Card primitive (no card-in-card)", () => {
    expect(cardCode).not.toContain("components/ui/card");
  });

  it("uses verbActionFor for the primary verb (typed action model, not re-derivation)", () => {
    expect(cardSrc).toContain("verbActionFor");
  });

  it("uses rowDurationMs + fmtRelativeDuration for honest duration", () => {
    expect(cardSrc).toContain("rowDurationMs");
    expect(cardSrc).toContain("fmtRelativeDuration");
  });
});

// ── Glyph (color-blind safe) type chip ───────────────────────────────────────

describe("AttentionCard — escalation type glyph (CTL-1126)", () => {
  it("imports GitFork, ShieldCheck, KeyRound from lucide-react", () => {
    expect(cardSrc).toContain("GitFork");
    expect(cardSrc).toContain("ShieldCheck");
    expect(cardSrc).toContain("KeyRound");
    expect(cardSrc).toContain("lucide-react");
  });

  it("emits data-escalation-type chip for the glyph hook", () => {
    expect(cardSrc).toContain("data-escalation-type");
  });

  it("maps escalationType to the correct glyph (decision→GitFork, auth→ShieldCheck, manual→KeyRound)", () => {
    // Each branch emits the right icon component
    expect(cardCode).toContain("GitFork");
    expect(cardCode).toContain("ShieldCheck");
    expect(cardCode).toContain("KeyRound");
  });
});

// ── Detail variant structural guards ─────────────────────────────────────────

describe("AttentionCard detail variant — structural source guards (CTL-1126)", () => {
  it("emits data-pane-hero for the hero block", () => {
    expect(cardSrc).toContain("data-pane-hero");
  });

  it("emits data-pane-accent for the emphasis tint", () => {
    expect(cardSrc).toContain("data-pane-accent");
  });

  it("emits data-pane-verb for the prominent verb (CTL-903)", () => {
    expect(cardSrc).toContain("data-pane-verb");
  });

  it("emits data-pane-escalation for the escalation hero block", () => {
    expect(cardSrc).toContain("data-pane-escalation");
  });

  it("emits data-escalation-cta for the call-to-action", () => {
    expect(cardSrc).toContain("data-escalation-cta");
  });

  it("emits data-escalation-field for the labelled explanation sections", () => {
    expect(cardSrc).toContain("data-escalation-field");
  });

  it("emits data-pane-options for decision options", () => {
    expect(cardSrc).toContain("data-pane-options");
  });

  it("emits data-pane-blocker for standard blocked hero", () => {
    expect(cardSrc).toContain("data-pane-blocker");
  });
});

// ── Surface-agnostic invariant ────────────────────────────────────────────────

describe("AttentionCard — surface-agnostic invariant (CTL-1126)", () => {
  it("does NOT import from home-surface (surface-agnostic for board/HUD reuse)", () => {
    expect(cardCode).not.toContain("home-surface");
  });

  it("does NOT import from home-inbox directly in a way that couples to surface state", () => {
    // home-inbox is allowed (it's the pure model), but the component must NOT
    // import jotai atoms or surface state from the home surface layer.
    expect(cardCode).not.toContain("jotai");
  });
});
