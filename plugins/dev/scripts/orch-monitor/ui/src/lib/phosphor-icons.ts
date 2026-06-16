// phosphor-icons.ts — universal synchronous Phosphor resolver (CTL-1226).
// Replaces the 36-name GLYPH_COMPONENTS static map with a namespace-import resolver
// that covers the full ~1,500-icon set. Both the picker and ProjectMarkIcon use it.
// The namespace cast (Record<string,unknown>) is intentional: the @phosphor-icons/react
// namespace mixes Icon components and utility re-exports; we discriminate at runtime.
import * as PhosphorIcons from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

const REGISTRY = PhosphorIcons as unknown as Record<string, unknown>;

/** Insert a hyphen before each uppercase letter (except the first), then lowercase all. */
export function pascalToKebab(pascal: string): string {
  return pascal.replace(/[A-Z]/g, (char, offset: number) =>
    offset === 0 ? char.toLowerCase() : `-${char.toLowerCase()}`,
  );
}

/** Capitalize the first letter of each hyphen-separated segment, join without hyphens. */
export function kebabToPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : ""))
    .join("");
}

/** Synchronous resolve: kebab name → Phosphor Icon component, or null. */
export function resolvePhosphorIcon(name: string): Icon | null {
  const C = REGISTRY[kebabToPascal(name)];
  // typeof null === "object" in JS; the ?? null coalesces that case to null.
  return typeof C === "object" || typeof C === "function" ? (C as Icon) ?? null : null;
}

let _cachedGlyphNames: string[] | null = null;

/**
 * Every renderable icon name (kebab), round-trip-stable, sorted.
 * Uses the XIcon-twin filter: Phosphor exports every icon as both X and XIcon;
 * utility exports (IconBase, IconContext, etc.) lack the XIcon twin and are excluded.
 * Any name that fails the kebab↔Pascal round-trip is also excluded.
 * Result is memoized after the first call.
 */
export function enumeratePhosphorGlyphNames(): string[] {
  if (_cachedGlyphNames !== null) return _cachedGlyphNames;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const pascal of Object.keys(REGISTRY)) {
    if (pascal.endsWith("Icon")) continue;
    if (!(`${pascal}Icon` in REGISTRY)) continue;
    const kebab = pascalToKebab(pascal);
    if (seen.has(kebab)) continue;
    if (kebabToPascal(kebab) !== pascal) continue;
    if (resolvePhosphorIcon(kebab) === null) continue;
    seen.add(kebab);
    names.push(kebab);
  }
  names.sort();
  _cachedGlyphNames = names;
  return names;
}
