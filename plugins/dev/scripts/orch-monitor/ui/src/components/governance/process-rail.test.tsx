// process-rail.test.tsx — CTL-1101 Phase 4. Tree-walk tests (no DOM render).
// Mirrors the event-row.test.tsx pattern: call component functions directly
// and walk the returned React element tree to assert content.
import { describe, it, expect } from "bun:test";
import type { ReactNode, ReactElement } from "react";
import { MachineFooter } from "./process-rail";

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

// ── MachineFooter ─────────────────────────────────────────────────────────────

describe("MachineFooter", () => {
  const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("renders the source receipt with abbreviated sha (7 chars)", () => {
    const el = MachineFooter({ descriptorSha: SHA, prevSha: null });
    const text = collectText(el);
    expect(text).toContain("rendered from workflow.default.json");
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).not.toContain(SHA); // full sha not shown inline
  });

  it("does NOT render the 'machine changed' chip when prevSha matches current", () => {
    const el = MachineFooter({ descriptorSha: SHA, prevSha: SHA });
    expect(containsText(el, "machine changed")).toBe(false);
  });

  it("renders the 'machine changed' chip when prevSha differs from current", () => {
    const el = MachineFooter({ descriptorSha: SHA, prevSha: "old-sha" });
    expect(containsText(el, "machine changed")).toBe(true);
  });

  it("does NOT render the 'machine changed' chip when prevSha is null (first load)", () => {
    const el = MachineFooter({ descriptorSha: SHA, prevSha: null });
    expect(containsText(el, "machine changed")).toBe(false);
  });
});
