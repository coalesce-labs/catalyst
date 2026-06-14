import { useEffect, useState } from "react";
import { NAMED_COLORS, type RepoColor } from "@/lib/color-palette";

export type { RepoColor };
export { NAMED_COLORS };

/** Raw server map: repoKey → hue name (not yet resolved to {bg,text}). */
export function useRepoColorNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { repoColors?: Record<string, string> }) => {
        if (!data.repoColors || typeof data.repoColors !== "object") return;
        setNames(data.repoColors);
      })
      .catch(() => {});
  }, []);

  return names;
}

export function useRepoColors(): Record<string, RepoColor> {
  const names = useRepoColorNames();
  const [repoColors, setRepoColors] = useState<Record<string, RepoColor>>({});

  useEffect(() => {
    const resolved: Record<string, RepoColor> = {};
    for (const [repo, colorName] of Object.entries(names)) {
      const color = NAMED_COLORS[colorName];
      if (color) resolved[repo] = color;
    }
    setRepoColors(resolved);
  }, [names]);

  return repoColors;
}
