// icon-picker-model.ts — pure view-model for the server-persisted glyph+favicon picker
// in ProjectSettingsPane (CTL-1208). No React, no side effects — fully unit-testable.
import type { IconCandidate } from "@/lib/repo-icons";
import { PHOSPHOR_GLYPH_NAMES, formatGlyphRef, parseGlyphRef } from "@/lib/project-glyph-set";
import { enumeratePhosphorGlyphNames } from "@/lib/phosphor-icons";

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
 * Build the flat list of icon picker items for a project.
 * Order: Auto → favicon candidates → Featured glyphs (curated 36) → All icons (full set remainder).
 */
export function buildIconPickerItems(
  candidates: readonly IconCandidate[],
): IconPickerItem[] {
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
    const ext = c.path.split(".").pop()?.toUpperCase() ?? "IMG";
    items.push({
      value: c.path,
      label: c.path.split("/").pop() ?? c.path,
      searchKey: c.path,
      group: "favicon",
      dataUrl: c.dataUrl,
    });
    void ext;
  }

  // 3. Featured (curated) glyphs first, in curated order
  const featuredSet = new Set(PHOSPHOR_GLYPH_NAMES);
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

  // 4. Remaining full-set icons (sorted, excluding curated names to avoid duplicates)
  for (const name of enumeratePhosphorGlyphNames()) {
    if (featuredSet.has(name)) continue;
    items.push({
      value: formatGlyphRef(name),
      label: name.replace(/-/g, " "),
      searchKey: name,
      group: "glyph",
      name,
      featured: false,
    });
  }

  return items;
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
