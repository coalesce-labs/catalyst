// keymap.test.ts — units for the static `?` cheatsheet keymap (CTL-916 / DETAIL5).
// Proves the Gherkin "a keyboard cheatsheet overlay renders from the shared keymap
// constant, documenting j/k, g-chords, Esc layering, /, and ⌘K" — and the §3.4
// contract that the cheatsheet documents the SAME keys the DETAIL1 classifier
// binds (key-nav.ts), so the two can never drift.
//
// Pure imports only (no DOM, no jotai) — runs under `cd ui && bun test`.
import { describe, it, expect } from "bun:test";
import { KEYMAP, KEYMAP_BOUND_KEYS, type KeymapSection } from "./keymap";
import { classifyKey, type KeyAction } from "../hooks/key-nav";

function allEntries() {
  return KEYMAP.flatMap((s: KeymapSection) => s.entries);
}

describe("keymap — the `?` cheatsheet documents the mandated keys", () => {
  it("documents j and k (list walk)", () => {
    expect(KEYMAP_BOUND_KEYS.has("j")).toBe(true);
    expect(KEYMAP_BOUND_KEYS.has("k")).toBe(true);
  });

  it("documents the g-chords (g t / g w / g a)", () => {
    expect(KEYMAP_BOUND_KEYS.has("g t")).toBe(true);
    expect(KEYMAP_BOUND_KEYS.has("g w")).toBe(true);
    expect(KEYMAP_BOUND_KEYS.has("g a")).toBe(true);
  });

  it("documents ⌘K, ?, and /", () => {
    expect(KEYMAP_BOUND_KEYS.has("⌘K")).toBe(true);
    expect(KEYMAP_BOUND_KEYS.has("?")).toBe(true);
    expect(KEYMAP_BOUND_KEYS.has("/")).toBe(true);
  });

  it("documents the layered Esc behaviour explicitly", () => {
    const esc = allEntries().find((e) => e.keys === "Esc");
    expect(esc).toBeDefined();
    // The Gherkin calls out "Esc layering" — the description must name the layering.
    expect(esc!.description.toLowerCase()).toContain("layer");
  });

  it("every entry has non-empty keys + description (no blank cheatsheet rows)", () => {
    for (const e of allEntries()) {
      expect(e.keys.trim().length).toBeGreaterThan(0);
      expect(e.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("groups the shortcuts into titled sections", () => {
    expect(KEYMAP.length).toBeGreaterThan(0);
    for (const s of KEYMAP) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.entries.length).toBeGreaterThan(0);
    }
  });
});

describe("keymap — stays in sync with the live DETAIL1 classifier (key-nav.ts)", () => {
  // For each documented key, drive the real classifier and confirm it resolves to
  // a non-`none` action — so the cheatsheet can never advertise a key the
  // classifier ignores. (The g-chords need the chordPending flag set.)
  const cases: Array<{ doc: string; action: KeyAction["type"]; run: () => KeyAction }> = [
    { doc: "j", action: "next", run: () => classifyKey({ key: "j" }, undefined, false) },
    { doc: "k", action: "prev", run: () => classifyKey({ key: "k" }, undefined, false) },
    { doc: "/", action: "focus-search", run: () => classifyKey({ key: "/" }, undefined, false) },
    { doc: "?", action: "help", run: () => classifyKey({ key: "?" }, undefined, false) },
    { doc: "Esc", action: "escape", run: () => classifyKey({ key: "Escape" }, undefined, false) },
    {
      doc: "⌘K",
      action: "palette",
      run: () => classifyKey({ key: "k", metaKey: true }, undefined, false),
    },
    { doc: "g t", action: "goto-ticket", run: () => classifyKey({ key: "t" }, undefined, true) },
    { doc: "g w", action: "goto-worker", run: () => classifyKey({ key: "w" }, undefined, true) },
    { doc: "g a", action: "goto-active", run: () => classifyKey({ key: "a" }, undefined, true) },
  ];

  for (const c of cases) {
    it(`"${c.doc}" is documented AND the classifier binds it to ${c.action}`, () => {
      expect(KEYMAP_BOUND_KEYS.has(c.doc)).toBe(true);
      expect(c.run().type).toBe(c.action);
    });
  }
});
