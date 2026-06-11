import type { Surface } from "./surface";

export type ActionScope = "global" | "board";

export interface ActionEntry {
  id: string;
  title: string;
  keywords?: string[];
  scope: ActionScope;
  handler: () => void;
  keybinding?: string;
}

export interface ActionContext {
  surface: Surface;
}

/** Filter a registry to entries visible in the given context, preserving order. */
export function visibleActions(entries: ActionEntry[], ctx: ActionContext): ActionEntry[] {
  return entries.filter((e) => e.scope === "global" || ctx.surface === "board");
}
