// project-settings-pane.test.tsx — CTL-1153 Phase 5: tree-walk tests (no DOM render).
import { describe, it, expect } from "bun:test";
import type { ReactNode, ReactElement } from "react";
// Use the pure content renderer (no hooks) for tree-walk testing.
import { ProjectSettingsPaneContent, buildProjectPatch } from "./project-settings-pane";
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
  vcsRepo: null as string | null,
  defaultColor: "blue",
  storedName: null,
  storedColor: null,
  stateMap: null,
};

const projectWithSource = { ...project, vcsRepo: "coalesce-labs/catalyst" };

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ProjectSettingsPane", () => {
  it("renders the project name as a heading", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Catalyst")).toBe(true);
  });

  it("renders the project key", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "CTL")).toBe(true);
  });

  it("renders all 8 hue names as color options", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    for (const hue of NAMED_COLOR_NAMES) {
      expect(containsText(el, hue)).toBe(true);
    }
  });

  it("renders an Auto color option", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Auto")).toBe(true);
  });

  it("renders all 12 STATE_MAP_KEYS labels", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    for (const k of STATE_MAP_KEYS) {
      expect(containsText(el, STATE_MAP_KEY_LABEL[k])).toBe(true);
    }
  });

  it("renders a Save button", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Save")).toBe(true);
  });

  it("renders display name section header", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Display name")).toBe(true);
  });
});

// ── CTL-1212: Identity / Source / Workflow sections ───────────────────────────

describe("ProjectSettingsPaneContent — CTL-1212 sections", () => {
  const baseProps = {
    name: "",
    color: "auto" as const,
    icon: null as string | null,
    candidates: [] as import("@/lib/repo-icons").IconCandidate[],
    stateMapEdits: {} as Record<string, string>,
    saving: false,
    error: null as string | null,
    onNameChange: () => {},
    onColorChange: () => {},
    onIconChange: () => {},
    onStateMapChange: () => {},
    onSave: () => {},
  };

  it("renders Identity, Source, and Workflow section headers", () => {
    const el = ProjectSettingsPaneContent({ project: projectWithSource, ...baseProps });
    for (const h of ["Identity", "Source", "Workflow"]) {
      expect(containsText(el, h)).toBe(true);
    }
  });

  it("shows the Linear team key in Source", () => {
    const el = ProjectSettingsPaneContent({ project: projectWithSource, ...baseProps });
    expect(containsText(el, "CTL")).toBe(true);
  });

  it("shows the GitHub repo in Source when vcsRepo is set", () => {
    const el = ProjectSettingsPaneContent({ project: projectWithSource, ...baseProps });
    expect(containsText(el, "coalesce-labs/catalyst")).toBe(true);
    expect(containsText(el, "managed in configuration")).toBe(true);
  });

  it("renders a placeholder when vcsRepo is null", () => {
    const el = ProjectSettingsPaneContent({ project, ...baseProps });
    expect(containsText(el, "managed in configuration")).toBe(true);
  });

  it("shows eligible-query defaults in Workflow", () => {
    const el = ProjectSettingsPaneContent({ project: projectWithSource, ...baseProps });
    expect(containsText(el, "Todo")).toBe(true);
    expect(containsText(el, "Triage")).toBe(true);
  });
});

// ── CTL-1225: save confirmation ───────────────────────────────────────────────
describe("CTL-1225 save confirmation", () => {
  it("renders the default Save label when idle", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Save")).toBe(true);
    expect(containsText(el, "Saved")).toBe(false);
  });

  it("renders a Saved confirmation when saved is true", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: false, saved: true, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Saved")).toBe(true);
  });

  it("prefers the Saving label over Saved while a save is in flight", () => {
    const el = ProjectSettingsPaneContent({ project, name: "", color: "auto", icon: null, candidates: [], stateMapEdits: {}, saving: true, saved: true, error: null, onNameChange: () => {}, onColorChange: () => {}, onIconChange: () => {}, onStateMapChange: () => {}, onSave: () => {} });
    expect(containsText(el, "Saving")).toBe(true);
  });
});

describe("buildProjectPatch", () => {
  const base = {
    key: "CTL", name: "Catalyst", repo: "catalyst",
    vcsRepo: null as string | null,
    defaultColor: "blue", storedName: null, storedColor: null, stateMap: null,
  };

  it("emits the server field name `color` (not `defaultColor`) on a color change", () => {
    const patch = buildProjectPatch(base, { name: "", color: "lime", stateMapEdits: {} });
    expect(patch).toHaveProperty("color", "lime");
    expect(patch).not.toHaveProperty("defaultColor");
  });

  it("maps the `auto` sentinel to null (clear the override)", () => {
    const stored = { ...base, storedColor: "lime" };
    const patch = buildProjectPatch(stored, { name: "", color: "auto", stateMapEdits: {} });
    expect(patch).toHaveProperty("color", null);
  });

  it("omits color when unchanged from the stored value", () => {
    const stored = { ...base, storedColor: "lime" };
    const patch = buildProjectPatch(stored, { name: "", color: "lime", stateMapEdits: {} });
    expect(patch).not.toHaveProperty("color");
  });

  it("includes name only when changed", () => {
    const patch = buildProjectPatch(base, { name: "Renamed", color: "auto", stateMapEdits: {} });
    expect(patch).toHaveProperty("name", "Renamed");
  });

  it("never includes `defaultColor` in any output", () => {
    const patch1 = buildProjectPatch(base, { name: "", color: "lime", stateMapEdits: {} });
    const patch2 = buildProjectPatch(base, { name: "", color: "auto", stateMapEdits: {} });
    expect(patch1).not.toHaveProperty("defaultColor");
    expect(patch2).not.toHaveProperty("defaultColor");
  });

  // CTL-1208: icon field diff tests
  it("emits icon when set to a glyph ref", () => {
    const patch = buildProjectPatch(base, { name: "", color: "auto", stateMapEdits: {}, icon: "phosphor:rocket" });
    expect(patch).toHaveProperty("icon", "phosphor:rocket");
  });

  it("emits icon: null when selecting Auto (clear icon override)", () => {
    const stored = { ...base, icon: "phosphor:rocket" };
    const patch = buildProjectPatch(stored, { name: "", color: "auto", stateMapEdits: {}, icon: null });
    expect(patch).toHaveProperty("icon", null);
  });

  it("omits icon when unchanged from the stored value", () => {
    const stored = { ...base, icon: "phosphor:rocket" };
    const patch = buildProjectPatch(stored, { name: "", color: "auto", stateMapEdits: {}, icon: "phosphor:rocket" });
    expect(patch).not.toHaveProperty("icon");
  });

  it("omits icon when both stored and edit are null/absent", () => {
    const patch = buildProjectPatch(base, { name: "", color: "auto", stateMapEdits: {}, icon: null });
    expect(patch).not.toHaveProperty("icon");
  });

  it("includes icon AND color when both change simultaneously", () => {
    const patch = buildProjectPatch(base, { name: "", color: "green", stateMapEdits: {}, icon: "phosphor:git-fork" });
    expect(patch).toHaveProperty("icon", "phosphor:git-fork");
    expect(patch).toHaveProperty("color", "green");
  });
});
