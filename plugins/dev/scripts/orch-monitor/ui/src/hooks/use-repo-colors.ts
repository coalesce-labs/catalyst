import { useEffect, useState } from "react";

interface RepoColor {
  bg: string;
  text: string;
}

const NAMED_COLORS: Record<string, RepoColor> = {
  blue: { bg: "#1f3a5a", text: "#9ec7f4" },
  green: { bg: "#2a3c1f", text: "#b5d67a" },
  purple: { bg: "#3a2a5a", text: "#c8a8f4" },
  amber: { bg: "#4a3a1f", text: "#f4c88a" },
  red: { bg: "#5a2a2a", text: "#f4a8a8" },
  teal: { bg: "#1a4a3a", text: "#8af4cc" },
  cyan: { bg: "#1a4a4a", text: "#8ae6f4" },
  lime: { bg: "#3a4a1a", text: "#c8f48a" },
};

export function useRepoColors(): Record<string, RepoColor> {
  const [repoColors, setRepoColors] = useState<Record<string, RepoColor>>({});

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { repoColors?: Record<string, string> }) => {
        if (!data.repoColors || typeof data.repoColors !== "object") return;
        const resolved: Record<string, RepoColor> = {};
        for (const [repo, colorName] of Object.entries(data.repoColors)) {
          const color = NAMED_COLORS[colorName];
          if (color) resolved[repo] = color;
        }
        setRepoColors(resolved);
      })
      .catch(() => {});
  }, []);

  return repoColors;
}
