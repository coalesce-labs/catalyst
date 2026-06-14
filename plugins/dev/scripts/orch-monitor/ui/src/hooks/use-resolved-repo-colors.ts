import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { NAMED_COLORS, type RepoColor } from "@/lib/color-palette";
import { useRepoColorNames } from "./use-repo-colors";
import { repoColorPicksAtom, resolveEffectiveColor } from "@/lib/repo-color-picks-store";

/** repoKey → resolved {bg,text}, local picks layered over server defaults. */
export function useResolvedRepoColors(): Record<string, RepoColor> {
  const serverNames = useRepoColorNames();
  const picks = useAtomValue(repoColorPicksAtom);
  return useMemo(() => {
    const out: Record<string, RepoColor> = {};
    const keys = new Set([...Object.keys(serverNames), ...Object.keys(picks)]);
    for (const key of keys) {
      const name = resolveEffectiveColor(serverNames[key], picks[key]);
      if (name) out[key] = NAMED_COLORS[name];
    }
    return out;
  }, [serverNames, picks]);
}
