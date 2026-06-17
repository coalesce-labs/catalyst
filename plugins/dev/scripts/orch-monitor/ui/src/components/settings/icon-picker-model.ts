// icon-picker-model.ts — pure view-model for the server-persisted glyph+favicon picker
// in ProjectSettingsPane (CTL-1208, CTL-1226). No React, no side effects — fully unit-testable.
// CTL-1233: split into buildBasePickerItems (sync: Auto + favicons + featured) and
// buildAllGlyphItems (takes loaded names as arg, pure). filterPickerItems replaces cmdk filtering.
import type { IconCandidate } from "@/lib/repo-icons";
import { PHOSPHOR_GLYPH_NAMES, formatGlyphRef, parseGlyphRef } from "@/lib/project-glyph-set";

export type IconPickerGroup = "auto" | "favicon" | "glyph";

/** One option in the picker command menu. */
export interface IconPickerItem {
  /** The `icon` field value to write: null = clear (Auto), path = favicon, "phosphor:<n>" = glyph. */
  value: string | null;
  /** Human-readable display label (shown in the command list). */
  label: string;
  /** For search filtering — the kebab-case glyph name or candidate path. */
  searchKey: string;
  /** Which group this item belongs to. */
  group: IconPickerGroup;
  /** Glyph name (only set when group === "glyph"). */
  name?: string;
  /** Favicon data URL (only set when group === "favicon"). */
  dataUrl?: string | null;
  /** True for curated Featured icons; false for the rest of the full set. Only set when group === "glyph". */
  featured?: boolean;
}

/**
 * Build the base items (Auto + favicon candidates + 36 featured glyphs).
 * Does NOT require the full Phosphor set to be loaded — safe to call synchronously.
 * The "All icons" grid items are built separately via buildAllGlyphItems after load.
 */
export function buildBasePickerItems(candidates: readonly IconCandidate[]): IconPickerItem[] {
  const items: IconPickerItem[] = [];

  // 1. Auto
  items.push({
    value: null,
    label: "Auto",
    searchKey: "auto",
    group: "auto",
  });

  // 2. Detected favicon candidates
  for (const c of candidates) {
    items.push({
      value: c.path,
      label: c.path.split("/").pop() ?? c.path,
      searchKey: c.path,
      group: "favicon",
      dataUrl: c.dataUrl,
    });
  }

  // 3. Featured (curated) glyphs in curated order
  for (const name of PHOSPHOR_GLYPH_NAMES) {
    items.push({
      value: formatGlyphRef(name),
      label: name.replace(/-/g, " "),
      searchKey: name,
      group: "glyph",
      name,
      featured: true,
    });
  }

  return items;
}

const FEATURED_SET = new Set(PHOSPHOR_GLYPH_NAMES);

/**
 * Build non-featured glyph items from the full loaded name list.
 * Filters out featured names to avoid duplicates; preserves the sorted order from the loader.
 * Pass the result of enumeratePhosphorGlyphNames() after loadPhosphorRegistry() resolves.
 */
export function buildAllGlyphItems(allNames: readonly string[]): IconPickerItem[] {
  return allNames
    .filter((n) => !FEATURED_SET.has(n))
    .map((name) => ({
      value: formatGlyphRef(name),
      label: name.replace(/-/g, " "),
      searchKey: name,
      group: "glyph" as const,
      name,
      featured: false,
    }));
}

/**
 * Substring-filter a list of picker items by a query string (case-insensitive).
 * Empty or whitespace-only query returns all items unchanged.
 */
export function filterPickerItems(
  items: readonly IconPickerItem[],
  query: string,
): IconPickerItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (i) => i.searchKey.toLowerCase().includes(q) || i.label.toLowerCase().includes(q),
  );
}

/** Return a short label for the picker trigger button based on the current value. */
export function resolveActiveIconLabel(value: string | null | undefined): string {
  if (!value) return "Auto";
  const glyph = parseGlyphRef(value);
  if (glyph) return glyph.name.replace(/-/g, " ");
  // favicon path: use the filename
  const filename = value.split("/").pop();
  return filename ?? value;
}
