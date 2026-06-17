// phosphor-icons.ts — per-glyph Phosphor resolver (CTL-1249).
// Sync tier: 36 featured glyphs (tree-shaken via phosphor-featured.ts) + a cache populated as
// individual glyphs resolve. Async tier: per-glyph dynamic import — each visible glyph pulls its
// own ~6-12 KB chunk (no 4.9 MB barrel). The kebab name index is a committed static array, so
// full-library search is instant with zero network. loadGlyph hardens the load with .catch + an
// injectable timeout + a RETRYABLE error state (a failed load never sticks).
import { useSyncExternalStore } from "react";
import type { Icon } from "@phosphor-icons/react";
import { FEATURED_ICONS } from "./phosphor-featured";
import { PHOSPHOR_ICON_NAMES } from "./phosphor-icon-index.generated";

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

export type GlyphLoadState = "idle" | "loading" | "ready" | "missing" | "error";
const DEFAULT_TIMEOUT_MS = 10_000;
type ImporterMap = Record<string, () => Promise<Record<string, unknown>>>;

let _importers: ImporterMap | null = null; // populated lazily (or via test override)
let _importersPromise: Promise<ImporterMap> | null = null;
const _resolved = new Map<string, Icon>();
const _inflight = new Map<string, Promise<Icon | null>>();
const _state = new Map<string, GlyphLoadState>();
const _error = new Map<string, string>();
const _subs = new Map<string, Set<() => void>>();

function getImporters(): Promise<ImporterMap> {
  if (_importers) return Promise.resolve(_importers);
  // Lazy: keeps the ~189 KB importer manifest OUT of the main bundle (loads on first glyph demand).
  _importersPromise ??= import("./phosphor-icon-importers.generated").then(
    (m) => (_importers = m.ICON_IMPORTERS),
  );
  return _importersPromise;
}
function notify(name: string) {
  _subs.get(name)?.forEach((cb) => cb());
}
function setState(name: string, s: GlyphLoadState) {
  _state.set(name, s);
  notify(name);
}

/** Synchronous resolve: featured map first, then the per-glyph cache. Never triggers a load. */
export function resolvePhosphorIcon(name: string): Icon | null {
  return (FEATURED_ICONS[name] as Icon | undefined) ?? _resolved.get(name) ?? null;
}

/** All Phosphor kebab names (sorted). Eager static index — instant, no network. */
export function enumeratePhosphorGlyphNames(): readonly string[] {
  return PHOSPHOR_ICON_NAMES;
}

export function glyphLoadState(name: string): GlyphLoadState {
  if (FEATURED_ICONS[name] || _resolved.has(name)) return "ready";
  return _state.get(name) ?? "idle";
}
export function getGlyphError(name: string): string | null {
  return _error.get(name) ?? null;
}

/** Per-glyph lazy load: caches resolved + in-flight; .catch; injectable timeout; retryable failures. */
export async function loadGlyph(name: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Icon | null> {
  const cached = resolvePhosphorIcon(name);
  if (cached) return cached;
  const existing = _inflight.get(name);
  if (existing) return existing;
  _error.delete(name); // retryable: never keep a sticky rejected promise
  setState(name, "loading");

  const p = (async (): Promise<Icon | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const imp = (await getImporters())[name];
      if (!imp) {
        setState(name, "missing");
        return null;
      }
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`phosphor glyph load timed out: ${name}`)),
          timeoutMs,
        );
      });
      // Attach a no-op .catch so that if the timeout wins the race, a later
      // rejection of the still-running import() cannot surface as an
      // unhandledrejection (the result is discarded either way).
      const importPromise = imp();
      importPromise.catch(() => {});
      const mod = await Promise.race([importPromise, timeout]);
      const pascal = kebabToPascal(name);
      const C = (mod[`${pascal}Icon`] ?? mod[pascal]) as Icon | undefined;
      if (!C) throw new Error(`phosphor glyph export missing: ${name}`);
      _resolved.set(name, C);
      setState(name, "ready");
      return C;
    } catch (err) {
      _error.set(name, err instanceof Error ? err.message : String(err));
      setState(name, "error");
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      _inflight.delete(name);
    }
  })();
  _inflight.set(name, p);
  return p;
}

/** React subscription: re-render a component when a specific glyph's load state changes. */
export function useGlyphLoad(name: string): GlyphLoadState {
  return useSyncExternalStore(
    (cb) => {
      let set = _subs.get(name);
      if (!set) {
        set = new Set();
        _subs.set(name, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        // Prune the now-empty Set so _subs doesn't accumulate one empty entry
        // per distinct glyph name ever viewed.
        if (set.size === 0) _subs.delete(name);
      };
    },
    () => glyphLoadState(name), // snapshot is a STRING (stable) — do not return a fresh object
    () => glyphLoadState(name),
  );
}

// --- test hooks (bun shares module state across files) ---
export function __setGlyphImporters(map: ImporterMap | null): void {
  _importers = map;
  _importersPromise = null;
}
export function __resetGlyphCaches(): void {
  _resolved.clear();
  _inflight.clear();
  _state.clear();
  _error.clear();
  _subs.clear();
  _importers = null;
  _importersPromise = null;
}
