// use-repo-icons.ts — React hook for per-project icon resolution (CTL-961).
//
// Fetches auto-detected favicons from /api/repo-icon/:repoKey and reads
// manual overrides from localStorage. The result is the best available icon
// for each repo key in the repos list.
import { useEffect, useState } from "react";
import { parseIconResponse, readIconOverride, type ResolvedRepoIcon } from "@/lib/repo-icons";
import type { RepoIconApiResponse } from "@/lib/repo-icons";

/** Map of repo short-name → resolved icon data. */
export type RepoIconMap = Record<string, ResolvedRepoIcon>;

/**
 * Fetch and resolve per-repo icons for the given repos.
 * Returns the icon map, which updates as fetches complete.
 * Fail-open: a fetch failure yields { autoDataUrl: null, override: null }.
 */
export function useRepoIcons(repos: readonly string[]): RepoIconMap {
  const [icons, setIcons] = useState<RepoIconMap>({});

  useEffect(() => {
    if (repos.length === 0) return;
    let alive = true;

    async function fetchAll() {
      const entries = await Promise.all(
        repos.map(async (repo) => {
          let autoDataUrl: string | null = null;
          try {
            const r = await fetch(`/api/repo-icon/${encodeURIComponent(repo)}`);
            if (r.ok) {
              const data = (await r.json()) as RepoIconApiResponse;
              autoDataUrl = parseIconResponse(data);
            }
          } catch {
            // network error → fall through to null
          }
          const override = readIconOverride(repo);
          return [repo, { autoDataUrl, override }] as [string, ResolvedRepoIcon];
        }),
      );
      if (!alive) return;
      setIcons(Object.fromEntries(entries));
    }

    void fetchAll();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.join(",")]);

  return icons;
}
