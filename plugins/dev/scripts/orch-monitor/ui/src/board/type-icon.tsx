// type-icon.tsx — the ONE shared ticket-type → { icon, color, label } definition
// (CTL-1022). The board card's corner type pill and any future surface that wants
// to render a ticket's type as a symbol resolve it here. Color comes from the
// canonical board-tokens.ts `TYPE` map (the single palette source — never re-typed
// here); this module only adds the lucide icon + the human label for each type.
//
// Linear-calm: callers render the icon in its type color over a quiet, muted pill
// background — never a saturated badge. Unknown/absent types fail soft to a neutral
// dot (icon: null) so a stray triage value can never produce a broken card.
import type { ComponentType } from "react";
import { Bug, Sparkles, Wrench, Recycle, BookOpen, FlaskConical } from "lucide-react";
import { TYPE } from "./board-tokens";

type LucideIcon = ComponentType<{ size?: number | string; color?: string; strokeWidth?: number | string }>;

export interface TypeSymbol {
  /** lucide icon for the type, or null for the unknown fallback (render a neutral dot). */
  icon: LucideIcon | null;
  /** the type accent color from board-tokens.ts TYPE (muted grey for the fallback). */
  color: string;
  /** human label for the hover tooltip ("Feature", "Bug", …). */
  label: string;
}

// The canonical per-type symbol set. Icons chosen to be tasteful + distinct at a
// glance: a bug, a spark (new capability), a wrench (chore), the recycle loop
// (refactor), an open book (docs), a lab flask (test). Colors are pulled from the
// shared TYPE palette so card accent + pill icon always agree.
const SYMBOLS: Record<string, { icon: LucideIcon; label: string }> = {
  feature: { icon: Sparkles, label: "Feature" },
  bug: { icon: Bug, label: "Bug" },
  refactor: { icon: Recycle, label: "Refactor" },
  chore: { icon: Wrench, label: "Chore" },
  docs: { icon: BookOpen, label: "Docs" },
  test: { icon: FlaskConical, label: "Test" },
};

/** Neutral fallback color for an unrecognized type (matches accentFor's C.fgMuted). */
const FALLBACK_COLOR = "#9ba6b5"; // C.fgMuted

/**
 * Resolve a ticket type to its symbol, color, and label. Case-insensitive on the
 * known keys; any unknown/empty value resolves to the neutral fallback (icon: null)
 * so callers render a quiet dot rather than a broken/missing state.
 */
export function typeSymbol(type: string | null | undefined): TypeSymbol {
  const key = (type ?? "").toLowerCase();
  const entry = SYMBOLS[key];
  if (!entry) {
    return { icon: null, color: FALLBACK_COLOR, label: type ? String(type) : "Unknown" };
  }
  return { icon: entry.icon, color: TYPE[key] ?? FALLBACK_COLOR, label: entry.label };
}

/** The set of known type keys (feature/bug/refactor/chore/docs/test). */
export const KNOWN_TYPES = Object.keys(SYMBOLS);
