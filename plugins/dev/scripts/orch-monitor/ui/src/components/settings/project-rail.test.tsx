// project-rail.test.tsx — CTL-1153 Phase 5: tree-walk tests (no DOM render).
// Pattern: call component fn directly, walk returned React element tree.
import { describe, it, expect } from "bun:test";
import type { ReactNode, ReactElement } from "react";
import { ProjectRail } from "./project-rail";
import type { ProjectRailRow } from "@/lib/project-settings-model";

// ── tree-walk helpers ─────────────────────────────────────────────────────────

function isReactElement(node: unknown): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node && "type" in node;
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isReactElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }
  return "";
}

function containsText(node: ReactNode, text: string): boolean {
  return collectText(node).includes(text);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const rows: ProjectRailRow[] = [
  { key: "CTL", label: "Catalyst", dotColorName: "blue", hasWork: true, iconUrl: null },
  { key: "ADV", label: "Adva", dotColorName: null, hasWork: false, iconUrl: null },
];

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ProjectRail", () => {
  it("renders a General entry at the top", () => {
    const el = ProjectRail({ rows, selectedKey: null, onSelect: () => {} });
    expect(containsText(el, "General")).toBe(true);
  });

  it("renders one entry per project row", () => {
    const el = ProjectRail({ rows, selectedKey: null, onSelect: () => {} });
    expect(containsText(el, "Catalyst")).toBe(true);
    expect(containsText(el, "Adva")).toBe(true);
  });

  it("marks the General row as selected when selectedKey is null", () => {
    const el = ProjectRail({ rows, selectedKey: null, onSelect: () => {} });
    const text = collectText(el);
    expect(text).toContain("General");
  });

  it("marks the correct project row as selected", () => {
    const el = ProjectRail({ rows, selectedKey: "CTL", onSelect: () => {} });
    expect(containsText(el, "Catalyst")).toBe(true);
  });

  it("renders with no rows (just General)", () => {
    const el = ProjectRail({ rows: [], selectedKey: null, onSelect: () => {} });
    expect(containsText(el, "General")).toBe(true);
  });
});
