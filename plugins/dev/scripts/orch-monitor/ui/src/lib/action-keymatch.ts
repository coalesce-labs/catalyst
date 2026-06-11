import type { ActionEntry, ActionContext } from "./action-registry";
import { visibleActions } from "./action-registry";

export interface ParsedBinding { chord: string | null; key: string }

/** Parse a `keybinding` string: "g b" → chord "g" + key "b"; "c" → bare key "c". */
export function parseKeybinding(binding: string): ParsedBinding {
  const parts = binding.trim().split(/\s+/);
  return parts.length === 2
    ? { chord: parts[0], key: parts[1] }
    : { chord: null, key: parts[0] };
}

interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

/**
 * Resolve a keystroke to the ActionEntry it should fire, or null.
 *  - modifier keys (meta/ctrl/alt) never match a no-modifier binding.
 *  - when `chordPending`, only two-key (`g x`) bindings whose key matches fire.
 *  - otherwise only bare single-key bindings fire.
 * Scope is honored via visibleActions; first match in registry order wins.
 */
export function matchAction(
  entries: ActionEntry[],
  ctx: ActionContext,
  e: KeyLike,
  chordPending: boolean,
): ActionEntry | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  for (const entry of visibleActions(entries, ctx)) {
    if (!entry.keybinding) continue;
    const { chord, key } = parseKeybinding(entry.keybinding);
    if (key !== e.key) continue;
    if (chordPending ? chord === "g" : chord === null) return entry;
  }
  return null;
}
