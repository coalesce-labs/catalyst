// project-settings-pane.test.tsx — CTL-1153 Phase 5: tree-walk tests (no DOM render).
import { describe, it, expect } from "bun:test";
import type { ReactNode, ReactElement } from "react";
// Use the pure content renderer (no hooks) for tree-walk testing.
import { ProjectSettingsPaneContent } from "./project-settings-pane";
import { NAMED_COLOR_NAMES } from "@/lib/repo-color-picks-store";
import { STATE_MAP_KEYS, STATE_MAP_KEY_LABEL } from "@/lib/project-settings-model";

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

// ── fixture ───────────────────────────────────────────────────────────────────

const project = {
  key: "CTL",
  name: "Catalyst",
  repo: "catalyst",
  defaultColor: "blue",
  storedName: null,
  storedColor: null,
  stateMap: null,
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ProjectSettingsPane", () => {
  it("renders the project name as a heading", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Catalyst")).toBe(true);
  });

  it("renders the project key", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "CTL")).toBe(true);
  });

  it("renders all 8 hue names as color options", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    for (const hue of NAMED_COLOR_NAMES) {
      expect(containsText(el, hue)).toBe(true);
    }
  });

  it("renders an Auto color option", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Auto")).toBe(true);
  });

  it("renders all 12 STATE_MAP_KEYS labels", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    for (const k of STATE_MAP_KEYS) {
      expect(containsText(el, STATE_MAP_KEY_LABEL[k])).toBe(true);
    }
  });

  it("renders a Save button", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Save")).toBe(true);
  });

  it("renders display name section header", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Display name")).toBe(true);
  });
});
