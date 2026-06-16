// pending-section-pane.test.tsx — CTL-1212: tree-walk tests (no DOM render).
import { describe, it, expect } from "bun:test";
import type { ReactNode, ReactElement } from "react";
import { PendingSectionPane } from "./pending-section-pane";

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

const clusterSection = {
  key: "__cluster__",
  label: "Cluster",
  note: "Cluster-wide configuration will appear here.",
};

describe("PendingSectionPane", () => {
  it("renders the section label", () => {
    const el = PendingSectionPane({ section: clusterSection });
    expect(containsText(el, "Cluster")).toBe(true);
  });

  it("renders the section note", () => {
    const el = PendingSectionPane({ section: clusterSection });
    expect(containsText(el, "Cluster-wide configuration will appear here.")).toBe(true);
  });

  it("renders pending configuration service message", () => {
    const el = PendingSectionPane({ section: clusterSection });
    expect(containsText(el, "Pending")).toBe(true);
  });
});
