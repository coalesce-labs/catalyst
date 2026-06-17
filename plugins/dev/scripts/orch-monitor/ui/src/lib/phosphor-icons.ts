// phosphor-icons.ts — hybrid Phosphor resolver (CTL-1233).
// Sync tier: 36 featured glyphs (tree-shaken via phosphor-featured.ts) + a cache populated after
// the async load. Async tier: dynamic import of the full ~1,500-icon set on first demand.
// NO top-level `import * as` — that was the CTL-1226 bundle-bloat source.
import { useSyncExternalStore } from "react";
import type { Icon } from "@phosphor-icons/react";
import { FEATURED_ICONS } from "./phosphor-featured";

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

let _registry: Record<string, unknown> | null = null; // full namespace, after load
let _names: readonly string[] = [];                    // enumerated kebab names, after load
let _loadPromise: Promise<readonly string[]> | null = null;
const _subscribers = new Set<() => void>();

/** Synchronous resolve: featured map first, then the post-load cache. null if not (yet) available. */
export function resolvePhosphorIcon(name: string): Icon | null {
  const featured = FEATURED_ICONS[name] as Icon | undefined;
  if (featured) return featured;
  if (_registry) {
    const C = _registry[kebabToPascal(name)];
    return typeof C === "object" || typeof C === "function" ? ((C as Icon) ?? null) : null;
  }
  return null;
}

/** Loaded names (kebab, sorted). Empty until loadPhosphorRegistry() resolves. */
export function enumeratePhosphorGlyphNames(): readonly string[] {
  return _names;
}

/** True once the full set has been dynamically imported. */
export function isPhosphorLoaded(): boolean {
  return _registry !== null;
}

/** Memoized dynamic import of the full set. Resolves to the enumerated kebab names. */
export function loadPhosphorRegistry(): Promise<readonly string[]> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = import("@phosphor-icons/react").then((mod) => {
    _registry = mod as unknown as Record<string, unknown>;
    _names = enumerateFrom(_registry);
    for (const cb of _subscribers) cb();
    return _names;
  });
  return _loadPromise;
}

/** React subscription: re-render a component when the full set finishes loading. */
export function usePhosphorRegistry(): boolean {
  return useSyncExternalStore(
    (cb) => {
      _subscribers.add(cb);
      return () => _subscribers.delete(cb);
    },
    () => _registry !== null,
    () => _registry !== null, // server snapshot (SSR): not loaded
  );
}

// XIcon-twin + round-trip filter — same heuristic as the pre-CTL-1233 enumeratePhosphorGlyphNames.
function enumerateFrom(reg: Record<string, unknown>): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const pascal of Object.keys(reg)) {
    if (pascal.endsWith("Icon")) continue;
    if (!(`${pascal}Icon` in reg)) continue;
    const kebab = pascalToKebab(pascal);
    if (seen.has(kebab)) continue;
    if (kebabToPascal(kebab) !== pascal) continue;
    const C = reg[pascal];
    if (typeof C !== "object" && typeof C !== "function") continue;
    seen.add(kebab);
    names.push(kebab);
  }
  names.sort();
  return names;
}
